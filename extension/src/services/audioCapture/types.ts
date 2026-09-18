export type AudioCaptureState =
  | "idle"
  | "requesting"
  | "recording"
  | "stopping"
  | "completed"
  | "cancelled"
  | "error";

export type AudioCaptureErrorCode =
  | "TAB_UNAVAILABLE"
  | "TAB_CAPTURE_UNAVAILABLE"
  | "TAB_CAPTURE_DENIED"
  | "TAB_CAPTURE_FAILED"
  | "OFFSCREEN_UNAVAILABLE"
  | "OFFSCREEN_CREATE_FAILED"
  | "ALREADY_RECORDING"
  | "NO_AUDIO_TRACK"
  | "MEDIA_RECORDER_UNAVAILABLE"
  | "MIME_TYPE_UNSUPPORTED"
  | "RECORDER_FAILED"
  | "EMPTY_BLOB"
  | "CAPTURE_TIMEOUT"
  | "TARGET_TAB_CLOSED"
  | "STOP_FAILED"
  | "UNKNOWN";

export type AudioCaptureStage =
  | "resolveActiveTab"
  | "createOffscreen"
  | "getMediaStreamId"
  | "offscreenMessage"
  | "getUserMedia"
  | "mediaRecorder";

export interface AudioCaptureError {
  code: AudioCaptureErrorCode | string;
  stage?: AudioCaptureStage;
  message: string;
  rawMessage?: string;
  cause?: unknown;
}

export interface AudioCaptureResult {
  mimeType: string;
  audioTrackCount: number;
  sizeBytes: number;
  durationMs: number;
  tabId: number;
  startedAt: string;
  endedAt: string;
}

export interface AudioCaptureStatus {
  state: AudioCaptureState;
  elapsedMs: number;
  tabId?: number;
  sessionId?: string;
  purpose?: AudioCapturePurpose;
  transcriptionState?: "idle" | "capturing" | "uploading" | "transcribing" | "completed" | "error";
  transcriptLength?: number;
  mimeType?: string;
  startedAt?: string;
  result?: AudioCaptureResult;
  error?: AudioCaptureError;
}

export type AudioCapturePurpose = "capture-test" | "transcription" | "full-transcription";

export const AUDIO_CAPTURE_START = "AUDIO_CAPTURE_START" as const;
export const AUDIO_CAPTURE_STOP = "AUDIO_CAPTURE_STOP" as const;
export const AUDIO_CAPTURE_GET_STATUS = "AUDIO_CAPTURE_GET_STATUS" as const;
export const AUDIO_CAPTURE_STATUS = "AUDIO_CAPTURE_STATUS" as const;

export const AUDIO_CAPTURE_OFFSCREEN_START = "AUDIO_CAPTURE_OFFSCREEN_START" as const;
export const AUDIO_CAPTURE_OFFSCREEN_STOP = "AUDIO_CAPTURE_OFFSCREEN_STOP" as const;
export const AUDIO_CAPTURE_OFFSCREEN_CANCEL = "AUDIO_CAPTURE_OFFSCREEN_CANCEL" as const;
export const AUDIO_CAPTURE_OFFSCREEN_GET_STATUS = "AUDIO_CAPTURE_OFFSCREEN_GET_STATUS" as const;
export const AUDIO_CAPTURE_OFFSCREEN_EVENT = "AUDIO_CAPTURE_OFFSCREEN_EVENT" as const;

export interface AudioCaptureStartMessage {
  type: typeof AUDIO_CAPTURE_START;
  maxDurationMs?: number;
  purpose?: AudioCapturePurpose;
  sessionId?: string;
}

export interface AudioCaptureStopMessage {
  type: typeof AUDIO_CAPTURE_STOP;
}

export interface AudioCaptureGetStatusMessage {
  type: typeof AUDIO_CAPTURE_GET_STATUS;
  sessionId?: string;
  tabId?: number;
}

export interface OffscreenStartMessage {
  target: "offscreen";
  type: typeof AUDIO_CAPTURE_OFFSCREEN_START;
  sessionId: string;
  streamId: string;
  tabId: number;
  maxDurationMs: number;
  purpose: AudioCapturePurpose;
}

export interface OffscreenStopMessage {
  target: "offscreen";
  type: typeof AUDIO_CAPTURE_OFFSCREEN_STOP;
}

export interface OffscreenCancelMessage {
  target: "offscreen";
  type: typeof AUDIO_CAPTURE_OFFSCREEN_CANCEL;
}

export interface OffscreenGetStatusMessage {
  target: "offscreen";
  type: typeof AUDIO_CAPTURE_OFFSCREEN_GET_STATUS;
  sessionId?: string;
  tabId?: number;
}

export interface OffscreenEventMessage {
  target: "background";
  type: typeof AUDIO_CAPTURE_OFFSCREEN_EVENT;
  sessionId: string;
  status: AudioCaptureStatus;
}

export type AudioCapturePanelMessage =
  | AudioCaptureStartMessage
  | AudioCaptureStopMessage
  | AudioCaptureGetStatusMessage;

export type AudioCaptureOffscreenMessage =
  | OffscreenStartMessage
  | OffscreenStopMessage
  | OffscreenCancelMessage
  | OffscreenGetStatusMessage;

export interface AudioCaptureResponse {
  ok: boolean;
  status?: AudioCaptureStatus;
  error?: AudioCaptureError;
}
