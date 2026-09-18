import type { AudioCaptureResult } from "../audioCapture/types";

export type TranscriptionState =
  | "idle"
  | "capturing"
  | "uploading"
  | "transcribing"
  | "completed"
  | "error";

export type TranscriptionStage =
  | "audioCapture"
  | "backendHealth"
  | "upload"
  | "transcription"
  | "response";

export type TranscriptionErrorCode =
  | "BACKEND_UNAVAILABLE"
  | "AUDIO_CAPTURE_FAILED"
  | "AUDIO_EMPTY"
  | "UPLOAD_FAILED"
  | "TRANSCRIPTION_FAILED"
  | "INVALID_RESPONSE"
  | "TIMEOUT";

export interface TranscriptionError {
  code: TranscriptionErrorCode;
  stage: TranscriptionStage;
  message: string;
  rawMessage?: string;
}

export interface TranscriptionResult {
  text: string;
  language: string;
  durationSeconds: number;
}

export interface TranscriptionStatus {
  state: TranscriptionState;
  captureResult?: AudioCaptureResult;
  result?: TranscriptionResult;
  error?: TranscriptionError;
}

export const TRANSCRIPTION_START = "TRANSCRIPTION_START" as const;
export const TRANSCRIPTION_GET_STATUS = "TRANSCRIPTION_GET_STATUS" as const;
export const TRANSCRIPTION_STATUS = "TRANSCRIPTION_STATUS" as const;
export const TRANSCRIPTION_OFFSCREEN_EVENT = "TRANSCRIPTION_OFFSCREEN_EVENT" as const;

export interface TranscriptionStartMessage {
  type: typeof TRANSCRIPTION_START;
}

export interface TranscriptionGetStatusMessage {
  type: typeof TRANSCRIPTION_GET_STATUS;
}

export type TranscriptionPanelMessage =
  | TranscriptionStartMessage
  | TranscriptionGetStatusMessage;

export interface TranscriptionOffscreenEventMessage {
  target: "background";
  type: typeof TRANSCRIPTION_OFFSCREEN_EVENT;
  status: TranscriptionStatus;
}

export interface TranscriptionResponse {
  ok: boolean;
  status?: TranscriptionStatus;
  error?: TranscriptionError;
}
