import {
  AUDIO_CAPTURE_OFFSCREEN_EVENT,
  AUDIO_CAPTURE_OFFSCREEN_CANCEL,
  AUDIO_CAPTURE_OFFSCREEN_GET_STATUS,
  AUDIO_CAPTURE_OFFSCREEN_START,
  AUDIO_CAPTURE_OFFSCREEN_STOP,
  type AudioCaptureResponse,
  type AudioCapturePurpose,
  type AudioCaptureResult,
  type AudioCaptureStatus,
  type OffscreenGetStatusMessage,
  type OffscreenStartMessage,
  type OffscreenStopMessage
} from "../services/audioCapture/types";
import { normalizeAudioCaptureError, publicAudioCaptureError } from "../services/audioCapture/errors";
import { TabAudioRecorder } from "../services/audioCapture/recorder";
import { isAudioCaptureActive, transitionAudioCaptureState } from "../services/audioCapture/state";
import {
  BackendTranscriptionClient,
  TranscriptionClientError
} from "../services/transcription/backendClient";
import {
  type TranscriptionError,
  type TranscriptionStatus
} from "../services/transcription/types";
import {
  FULL_TRANSCRIPTION_OFFSCREEN_GET_STATUS,
  type FullTranscriptionOffscreenGetStatusMessage,
} from "../services/fullTranscription/types";
import {
  retainedFullTranscriptionStatus,
  structuredTranscriptionErrorLines,
  transcriptionEventType,
} from "./transcriptionBridge";

const DEFAULT_MAX_DURATION_MS = 15_000;

let sessionId: string | undefined;
let status: AudioCaptureStatus = { state: "idle", elapsedMs: 0 };
let capturePurpose: AudioCapturePurpose = "capture-test";
let transcriptionStatus: TranscriptionStatus = { state: "idle" };
let transcriptionStatusPublishQueue: Promise<void> = Promise.resolve();
const transcriptionClient = new BackendTranscriptionClient();

function log(event: string, details?: Record<string, unknown>): void {
  if (event === "getUserMedia failed" && typeof details?.rawError === "string") {
    console.error(`[audio-capture] ${event}: ${details.rawError}`);
    return;
  }
  console.debug(`[audio-capture] ${event}`, details ?? "");
}

function sendStatus(): void {
  if (!sessionId) return;
  void chrome.runtime.sendMessage({
    target: "background",
    type: AUDIO_CAPTURE_OFFSCREEN_EVENT,
    sessionId,
    status
  }).catch((error: unknown) => {
    const normalized = normalizeAudioCaptureError(
      error,
      "TAB_CAPTURE_FAILED",
      "无法向 Service Worker 发送音频捕获状态。",
      "offscreenMessage"
    );
    log("status message failed", {
      stage: normalized.stage,
      rawError: normalized.rawMessage ?? normalized.message
    });
  });
}

