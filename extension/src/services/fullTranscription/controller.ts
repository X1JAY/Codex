import {
  authorizedTabStore,
  AuthorizedTabStore,
  type AuthorizationTab,
} from "../actionAuthorization";
import { AudioCaptureController } from "../audioCapture/controller";
import { resolveAuthorizedCaptureTab } from "../audioCapture/authorizedTabResolver";
import {
  AUDIO_CAPTURE_START,
  type AudioCaptureStartMessage,
} from "../audioCapture/types";
import {
  ContentScriptUnavailableError,
  ensureContentScript,
} from "../contentScript/bridge";
import type { TranscriptionError } from "../transcription/types";
import {
  calculateHardTimeoutMs,
  isFullTranscriptionActive,
  validateVideoDuration,
} from "./logic";
import {
  FULL_TRANSCRIPTION_CANCEL,
  FULL_TRANSCRIPTION_GET_STATUS,
  FULL_TRANSCRIPTION_OFFSCREEN_EVENT,
  FULL_TRANSCRIPTION_OFFSCREEN_GET_STATUS,
  FULL_TRANSCRIPTION_START,
  FULL_TRANSCRIPTION_STATUS,
  FULL_VIDEO_CONTENT_EVENT,
  FULL_VIDEO_HALT,
  FULL_VIDEO_PLAY,
  FULL_VIDEO_PREPARE,
  FULL_VIDEO_RESTORE,
  type FullTranscriptionError,
  type FullTranscriptionOffscreenEvent,
  type FullTranscriptionOffscreenGetStatusMessage,
  type FullTranscriptionOffscreenStatusResponse,
  type FullTranscriptionGetStatusMessage,
  type FullTranscriptionPanelMessage,
  type FullTranscriptionResponse,
  type FullTranscriptionStatus,
  type FullVideoContentEvent,
  type FullVideoContentMessage,
  type FullVideoContentResponse,
} from "./types";

const SESSION_STORAGE_KEY = "fullTranscriptionStatus";
const RECORDER_TIMEOUT_GRACE_MS = 5_000;

function createSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `full-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function baseStatus(): FullTranscriptionStatus {
  return { state: "idle", elapsedMs: 0, durationMs: 0 };
}

function rawError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resolvePhase4AuthorizedTab(
  store: AuthorizedTabStore = authorizedTabStore,
  getTab: (tabId: number) => Promise<AuthorizationTab> = (tabId) => chrome.tabs.get(tabId),
) {
  return resolveAuthorizedCaptureTab(store, getTab);
}

export function contentScriptUnavailableError(error: unknown): FullTranscriptionError {
  return {
    code: "CONTENT_SCRIPT_UNAVAILABLE",
    stage: "videoDiscovery",
    message: "无法与抖音页面中的视频控制脚本建立通信。",
    rawMessage: error instanceof ContentScriptUnavailableError
      ? error.rawMessage ?? error.message
      : rawError(error),
  };
}

function mapTranscriptionError(error: TranscriptionError): FullTranscriptionError {
  const code: FullTranscriptionError["code"] = error.code === "BACKEND_UNAVAILABLE"
    ? "BACKEND_UNAVAILABLE"
    : error.code === "INVALID_RESPONSE"
      ? "INVALID_RESPONSE"
      : error.code === "UPLOAD_FAILED"
        ? "UPLOAD_FAILED"
        : error.code === "AUDIO_CAPTURE_FAILED" || error.code === "AUDIO_EMPTY"
          ? "AUDIO_CAPTURE_FAILED"
          : "TRANSCRIPTION_FAILED";
  const stage: FullTranscriptionError["stage"] = error.stage === "backendHealth"
    ? "backendHealth"
    : error.stage === "upload"
      ? "upload"
      : error.stage === "response"
        ? "response"
        : error.stage === "audioCapture"
          ? "audioCapture"
          : "transcription";
  return { code, stage, message: error.message, rawMessage: error.rawMessage };
}

export function buildFullCaptureStartMessage(
  sessionId: string,
  durationSeconds: number,
): AudioCaptureStartMessage {
  return {
    type: AUDIO_CAPTURE_START,
    purpose: "full-transcription",
    sessionId,
    maxDurationMs: calculateHardTimeoutMs(durationSeconds) + RECORDER_TIMEOUT_GRACE_MS,
  };
}

export function fullStatusMatchesIdentity(
  status: FullTranscriptionStatus,
  identity: Pick<FullTranscriptionGetStatusMessage, "sessionId" | "tabId">,
): boolean {
  if (identity.sessionId && status.sessionId !== identity.sessionId) return false;
  if (identity.tabId !== undefined && status.tabId !== identity.tabId) return false;
  return true;
}

export function reduceFullTranscriptionOffscreenEvent(
  current: FullTranscriptionStatus,
  message: FullTranscriptionOffscreenEvent,
): FullTranscriptionStatus {
  if (!current.sessionId || message.sessionId !== current.sessionId) return current;
  const offscreenStatus = message.status;
  if (offscreenStatus.state === "capturing" || offscreenStatus.state === "idle") return current;
  if (offscreenStatus.state === "uploading" || offscreenStatus.state === "transcribing") {
    return {
      ...current,
      state: offscreenStatus.state,
      captureResult: offscreenStatus.captureResult ?? current.captureResult,
    };
  }
  if (offscreenStatus.state === "error" && offscreenStatus.error) {
    return {
      ...current,
      state: "error",
      captureResult: offscreenStatus.captureResult,
      error: mapTranscriptionError(offscreenStatus.error),
    };
  }
  if (offscreenStatus.state !== "completed" || !offscreenStatus.result || !offscreenStatus.captureResult) {
    return current;
  }
  if (!current.metadata) {
    return {
      ...current,
      state: "error",
      error: {
        code: "INVALID_RESPONSE",
        stage: "response",
        message: "完整转写结果缺少视频元数据。",
      },
    };
  }
  return {
    ...current,
    state: "completed",
    captureResult: offscreenStatus.captureResult,
    elapsedMs: current.durationMs,
    progress: 1,
    result: {
      metadata: current.metadata,
      transcript: {
        ...offscreenStatus.result,
        source: "speech_to_text",
        model: "small",
      },
      capture: offscreenStatus.captureResult,
    },
    error: undefined,
  };
}

export function shouldAbortForRemovedTab(
  status: FullTranscriptionStatus,
  removedTabId: number,
): boolean {
  return status.tabId === removedTabId && isFullTranscriptionActive(status.state);
}

function sendContentMessage(
  tabId: number,
  message: FullVideoContentMessage,
): Promise<FullVideoContentResponse> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response: FullVideoContentResponse | undefined) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (!response) {
        reject(new Error("Content script did not return a full-video response."));
        return;
      }
      resolve(response);
    });
  });
}

function getOffscreenTranscriptionStatus(
  message: FullTranscriptionOffscreenGetStatusMessage,
): Promise<FullTranscriptionOffscreenStatusResponse | undefined> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: FullTranscriptionOffscreenStatusResponse | undefined) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(response);
    });
  });
}

export class FullTranscriptionController {
  private status: FullTranscriptionStatus = baseStatus();
  private lifecycleBusy = false;
  private cancelRequested = false;

  public constructor(private readonly audioCaptureController: AudioCaptureController) {}

  public register(): void {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (this.isContentEvent(message)) {
        void this.handleContentEvent(message);
        return false;
      }
      if (this.isOffscreenEvent(message)) {
        void this.handleOffscreenEvent(message)
          .then(() => sendResponse({ ok: true }))
          .catch((error: unknown) => {
            console.error(`[full-transcription] result persistence failed message=${rawError(error)}`);
            sendResponse({ ok: false });
          });
        return true;
      }
      if (!this.isPanelMessage(message)) return false;
      void this.handlePanelMessage(message)
        .then(sendResponse)
        .catch((error: unknown) => {
          const details: FullTranscriptionError = {
            code: "TRANSCRIPTION_FAILED",
            stage: "response",
            message: "无法启动完整视频转写。",
            rawMessage: rawError(error),
          };
          sendResponse({ ok: false, error: details } satisfies FullTranscriptionResponse);
        });
      return true;
    });

    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (tabId !== this.status.tabId || !isFullTranscriptionActive(this.status.state)) return;
      if (changeInfo.status === "loading" || typeof changeInfo.url === "string") {
        void this.abortWithError({
          code: "VIDEO_CHANGED_DURING_CAPTURE",
          stage: "monitor",
          message: "录制期间抖音标签页发生了导航。",
        });
      }
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      if (!shouldAbortForRemovedTab(this.status, tabId)) return;
      void this.abortWithError({
        code: "VIDEO_CHANGED_DURING_CAPTURE",
        stage: "monitor",
        message: "录制期间目标标签页已关闭。",
      });
    });
  }

  private isPanelMessage(message: unknown): message is FullTranscriptionPanelMessage {
    if (!message || typeof message !== "object") return false;
    const type = (message as { type?: unknown }).type;
    return type === FULL_TRANSCRIPTION_START ||
      type === FULL_TRANSCRIPTION_CANCEL ||
      type === FULL_TRANSCRIPTION_GET_STATUS;
  }

  private isContentEvent(message: unknown): message is FullVideoContentEvent {
    if (!message || typeof message !== "object") return false;
    const value = message as { target?: unknown; type?: unknown };
    return value.target === "background" && value.type === FULL_VIDEO_CONTENT_EVENT;
  }

  private isOffscreenEvent(message: unknown): message is FullTranscriptionOffscreenEvent {
    if (!message || typeof message !== "object") return false;
    const value = message as { target?: unknown; type?: unknown };
    return value.target === "background" && value.type === FULL_TRANSCRIPTION_OFFSCREEN_EVENT;
  }

  private async handlePanelMessage(
    message: FullTranscriptionPanelMessage,
  ): Promise<FullTranscriptionResponse> {
    if (message.type === FULL_TRANSCRIPTION_GET_STATUS) return this.getStatus(message);
    if (message.type === FULL_TRANSCRIPTION_CANCEL) return this.cancel();
    return this.start();
  }

  private async start(): Promise<FullTranscriptionResponse> {
    if (isFullTranscriptionActive(this.status.state)) {
      const error: FullTranscriptionError = {
        code: "AUDIO_CAPTURE_FAILED",
        stage: "audioCapture",
        message: "当前已有完整视频转写任务正在运行。",
      };
      return { ok: false, status: this.status, error };
    }

    this.lifecycleBusy = false;
    this.cancelRequested = false;
    const sessionId = createSessionId();
    this.status = {
      state: "readingVideo",
      sessionId,
      elapsedMs: 0,
      durationMs: 0,
    };
    await this.persistAndBroadcast();

    const resolvedTab = await resolvePhase4AuthorizedTab();
    if (!resolvedTab.ok) {
      return this.fail(contentScriptUnavailableError(
        resolvedTab.cause ?? new Error(`${resolvedTab.code}: ${resolvedTab.message}`),
      ));
    }

    const tabId = resolvedTab.authorization.tabId;
    console.debug(`[phase4a] lastInvokedTabId=${tabId}`);
    if (this.cancelRequested) return { ok: false, status: this.status, error: this.status.error };
    this.status = { ...this.status, tabId };
    await this.persistAndBroadcast();

    try {
      const ready = await ensureContentScript(tabId);
      console.debug(`[phase4a] contentScriptPong=${ready.pong.href}`);
    } catch (error) {
      return this.fail(contentScriptUnavailableError(error));
    }
    this.status = { ...this.status, state: "preparing" };
    await this.persistAndBroadcast();

    let preparedResponse: FullVideoContentResponse;
    try {
      preparedResponse = await sendContentMessage(tabId, {
        target: "content",
        type: FULL_VIDEO_PREPARE,
        sessionId,
      });
    } catch (error) {
      return this.fail(contentScriptUnavailableError(error));
    }
    if (!preparedResponse.ok || !preparedResponse.prepared) {
      return this.fail(preparedResponse.error ?? {
        code: "VIDEO_NOT_FOUND",
        stage: "videoDiscovery",
        message: "没有取得当前视频信息。",
      });
    }

    if (this.cancelRequested) {
      await this.restorePlayback(tabId, sessionId);
      return { ok: false, status: this.status, error: this.status.error };
    }

    const prepared = preparedResponse.prepared;
    const durationError = validateVideoDuration(prepared.playbackState.duration);
    if (durationError) {
      await this.restorePlayback(tabId, sessionId);
      return this.fail(durationError);
    }
    this.status = {
      ...this.status,
      metadata: prepared.metadata,
      playbackState: prepared.playbackState,
      startOffsetSeconds: prepared.startOffsetSeconds,
      durationMs: Math.round(prepared.playbackState.duration * 1000),
      warning: preparedResponse.warning,
    };
    await this.persistAndBroadcast();

    const captureResponse = await this.audioCaptureController.startCapture(
      buildFullCaptureStartMessage(sessionId, prepared.playbackState.duration),
    );
    if (!captureResponse.ok) {
      await this.restorePlayback(tabId, sessionId);
      return this.fail({
        code: "AUDIO_CAPTURE_FAILED",
        stage: "audioCapture",
        message: captureResponse.error?.message ?? "无法启动完整视频音频捕获。",
        rawMessage: captureResponse.error?.rawMessage ?? captureResponse.error?.code,
      });
    }
    if (this.cancelRequested) {
      await this.audioCaptureController.cancelCapture();
      await this.restorePlayback(tabId, sessionId);
      return { ok: false, status: this.status, error: this.status.error };
    }

    this.status = { ...this.status, state: "capturing", elapsedMs: 0, progress: 0 };
    await this.persistAndBroadcast();
    try {
      const playResponse = await sendContentMessage(tabId, {
        target: "content",
        type: FULL_VIDEO_PLAY,
        sessionId,
      });
      if (!playResponse.ok) {
        await this.abortWithError(playResponse.error ?? {
          code: "VIDEO_PLAY_FAILED",
          stage: "playback",
          message: "无法从开头播放当前视频。",
        });
        return { ok: false, status: this.status, error: this.status.error };
      }
    } catch (error) {
      await this.abortWithError({
        code: "VIDEO_PLAY_FAILED",
        stage: "playback",
        message: "无法命令当前视频开始播放。",
        rawMessage: rawError(error),
      });
      return { ok: false, status: this.status, error: this.status.error };
    }

    return { ok: true, status: this.status };
  }

  private async handleContentEvent(message: FullVideoContentEvent): Promise<void> {
    if (message.sessionId !== this.status.sessionId) return;
    if (message.event === "progress") {
      if (this.status.state !== "capturing") return;
      this.status = {
        ...this.status,
        elapsedMs: message.elapsedMs,
        durationMs: message.durationMs,
        progress: message.progress,
      };
      await this.persistAndBroadcast();
      return;
    }
    if (message.event === "error") {
      await this.abortWithError(message.error);
      return;
    }
    await this.completeCapture(message.elapsedMs, message.durationMs);
  }

  private async completeCapture(elapsedMs: number, durationMs: number): Promise<void> {
    if (this.lifecycleBusy || this.status.state !== "capturing") return;
    this.lifecycleBusy = true;
    this.status = {
      ...this.status,
      state: "processing",
      elapsedMs: Math.min(Math.max(elapsedMs, this.status.elapsedMs), durationMs),
      durationMs,
      progress: 1,
    };
    await this.persistAndBroadcast();

    const response = await this.audioCaptureController.stop();
    if (!response.ok) {
      this.lifecycleBusy = false;
      await this.abortWithError({
        code: "AUDIO_CAPTURE_FAILED",
        stage: "audioCapture",
        message: response.error?.message ?? "无法结束完整视频录音。",
        rawMessage: response.error?.rawMessage ?? response.error?.code,
      });
      return;
    }
    await this.restoreCurrentPlayback();
    this.lifecycleBusy = false;
  }

  private async handleOffscreenEvent(message: FullTranscriptionOffscreenEvent): Promise<void> {
    if (!this.status.sessionId || message.sessionId !== this.status.sessionId) {
      console.debug(
        `[full-transcription] ignored sessionId=${message.sessionId} expected=${this.status.sessionId ?? "none"}`,
      );
      return;
    }
    const previous = this.status;
    const next = reduceFullTranscriptionOffscreenEvent(previous, message);
    if (next === previous) return;
    this.status = next;
    if (next.state === "error") await this.restoreCurrentPlayback();
    console.debug(`[full-transcription] sessionId=${message.sessionId}`);
    console.debug(`[full-transcription] tabId=${this.status.tabId ?? "none"}`);
    console.debug(`[full-transcription] state=${this.status.state}`);
    console.debug(`[full-transcription] transcriptLength=${this.status.result?.transcript.text.length ?? 0}`);
    await this.persistAndBroadcast();
  }

  private async cancel(): Promise<FullTranscriptionResponse> {
    if (!isFullTranscriptionActive(this.status.state)) {
      return { ok: true, status: this.status };
    }
    if (this.status.state === "processing" || this.status.state === "uploading" || this.status.state === "transcribing") {
      const error: FullTranscriptionError = {
        code: "FULL_CAPTURE_CANCELLED",
        stage: "transcription",
        message: "音频捕获已经结束，当前本地识别不可取消。",
      };
      return { ok: false, status: this.status, error };
    }
    this.cancelRequested = true;
    this.lifecycleBusy = true;
    this.status = { ...this.status, state: "cancelling" };
    await this.persistAndBroadcast();
    await this.haltCurrentPlayback();
    await this.audioCaptureController.cancelCapture();
    await this.restoreCurrentPlayback();
    this.status = {
      ...this.status,
      state: "cancelled",
      progress: undefined,
      error: {
        code: "FULL_CAPTURE_CANCELLED",
        stage: "playback",
        message: "完整视频转写已取消，未上传不完整音频。",
      },
    };
    this.lifecycleBusy = false;
    await this.persistAndBroadcast();
    return { ok: true, status: this.status };
  }

  private async abortWithError(error: FullTranscriptionError): Promise<void> {
    if (this.lifecycleBusy) return;
    this.lifecycleBusy = true;
    await this.haltCurrentPlayback();
    await this.audioCaptureController.cancelCapture();
    await this.restoreCurrentPlayback();
    this.status = { ...this.status, state: "error", error };
    this.lifecycleBusy = false;
    await this.persistAndBroadcast();
  }

  private async haltCurrentPlayback(): Promise<void> {
    if (this.status.tabId === undefined || !this.status.sessionId) return;
    try {
      await sendContentMessage(this.status.tabId, {
        target: "content",
        type: FULL_VIDEO_HALT,
        sessionId: this.status.sessionId,
      });
    } catch (error) {
      console.debug("[full-transcription] playback halt unavailable", error);
    }
  }

  private async restoreCurrentPlayback(): Promise<void> {
    if (this.status.tabId === undefined || !this.status.sessionId) return;
    await this.restorePlayback(this.status.tabId, this.status.sessionId);
  }

  private async restorePlayback(tabId: number, sessionId: string): Promise<void> {
    try {
      const response = await sendContentMessage(tabId, {
        target: "content",
        type: FULL_VIDEO_RESTORE,
        sessionId,
      });
      if (response.warning) this.status = { ...this.status, warning: response.warning };
    } catch (error) {
      this.status = {
        ...this.status,
        warning: `无法恢复原播放状态：${rawError(error)}`,
      };
    }
  }

  private async fail(error: FullTranscriptionError): Promise<FullTranscriptionResponse> {
    this.status = { ...this.status, state: "error", error };
    await this.persistAndBroadcast();
    return { ok: false, status: this.status, error };
  }

  private async getStatus(message: FullTranscriptionGetStatusMessage): Promise<FullTranscriptionResponse> {
    if (this.status.state === "idle") {
      const stored = await chrome.storage.session.get(SESSION_STORAGE_KEY) as {
        [SESSION_STORAGE_KEY]?: FullTranscriptionStatus;
      };
      this.status = stored[SESSION_STORAGE_KEY] ?? this.status;
    }

    if (!fullStatusMatchesIdentity(this.status, message)) {
      console.debug(`[full-transcription] get-status session mismatch requested=${message.sessionId ?? "none"}`);
      return { ok: true, status: baseStatus() };
    }

    const sessionId = message.sessionId ?? this.status.sessionId;
    const tabId = message.tabId ?? this.status.tabId;
    if (sessionId && tabId !== undefined &&
      this.status.state !== "completed" &&
      this.status.state !== "error" &&
      this.status.state !== "cancelled") {
      try {
        if (chrome.offscreen?.hasDocument && await chrome.offscreen.hasDocument()) {
          const response = await getOffscreenTranscriptionStatus({
            target: "offscreen",
            type: FULL_TRANSCRIPTION_OFFSCREEN_GET_STATUS,
            sessionId,
            tabId,
          });
          if (response?.status && response.sessionId === sessionId && response.tabId === tabId) {
            await this.handleOffscreenEvent({
              target: "background",
              type: FULL_TRANSCRIPTION_OFFSCREEN_EVENT,
              sessionId,
              status: response.status,
            });
          }
        }
      } catch (error) {
        console.debug(`[full-transcription] offscreen status unavailable message=${rawError(error)}`);
      }
    }

    console.debug(`[full-transcription] get-status sessionId=${sessionId ?? "none"}`);
    console.debug(`[full-transcription] get-status tabId=${tabId ?? "none"}`);
    console.debug(`[full-transcription] status=${this.status.state}`);
    console.debug(`[full-transcription] stage=${this.status.error?.stage ?? this.status.state}`);
    console.debug(`[full-transcription] transcriptLength=${this.status.result?.transcript.text.length ?? 0}`);
    return { ok: true, status: this.status };
  }

  private async persistAndBroadcast(): Promise<void> {
    await chrome.storage.session.set({ [SESSION_STORAGE_KEY]: this.status });
    try {
      await chrome.runtime.sendMessage({
        target: "sidepanel",
        type: FULL_TRANSCRIPTION_STATUS,
        status: this.status,
      });
    } catch (error) {
      console.debug("[full-transcription] sidepanel status unavailable", error);
    }
  }
}
