import {
  TRANSCRIPTION_OFFSCREEN_EVENT,
  type TranscriptionError,
  type TranscriptionStatus,
} from "../services/transcription/types";
import {
  FULL_TRANSCRIPTION_OFFSCREEN_EVENT,
  type FullTranscriptionOffscreenGetStatusMessage,
  type FullTranscriptionOffscreenStatusResponse,
} from "../services/fullTranscription/types";
import type { AudioCapturePurpose } from "../services/audioCapture/types";

export interface RetainedTranscriptionSnapshot {
  sessionId?: string;
  tabId?: number;
  purpose: AudioCapturePurpose;
  status: TranscriptionStatus;
}

export function transcriptionEventType(
  purpose: AudioCapturePurpose,
): typeof TRANSCRIPTION_OFFSCREEN_EVENT | typeof FULL_TRANSCRIPTION_OFFSCREEN_EVENT | undefined {
  if (purpose === "transcription") return TRANSCRIPTION_OFFSCREEN_EVENT;
  if (purpose === "full-transcription") return FULL_TRANSCRIPTION_OFFSCREEN_EVENT;
  return undefined;
}

export function retainedFullTranscriptionStatus(
  query: FullTranscriptionOffscreenGetStatusMessage,
  snapshot: RetainedTranscriptionSnapshot,
): FullTranscriptionOffscreenStatusResponse {
  const matches = snapshot.purpose === "full-transcription" &&
    snapshot.sessionId === query.sessionId &&
    snapshot.tabId === query.tabId;
  return {
    ok: true,
    sessionId: snapshot.sessionId,
    tabId: snapshot.tabId,
    purpose: snapshot.purpose,
    ...(matches ? { status: snapshot.status } : {}),
  };
}

export function structuredTranscriptionErrorLines(
  error: unknown,
  normalized: TranscriptionError,
): string[] {
  const stack = error instanceof Error
    ? error.stack ?? `${error.name}: ${error.message}`
    : typeof normalized.rawMessage === "string" && normalized.rawMessage
      ? normalized.rawMessage
      : String(error);
  return [
    `[transcription] code=${normalized.code}`,
    `[transcription] message=${normalized.message}`,
    `[transcription] stage=${normalized.stage}`,
    `[transcription] stack=${stack}`,
  ];
}