function sendTranscriptionStatus(): Promise<void> {
  const eventType = transcriptionEventType(capturePurpose);
  if (!eventType || !sessionId) return Promise.resolve();
  const outgoingSessionId = sessionId;
  const outgoingStatus = transcriptionStatus;
  status = {
    ...status,
    purpose: capturePurpose,
    transcriptionState: outgoingStatus.state,
    transcriptLength: outgoingStatus.result?.text.length ?? 0,
  };
  sendStatus();
  transcriptionStatusPublishQueue = transcriptionStatusPublishQueue.then(async () => {
    try {
      await chrome.runtime.sendMessage({
        target: "background",
        type: eventType,
        sessionId: outgoingSessionId,
        status: outgoingStatus,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[transcription] code=STATUS_MESSAGE_FAILED");
      console.error(`[transcription] message=${message}`);
      console.error("[transcription] stage=response");
      console.error(`[transcription] stack=${error instanceof Error ? error.stack ?? message : message}`);
    }
  });
  return transcriptionStatusPublishQueue;
}

function transcriptionError(error: unknown): TranscriptionError {
  if (error instanceof TranscriptionClientError) {
    return {
      code: error.code,
      stage: error.stage,
      message: error.message,
      rawMessage: error.rawMessage
    };
  }

  return {
    code: "TRANSCRIPTION_FAILED",
    stage: "transcription",
    message: "本地语音转写失败。",
    rawMessage: error instanceof Error ? error.message : String(error)
  };
}

async function transcribeCapture(blob: Blob, captureResult: AudioCaptureResult): Promise<void> {
  transcriptionStatus = { state: "uploading", captureResult };
  await sendTranscriptionStatus();
  console.debug("[transcription] upload starting", {
    mimeType: blob.type,
    sizeBytes: blob.size,
    durationMs: captureResult.durationMs
  });

  try {
    const result = await transcriptionClient.transcribe(
      blob,
      captureResult.durationMs,
      "zh",
      (state) => {
        transcriptionStatus = { state, captureResult };
        void sendTranscriptionStatus();
        console.debug(`[transcription] state=${state}`);
      }
    );
    transcriptionStatus = { state: "completed", captureResult, result };
    await sendTranscriptionStatus();
    console.debug(`[transcription] sessionId=${sessionId ?? "none"}`);
    console.debug(`[transcription] tabId=${captureResult.tabId}`);
    console.debug("[transcription] state=completed");
    console.debug(`[transcription] textLength=${result.text.length}`);
  } catch (error) {
    const normalized = transcriptionError(error);
    transcriptionStatus = {
      state: "error",
      captureResult,
      error: normalized
    };
    await sendTranscriptionStatus();
    for (const line of structuredTranscriptionErrorLines(error, normalized)) {
      console.error(line);
    }
  } finally {
    recorder.clearLastCapture();
  }
}

const recorder = new TabAudioRecorder({
  onLog: log,
  onStarted: ({ mimeType, startedAt }) => {
    status = {
      ...status,
      state: transitionAudioCaptureState(status.state, "RECORDING_STARTED"),
      mimeType,
      startedAt,
      elapsedMs: 0
    };
    sendStatus();
  },
  onProgress: (elapsedMs) => {
    status = { ...status, elapsedMs };
    sendStatus();
  },
  onChunk: () => undefined,
  onCompleted: (result, blob) => {
    status = {
      ...status,
      state: transitionAudioCaptureState(status.state, "COMPLETED"),
      elapsedMs: result.durationMs,
      result,
      error: undefined
    };
    log("blob created", { mimeType: result.mimeType, sizeBytes: result.sizeBytes, durationMs: result.durationMs });
    sendStatus();
    if (capturePurpose === "transcription" || capturePurpose === "full-transcription") {
      void transcribeCapture(blob, result);
    }
  },
  onError: (error) => {
    status = { ...status, state: "error", error: publicAudioCaptureError(error) };
    log("recorder error", {
      code: error.code,
      stage: error.stage,
      message: error.message,
      rawError: error.rawMessage ?? error.message
    });
    sendStatus();
    if (capturePurpose === "transcription" || capturePurpose === "full-transcription") {
      transcriptionStatus = {
        state: "error",
        error: {
          code: error.code === "EMPTY_BLOB" ? "AUDIO_EMPTY" : "AUDIO_CAPTURE_FAILED",
          stage: "audioCapture",
          message: error.message,
          rawMessage: error.rawMessage
        }
      };
      void sendTranscriptionStatus();
    }
  }
});

async function start(message: OffscreenStartMessage): Promise<AudioCaptureResponse> {
  if (isAudioCaptureActive(status.state) || recorder.active) {
    return {
      ok: false,
      status,
      error: {
        code: "ALREADY_RECORDING",
        stage: "mediaRecorder",
        message: "已经有一个音频捕获任务正在进行。"
      }
    };
  }
  sessionId = message.sessionId;
  capturePurpose = message.purpose ?? "capture-test";
  transcriptionStatusPublishQueue = Promise.resolve();
  status = {
    state: "requesting",
    elapsedMs: 0,
    tabId: message.tabId,
    sessionId: message.sessionId,
    purpose: capturePurpose,
  };
  sendStatus();
  if (capturePurpose === "transcription" || capturePurpose === "full-transcription") {
    transcriptionStatus = { state: "capturing" };
    await sendTranscriptionStatus();
  }
  log("capture requested", { tabId: message.tabId, maxDurationMs: message.maxDurationMs });
  try {
    const started = await recorder.start(message.streamId, message.tabId, message.maxDurationMs || DEFAULT_MAX_DURATION_MS);
    status = { ...status, state: "recording", mimeType: started.mimeType, startedAt: started.startedAt };
    sendStatus();
    return { ok: true, status };
  } catch (error) {
    const normalized = publicAudioCaptureError(normalizeAudioCaptureError(
      error,
      "TAB_CAPTURE_FAILED",
      "无法在 Offscreen Document 中启动录音。",
      "getUserMedia"
    ));
    status = { ...status, state: "error", error: normalized };
    sendStatus();
    return { ok: false, status, error: normalized };
  }
}

async function stop(): Promise<AudioCaptureResponse> {
  if (!recorder.active) {
    return {
      ok: false,
      status,
      error: {
        code: "STOP_FAILED",
        stage: "mediaRecorder",
        message: "当前没有正在进行的音频捕获任务。"
      }
    };
  }
  status = { ...status, state: transitionAudioCaptureState(status.state, "REQUEST_STOP") };
  sendStatus();
  try {
    const result = await recorder.stop();
    status = { ...status, state: "completed", result, elapsedMs: result.durationMs };
    sendStatus();
    return { ok: true, status };
  } catch (error) {
    const normalized = publicAudioCaptureError(normalizeAudioCaptureError(
      error,
      "STOP_FAILED",
      "无法停止录音。",
      "mediaRecorder"
    ));
    status = { ...status, state: "error", error: normalized };
    sendStatus();
    return { ok: false, status, error: normalized };
  }
}

async function cancel(): Promise<AudioCaptureResponse> {
  if (!recorder.active) {
    status = { ...status, state: "cancelled", error: undefined };
    sendStatus();
    return { ok: true, status };
  }
  try {
    await recorder.cancel();
    status = {
      ...status,
      state: transitionAudioCaptureState(status.state, "CANCELLED"),
      error: undefined,
      result: undefined
    };
    sendStatus();
    return { ok: true, status };
  } catch (error) {
    const normalized = publicAudioCaptureError(normalizeAudioCaptureError(
      error,
      "STOP_FAILED",
      "无法取消录音。",
      "mediaRecorder"
    ));
    status = { ...status, state: "error", error: normalized };
    sendStatus();
    return { ok: false, status, error: normalized };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object" || (message as { target?: unknown }).target !== "offscreen") return false;
  const type = (message as { type?: unknown }).type;
  log("offscreen message received", { type });
  if (type === AUDIO_CAPTURE_OFFSCREEN_START) {
    void start(message as OffscreenStartMessage).then(sendResponse);
    return true;
  }
  if (type === AUDIO_CAPTURE_OFFSCREEN_STOP) {
    void stop().then(sendResponse);
    return true;
  }
  if (type === AUDIO_CAPTURE_OFFSCREEN_CANCEL) {
    void cancel().then(sendResponse);
    return true;
  }
  if (type === AUDIO_CAPTURE_OFFSCREEN_GET_STATUS) {
    const query = message as OffscreenGetStatusMessage;
    const matches = (!query.sessionId || query.sessionId === sessionId) &&
      (query.tabId === undefined || query.tabId === status.tabId);
    sendResponse({
      ok: true,
      status: matches ? status : { state: "idle", elapsedMs: 0 },
    } satisfies AudioCaptureResponse);
    return false;
  }
  if (type === FULL_TRANSCRIPTION_OFFSCREEN_GET_STATUS) {
    sendResponse(retainedFullTranscriptionStatus(
      message as FullTranscriptionOffscreenGetStatusMessage,
      {
        sessionId,
        tabId: status.tabId,
        purpose: capturePurpose,
        status: transcriptionStatus,
      },
    ));
    return false;
  }
  return false;
});

log("offscreen ready");
