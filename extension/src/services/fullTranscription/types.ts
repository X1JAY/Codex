import type { AudioCapturePurpose, AudioCaptureResult } from "../audioCapture/types";
import type { TranscriptionResult, TranscriptionStatus } from "../transcription/types";
import type { VideoMetadata } from "../../shared/types";

export const MAX_FULL_VIDEO_SECONDS = 10 * 60;
export const FULL_CAPTURE_END_TOLERANCE_SECONDS = 0.05;
export const FULL_CAPTURE_HARD_TIMEOUT_TOLERANCE_MS = 10_000;

export type FullTranscriptionState =
  | "idle"
  | "readingVideo"
  | "preparing"
  | "capturing"
  | "processing"
  | "uploading"
  | "transcribing"
  | "completed"
  | "cancelling"
  | "cancelled"
  | "error";

export type FullTranscriptionStage =
  | "videoDiscovery"
  | "duration"
  | "seek"
  | "audioCapture"
  | "playback"
  | "monitor"
  | "backendHealth"
  | "upload"
  | "transcription"
  | "response"
  | "restore";

export type FullTranscriptionErrorCode =
  | "CONTENT_SCRIPT_UNAVAILABLE"
  | "VIDEO_NOT_FOUND"
  | "VIDEO_DURATION_UNAVAILABLE"
  | "VIDEO_TOO_LONG"
  | "VIDEO_SEEK_FAILED"
  | "VIDEO_PLAY_FAILED"
  | "VIDEO_CHANGED_DURING_CAPTURE"
  | "FULL_CAPTURE_TIMEOUT"
  | "FULL_CAPTURE_CANCELLED"
  | "AUDIO_CAPTURE_FAILED"
  | "BACKEND_UNAVAILABLE"
  | "UPLOAD_FAILED"
  | "TRANSCRIPTION_FAILED"
  | "INVALID_RESPONSE";

export interface FullTranscriptionError {
  code: FullTranscriptionErrorCode;
  stage: FullTranscriptionStage;
  message: string;
  rawMessage?: string;
}

export interface VideoPlaybackState {
  duration: number;
  currentTime: number;
  paused: boolean;
  muted: boolean;
  playbackRate: number;
  loop: boolean;
}

export interface FullVideoIdentity {
  pageUrl: string;
  source: string;
  videoId?: string;
}

export interface FullVideoPreparedData {
  metadata: VideoMetadata & { durationSeconds: number };
  playbackState: VideoPlaybackState;
  identity: FullVideoIdentity;
  startOffsetSeconds: number;
}

export interface FullTranscriptResult {
  metadata: VideoMetadata & { durationSeconds: number };
  transcript: TranscriptionResult & {
    source: "speech_to_text";
    model: "small";
  };
  capture: AudioCaptureResult;
}

export interface FullTranscriptionStatus {
  state: FullTranscriptionState;
  sessionId?: string;
  tabId?: number;
  elapsedMs: number;
  durationMs: number;
  progress?: number;
  metadata?: VideoMetadata & { durationSeconds: number };
  playbackState?: VideoPlaybackState;
  startOffsetSeconds?: number;
  captureResult?: AudioCaptureResult;
  result?: FullTranscriptResult;
  error?: FullTranscriptionError;
  warning?: string;
}

export const FULL_TRANSCRIPTION_START = "FULL_TRANSCRIPTION_START" as const;
export const FULL_TRANSCRIPTION_CANCEL = "FULL_TRANSCRIPTION_CANCEL" as const;
export const FULL_TRANSCRIPTION_GET_STATUS = "FULL_TRANSCRIPTION_GET_STATUS" as const;
export const FULL_TRANSCRIPTION_STATUS = "FULL_TRANSCRIPTION_STATUS" as const;

export const FULL_VIDEO_PREPARE = "FULL_VIDEO_PREPARE" as const;
export const FULL_VIDEO_PLAY = "FULL_VIDEO_PLAY" as const;
export const FULL_VIDEO_HALT = "FULL_VIDEO_HALT" as const;
export const FULL_VIDEO_RESTORE = "FULL_VIDEO_RESTORE" as const;
export const FULL_VIDEO_CONTENT_EVENT = "FULL_VIDEO_CONTENT_EVENT" as const;

export const FULL_TRANSCRIPTION_OFFSCREEN_EVENT = "FULL_TRANSCRIPTION_OFFSCREEN_EVENT" as const;
export const FULL_TRANSCRIPTION_OFFSCREEN_GET_STATUS = "FULL_TRANSCRIPTION_OFFSCREEN_GET_STATUS" as const;

export interface FullTranscriptionStartMessage {
  type: typeof FULL_TRANSCRIPTION_START;
}

export interface FullTranscriptionCancelMessage {
  type: typeof FULL_TRANSCRIPTION_CANCEL;
}

export interface FullTranscriptionGetStatusMessage {
  type: typeof FULL_TRANSCRIPTION_GET_STATUS;
  sessionId?: string;
  tabId?: number;
}

export type FullTranscriptionPanelMessage =
  | FullTranscriptionStartMessage
  | FullTranscriptionCancelMessage
  | FullTranscriptionGetStatusMessage;

export interface FullVideoPrepareMessage {
  target: "content";
  type: typeof FULL_VIDEO_PREPARE;
  sessionId: string;
}

export interface FullVideoPlayMessage {
  target: "content";
  type: typeof FULL_VIDEO_PLAY;
  sessionId: string;
}

export interface FullVideoHaltMessage {
  target: "content";
  type: typeof FULL_VIDEO_HALT;
  sessionId: string;
}

export interface FullVideoRestoreMessage {
  target: "content";
  type: typeof FULL_VIDEO_RESTORE;
  sessionId: string;
}

export type FullVideoContentMessage =
  | FullVideoPrepareMessage
  | FullVideoPlayMessage
  | FullVideoHaltMessage
  | FullVideoRestoreMessage;

export interface FullVideoContentResponse {
  ok: boolean;
  prepared?: FullVideoPreparedData;
  error?: FullTranscriptionError;
  warning?: string;
}

export type FullVideoCompletionReason = "ended" | "near-end" | "loop-reset";

export type FullVideoContentEvent =
  | {
      target: "background";
      type: typeof FULL_VIDEO_CONTENT_EVENT;
      sessionId: string;
      event: "progress";
      elapsedMs: number;
      durationMs: number;
      progress: number;
    }
  | {
      target: "background";
      type: typeof FULL_VIDEO_CONTENT_EVENT;
      sessionId: string;
      event: "completed";
      elapsedMs: number;
      durationMs: number;
      reason: FullVideoCompletionReason;
    }
  | {
      target: "background";
      type: typeof FULL_VIDEO_CONTENT_EVENT;
      sessionId: string;
      event: "error";
      error: FullTranscriptionError;
    };

export interface FullTranscriptionOffscreenEvent {
  target: "background";
  type: typeof FULL_TRANSCRIPTION_OFFSCREEN_EVENT;
  sessionId: string;
  status: TranscriptionStatus;
}

export interface FullTranscriptionOffscreenGetStatusMessage {
  target: "offscreen";
  type: typeof FULL_TRANSCRIPTION_OFFSCREEN_GET_STATUS;
  sessionId: string;
  tabId: number;
}

export interface FullTranscriptionOffscreenStatusResponse {
  ok: boolean;
  sessionId?: string;
  tabId?: number;
  purpose?: AudioCapturePurpose;
  status?: TranscriptionStatus;
}

export interface FullTranscriptionResponse {
  ok: boolean;
  status?: FullTranscriptionStatus;
  error?: FullTranscriptionError;
}
