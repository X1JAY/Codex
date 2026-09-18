import { authorizedTabStore } from "../actionAuthorization";
import {
  AUDIO_CAPTURE_GET_STATUS,
  AUDIO_CAPTURE_OFFSCREEN_EVENT,
  AUDIO_CAPTURE_OFFSCREEN_CANCEL,
  AUDIO_CAPTURE_OFFSCREEN_GET_STATUS,
  AUDIO_CAPTURE_OFFSCREEN_START,
  AUDIO_CAPTURE_OFFSCREEN_STOP,
  AUDIO_CAPTURE_START,
  AUDIO_CAPTURE_STATUS,
  AUDIO_CAPTURE_STOP,
  type AudioCaptureError,
  type AudioCaptureErrorCode,
  type AudioCaptureGetStatusMessage,
  type AudioCaptureOffscreenMessage,
  type AudioCapturePanelMessage,
  type AudioCaptureResponse,
  type AudioCaptureStartMessage,
  type AudioCaptureStage,
  type AudioCaptureStatus,
  type OffscreenEventMessage
} from "./types";
import { AudioCaptureException, normalizeAudioCaptureError, publicAudioCaptureError } from "./errors";
import { resolveAuthorizedCaptureTab } from "./authorizedTabResolver";
import { isAudioCaptureActive, transitionAudioCaptureState } from "./state";

const MAX_DURATION_MS = 15_000;
const SESSION_STORAGE_KEY = "audioCaptureStatus";

interface StoredCaptureState {
  [SESSION_STORAGE_KEY]?: AudioCaptureStatus;
}

interface RuntimeMessageOptions {
  code: AudioCaptureErrorCode | string;
  message: string;
  stage: AudioCaptureStage;
}

function sessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `audio-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function resolveCaptureSessionId(
  requestedSessionId?: string,
  create: () => string = sessionId,
): string {
  return requestedSessionId || create();
}

export function audioCaptureStatusMatchesIdentity(
  status: AudioCaptureStatus,
  identity: Pick<AudioCaptureGetStatusMessage, "sessionId" | "tabId">,
): boolean {
  if (identity.sessionId && status.sessionId !== identity.sessionId) return false;
  if (identity.tabId !== undefined && status.tabId !== identity.tabId) return false;
  return true;
}

function log(event: string, details?: Record<string, unknown>): void {
  console.debug(`[audio-capture] ${event}`, details ?? "");
}

function logLine(message: string): void {
  console.debug(`[audio-capture] ${message}`);
}

function logFailure(event: string, stage: AudioCaptureStage, rawMessage: string): void {
  console.error(`[audio-capture] ${event}`);
  console.error(`stage=${stage}`);
  console.error(`rawError=${rawMessage}`);
}

function sendRuntimeMessage<TResponse>(
  message: unknown,
  options: RuntimeMessageOptions
): Promise<TResponse | undefined> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: TResponse | undefined) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        const rawMessage = runtimeError.message;
        log("runtime message failed", { stage: options.stage, rawError: rawMessage });
        reject(new AudioCaptureException(
          options.code,
          options.message,
          { name: "ChromeRuntimeError", message: rawMessage },
          options.stage,
          rawMessage
        ));
        return;
      }
      resolve(response);
    });
  });
}

function baseStatus(): AudioCaptureStatus {
  return { state: "idle", elapsedMs: 0 };
}

export class AudioCaptureController {
  private status: AudioCaptureStatus = baseStatus();

  register(): void {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      const type = message && typeof message === "object"
        ? (message as { type?: unknown }).type
        : undefined;
      if (this.isOffscreenEvent(message)) {
        log("background message received", { type });
        this.handleOffscreenEvent(message);
        return false;
      }
      if (!this.isPanelMessage(message)) return false;
      log("background message received", { type });
      logLine(`sender=${sender.tab?.id === undefined ? "extension-page" : `tab:${sender.tab.id}`}`);
      void this.handlePanelMessage(message).then(sendResponse).catch((error: unknown) => {
        const normalized = normalizeAudioCaptureError(
          error,
          "TAB_CAPTURE_FAILED",
          "无法启动当前标签页音频捕获。",
          "offscreenMessage"
        );
        sendResponse({
          ok: false,
          error: publicAudioCaptureError(normalized)
        } satisfies AudioCaptureResponse);
      });
      return true;
    });
  }

  private isPanelMessage(message: unknown): message is AudioCapturePanelMessage {
    if (!message || typeof message !== "object") return false;
    const type = (message as { type?: unknown }).type;
    return type === AUDIO_CAPTURE_START || type === AUDIO_CAPTURE_STOP || type === AUDIO_CAPTURE_GET_STATUS;
  }

  private isOffscreenEvent(message: unknown): message is OffscreenEventMessage {
    if (!message || typeof message !== "object") return false;
    const value = message as { target?: unknown; type?: unknown };
    return value.target === "background" && value.type === AUDIO_CAPTURE_OFFSCREEN_EVENT;
  }

  private async handlePanelMessage(message: AudioCapturePanelMessage): Promise<AudioCaptureResponse> {
    switch (message.type) {
      case AUDIO_CAPTURE_START:
        return this.startCapture(message);
      case AUDIO_CAPTURE_STOP:
        return this.stop();
      case AUDIO_CAPTURE_GET_STATUS:
        return this.getStatus(message);
      default:
        return {
          ok: false,
          error: {
            code: "UNKNOWN",
            stage: "offscreenMessage",
            message: "未知的音频捕获命令。"
          }
        };
    }
  }

  public async startCapture(message: AudioCaptureStartMessage): Promise<AudioCaptureResponse> {
    if (isAudioCaptureActive(this.status.state)) {
      return {
        ok: false,
        error: {
          code: "ALREADY_RECORDING",
          stage: "mediaRecorder",
          message: "已经有一个音频捕获任务正在进行。"
        }
      };
    }
    const resolvedTab = await resolveAuthorizedCaptureTab(
      authorizedTabStore,
      (tabId) => chrome.tabs.get(tabId),
    );
    if (!resolvedTab.ok) {
      return this.fail(
        resolvedTab.code,
        resolvedTab.message,
        resolvedTab.cause,
        "resolveActiveTab"
      );
    }
    const authorizedTabId = resolvedTab.authorization.tabId;
    logLine(`using authorized tab id=${authorizedTabId}`);
    if (!chrome.tabCapture?.getMediaStreamId) {
      return this.fail(
        "TAB_CAPTURE_UNAVAILABLE",
        "当前 Chrome 不提供 chrome.tabCapture.getMediaStreamId。",
        undefined,
        "getMediaStreamId"
      );
    }
    if (!chrome.offscreen?.createDocument) {
      return this.fail(
        "OFFSCREEN_UNAVAILABLE",
        "当前 Chrome 不提供 Offscreen Document。",
        undefined,
        "createOffscreen"
      );
    }

    const captureSessionId = resolveCaptureSessionId(message.sessionId);
    const purpose = message.purpose ?? "capture-test";
    this.status = {
      state: transitionAudioCaptureState(this.status.state, "REQUEST_START"),
      elapsedMs: 0,
      tabId: authorizedTabId,
      sessionId: captureSessionId,
      purpose,
    };
    await this.persistAndBroadcast();

    try {
      await this.ensureOffscreenDocument();
      logLine("requesting media stream id");
      logLine("calling getMediaStreamId");
      const streamId = await this.getMediaStreamId(authorizedTabId);
      const response = await sendRuntimeMessage<AudioCaptureResponse>({
        target: "offscreen",
        type: AUDIO_CAPTURE_OFFSCREEN_START,
        sessionId: captureSessionId,
        streamId,
        tabId: authorizedTabId,
        maxDurationMs: message.maxDurationMs ?? MAX_DURATION_MS,
        purpose,
      } satisfies AudioCaptureOffscreenMessage, {
        code: "TAB_CAPTURE_FAILED",
        message: "无法向 Offscreen Document 发送捕获请求。",
        stage: "offscreenMessage"
      });
      if (!response?.ok) {
        return this.fail(
          response?.error?.code ?? "TAB_CAPTURE_FAILED",
          response?.error?.message ?? "Offscreen Document 未能启动录音。",
          response?.error
        );
      }
      if (response.status) {
        this.status = response.status;
        await this.persistAndBroadcast();
      }
      return { ok: true, status: this.status };
    } catch (error) {
      return this.fail(
        "TAB_CAPTURE_FAILED",
        "无法启动当前标签页音频捕获。",
        error,
        "offscreenMessage"
      );
    }
  }

  public async stop(): Promise<AudioCaptureResponse> {
    if (!isAudioCaptureActive(this.status.state)) {
      return {
        ok: false,
        error: {
          code: "STOP_FAILED",
          stage: "mediaRecorder",
          message: "当前没有正在进行的音频捕获任务。"
        }
      };
    }
    this.status = {
      ...this.status,
      state: transitionAudioCaptureState(this.status.state, "REQUEST_STOP")
    };
    await this.persistAndBroadcast();
    try {
      const response = await sendRuntimeMessage<AudioCaptureResponse>({
        target: "offscreen",
        type: AUDIO_CAPTURE_OFFSCREEN_STOP
      } satisfies AudioCaptureOffscreenMessage, {
        code: "STOP_FAILED",
        message: "无法向 Offscreen Document 发送停止请求。",
        stage: "offscreenMessage"
      });
      if (!response?.ok) {
        return this.fail(
          response?.error?.code ?? "STOP_FAILED",
          response?.error?.message ?? "无法停止录音。",
          response?.error
        );
      }
      return { ok: true, status: response.status ?? this.status };
    } catch (error) {
      return this.fail(
        "STOP_FAILED",
        "无法连接到录音文档，录音可能已经中断。",
        error,
        "offscreenMessage"
      );
    }
  }

  public async cancelCapture(): Promise<AudioCaptureResponse> {
    if (!isAudioCaptureActive(this.status.state)) {
      return { ok: true, status: this.status };
    }
    try {
      const response = await sendRuntimeMessage<AudioCaptureResponse>({
        target: "offscreen",
        type: AUDIO_CAPTURE_OFFSCREEN_CANCEL
      } satisfies AudioCaptureOffscreenMessage, {
        code: "STOP_FAILED",
        message: "无法向 Offscreen Document 发送取消请求。",
        stage: "offscreenMessage"
      });
      if (!response?.ok) {
        return this.fail(
          response?.error?.code ?? "STOP_FAILED",
          response?.error?.message ?? "无法取消录音。",
          response?.error
        );
      }
      if (response.status) {
        this.status = response.status;
        await this.persistAndBroadcast();
      }
      return { ok: true, status: this.status };
    } catch (error) {
      return this.fail(
        "STOP_FAILED",
        "无法取消当前录音。",
        error,
        "offscreenMessage"
      );
    }
  }

  private async getStatus(message: AudioCaptureGetStatusMessage): Promise<AudioCaptureResponse> {
    let resolvedStatus: AudioCaptureStatus | undefined;
    try {
      if (chrome.offscreen?.hasDocument && await chrome.offscreen.hasDocument()) {
        const response = await sendRuntimeMessage<AudioCaptureResponse>({
          target: "offscreen",
          type: AUDIO_CAPTURE_OFFSCREEN_GET_STATUS,
          sessionId: message.sessionId,
          tabId: message.tabId,
        } satisfies AudioCaptureOffscreenMessage, {
          code: "TAB_CAPTURE_FAILED",
          message: "无法读取 Offscreen Document 状态。",
          stage: "offscreenMessage"
        });
        if (response?.status &&
          response.status.state !== "idle" &&
          audioCaptureStatusMatchesIdentity(response.status, message)) {
          resolvedStatus = response.status;
        }
      }
    } catch {
      // Fall through to the session-only metadata snapshot.
    }

    if (!resolvedStatus && audioCaptureStatusMatchesIdentity(this.status, message)) {
      resolvedStatus = this.status;
    }
    if (!resolvedStatus || resolvedStatus.state === "idle") {
      const stored = await chrome.storage.session.get(SESSION_STORAGE_KEY) as StoredCaptureState;
      const storedStatus = stored[SESSION_STORAGE_KEY];
      if (storedStatus && audioCaptureStatusMatchesIdentity(storedStatus, message)) {
        resolvedStatus = storedStatus;
      }
    }

    const responseStatus = resolvedStatus ?? baseStatus();
    if (responseStatus.state !== "idle") {
      this.status = responseStatus;
      await this.persistStatus();
    }
    logLine(`get-status sessionId=${message.sessionId ?? responseStatus.sessionId ?? "none"}`);
    logLine(`get-status tabId=${message.tabId ?? responseStatus.tabId ?? "none"}`);
    logLine(`status=${responseStatus.state}`);
    logLine(`stage=${responseStatus.transcriptionState ?? responseStatus.error?.stage ?? responseStatus.state}`);
    logLine(`transcriptLength=${responseStatus.transcriptLength ?? 0}`);
    return { ok: true, status: responseStatus };
  }

  private async getMediaStreamId(tabId: number): Promise<string> {
    return new Promise((resolve, reject) => {
      logLine("getMediaStreamId start");
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          const rawMessage = runtimeError.message || "Chrome runtime.lastError 未提供 message。";
          logFailure("getMediaStreamId failed", "getMediaStreamId", rawMessage);
          reject(new AudioCaptureException(
            "TAB_CAPTURE_FAILED",
            "无法启动当前标签页音频捕获。",
            { name: "ChromeRuntimeError", message: rawMessage },
            "getMediaStreamId",
            rawMessage
          ));
          return;
        }
        if (!streamId) {
          const rawMessage = "Chrome 没有返回 tab capture stream ID。";
          logFailure("getMediaStreamId failed", "getMediaStreamId", rawMessage);
          reject(new AudioCaptureException(
            "TAB_CAPTURE_FAILED",
            "无法启动当前标签页音频捕获。",
            undefined,
            "getMediaStreamId",
            rawMessage
          ));
          return;
        }
        log("getMediaStreamId success", { tabId });
        resolve(streamId);
      });
    });
  }

  private async ensureOffscreenDocument(): Promise<void> {
    if (!chrome.offscreen?.hasDocument || !chrome.offscreen?.createDocument) {
      throw new AudioCaptureException(
        "OFFSCREEN_UNAVAILABLE",
        "当前 Chrome 不提供 Offscreen Document。",
        undefined,
        "createOffscreen"
      );
    }
    try {
      if (await chrome.offscreen.hasDocument()) return;
      logLine("createOffscreen start");
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.BLOBS],
        justification: "在内存中捕获当前标签页音频并验证 MediaRecorder 输出。"
      });
      logLine("createOffscreen success");
    } catch (error) {
      if (await chrome.offscreen.hasDocument()) return;
      const normalized = normalizeAudioCaptureError(
        error,
        "OFFSCREEN_CREATE_FAILED",
        "无法创建 Offscreen Document。",
        "createOffscreen"
      );
      log("createOffscreen failed", {
        stage: "createOffscreen",
        rawError: normalized.rawMessage ?? normalized.message
      });
      throw new AudioCaptureException(
        normalized.code,
        normalized.message,
        normalized.cause,
        normalized.stage ?? "createOffscreen",
        normalized.rawMessage
      );
    }
  }

  private handleOffscreenEvent(message: OffscreenEventMessage): void {
    if (this.status.sessionId && message.sessionId !== this.status.sessionId) {
      logLine(`ignored offscreen sessionId=${message.sessionId} expected=${this.status.sessionId}`);
      return;
    }
    this.status = message.status;
    void this.persistAndBroadcast();
  }

  private async fail(
    code: string,
    message: string,
    cause?: unknown,
    stage: AudioCaptureStage = "offscreenMessage"
  ): Promise<AudioCaptureResponse> {
    const normalized = publicAudioCaptureError(normalizeAudioCaptureError(cause, code, message, stage));
    log("capture failed", {
      code: normalized.code,
      stage: normalized.stage,
      rawError: normalized.rawMessage ?? "(none)"
    });
    this.status = {
      ...this.status,
      state: "error",
      elapsedMs: this.status.elapsedMs,
      error: normalized
    };
    await this.persistAndBroadcast();
    return { ok: false, status: this.status, error: normalized };
  }

  private async persistAndBroadcast(): Promise<void> {
    await this.persistStatus();
    try {
      await sendRuntimeMessage(
        { target: "sidepanel", type: AUDIO_CAPTURE_STATUS, status: this.status },
        {
          code: "TAB_CAPTURE_FAILED",
          message: "无法向 Side Panel 发送音频捕获状态。",
          stage: "offscreenMessage"
        }
      );
    } catch (error) {
      // The Side Panel may be closed; status is retained in chrome.storage.session.
      const normalized = normalizeAudioCaptureError(
        error,
        "TAB_CAPTURE_FAILED",
        "无法向 Side Panel 发送音频捕获状态。",
        "offscreenMessage"
      );
      log("sidepanel status message ignored", {
        stage: normalized.stage,
        rawError: normalized.rawMessage ?? normalized.message
      });
    }
  }

  private async persistStatus(): Promise<void> {
    await chrome.storage.session.set({ [SESSION_STORAGE_KEY]: this.status });
  }
}
