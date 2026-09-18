import { AudioCaptureController } from "../audioCapture/controller";
import {
  AUDIO_CAPTURE_START,
  type AudioCaptureResponse
} from "../audioCapture/types";
import {
  TRANSCRIPTION_GET_STATUS,
  TRANSCRIPTION_OFFSCREEN_EVENT,
  TRANSCRIPTION_START,
  TRANSCRIPTION_STATUS,
  type TranscriptionError,
  type TranscriptionOffscreenEventMessage,
  type TranscriptionPanelMessage,
  type TranscriptionResponse,
  type TranscriptionStatus
} from "./types";

const SESSION_STORAGE_KEY = "transcriptionStatus";
const CAPTURE_DURATION_MS = 15_000;

function isActive(status: TranscriptionStatus): boolean {
  return status.state === "capturing" ||
    status.state === "uploading" ||
    status.state === "transcribing";
}

function captureFailure(response: AudioCaptureResponse): TranscriptionError {
  return {
    code: "AUDIO_CAPTURE_FAILED",
    stage: "audioCapture",
    message: response.error?.message ?? "无法捕获当前抖音标签页音频。",
    rawMessage: response.error?.rawMessage ?? response.error?.code,
  };
}

export class TranscriptionController {
  private status: TranscriptionStatus = { state: "idle" };

  public constructor(private readonly audioCaptureController: AudioCaptureController) {}

  public register(): void {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (this.isOffscreenEvent(message)) {
        this.status = message.status;
        void this.persistAndBroadcast()
          .then(() => sendResponse({ ok: true }))
          .catch((error: unknown) => {
            const details = error instanceof Error ? error.message : String(error);
            console.error(`[transcription] status persistence failed message=${details}`);
            sendResponse({ ok: false });
          });
        return true;
      }
      if (!this.isPanelMessage(message)) return false;

      void this.handlePanelMessage(message)
        .then(sendResponse)
        .catch((error: unknown) => {
          const rawMessage = error instanceof Error ? error.message : String(error);
          const transcriptionError: TranscriptionError = {
            code: "TRANSCRIPTION_FAILED",
            stage: "transcription",
            message: "无法启动当前口播转写。",
            rawMessage,
          };
          sendResponse({ ok: false, error: transcriptionError } satisfies TranscriptionResponse);
        });
      return true;
    });
  }

  private isPanelMessage(message: unknown): message is TranscriptionPanelMessage {
    if (!message || typeof message !== "object") return false;
    const type = (message as { type?: unknown }).type;
    return type === TRANSCRIPTION_START || type === TRANSCRIPTION_GET_STATUS;
  }

  private isOffscreenEvent(message: unknown): message is TranscriptionOffscreenEventMessage {
    if (!message || typeof message !== "object") return false;
    const value = message as { target?: unknown; type?: unknown };
    return value.target === "background" && value.type === TRANSCRIPTION_OFFSCREEN_EVENT;
  }

  private async handlePanelMessage(message: TranscriptionPanelMessage): Promise<TranscriptionResponse> {
    if (message.type === TRANSCRIPTION_GET_STATUS) {
      return this.getStatus();
    }
    return this.start();
  }

  private async start(): Promise<TranscriptionResponse> {
    if (isActive(this.status)) {
      const error: TranscriptionError = {
        code: "AUDIO_CAPTURE_FAILED",
        stage: "audioCapture",
        message: "当前已有一个转写任务正在运行。",
      };
      return { ok: false, status: this.status, error };
    }

    this.status = { state: "capturing" };
    await this.persistAndBroadcast();
    const captureResponse = await this.audioCaptureController.startCapture({
      type: AUDIO_CAPTURE_START,
      maxDurationMs: CAPTURE_DURATION_MS,
      purpose: "transcription",
    });
    if (!captureResponse.ok) {
      const error = captureFailure(captureResponse);
      this.status = { state: "error", error };
      await this.persistAndBroadcast();
      return { ok: false, status: this.status, error };
    }

    return { ok: true, status: this.status };
  }

  private async getStatus(): Promise<TranscriptionResponse> {
    if (this.status.state !== "idle") {
      return { ok: true, status: this.status };
    }
    const stored = await chrome.storage.session.get(SESSION_STORAGE_KEY) as {
      [SESSION_STORAGE_KEY]?: TranscriptionStatus;
    };
    this.status = stored[SESSION_STORAGE_KEY] ?? this.status;
    return { ok: true, status: this.status };
  }

  private async persistAndBroadcast(): Promise<void> {
    await chrome.storage.session.set({ [SESSION_STORAGE_KEY]: this.status });
    try {
      await chrome.runtime.sendMessage({
        target: "sidepanel",
        type: TRANSCRIPTION_STATUS,
        status: this.status,
      });
    } catch (error) {
      console.debug("[transcription] sidepanel status unavailable", error);
    }
  }
}
