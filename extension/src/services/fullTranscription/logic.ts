import {
  FULL_CAPTURE_END_TOLERANCE_SECONDS,
  FULL_CAPTURE_HARD_TIMEOUT_TOLERANCE_MS,
  MAX_FULL_VIDEO_SECONDS,
  type FullTranscriptionError,
  type FullTranscriptionState,
  type FullVideoIdentity,
} from "./types";

export interface FullVideoProgress {
  elapsedMs: number;
  durationMs: number;
  progress: number;
}

export function validateVideoDuration(
  durationSeconds: number,
  maxSeconds = MAX_FULL_VIDEO_SECONDS,
): FullTranscriptionError | undefined {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return {
      code: "VIDEO_DURATION_UNAVAILABLE",
      stage: "duration",
      message: "无法读取当前视频的有效时长。",
      rawMessage: `duration=${String(durationSeconds)}`,
    };
  }
  if (durationSeconds > maxSeconds) {
    return {
      code: "VIDEO_TOO_LONG",
      stage: "duration",
      message: "当前视频超过第一版支持的完整转写时长（10 分钟）。",
      rawMessage: `duration=${durationSeconds.toFixed(3)}s, max=${maxSeconds}s`,
    };
  }
  return undefined;
}

export function calculateFullVideoProgress(
  currentTimeSeconds: number,
  durationSeconds: number,
): FullVideoProgress {
  const safeDuration = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? durationSeconds
    : 0;
  const safeCurrent = Number.isFinite(currentTimeSeconds)
    ? Math.min(Math.max(0, currentTimeSeconds), safeDuration)
    : 0;
  return {
    elapsedMs: Math.round(safeCurrent * 1000),
    durationMs: Math.round(safeDuration * 1000),
    progress: safeDuration > 0 ? safeCurrent / safeDuration : 0,
  };
}

export function isNearVideoEnd(
  currentTimeSeconds: number,
  durationSeconds: number,
  toleranceSeconds = FULL_CAPTURE_END_TOLERANCE_SECONDS,
): boolean {
  return Number.isFinite(durationSeconds) &&
    durationSeconds > 0 &&
    currentTimeSeconds >= durationSeconds - toleranceSeconds;
}

export function detectLoopReset(
  previousTimeSeconds: number,
  currentTimeSeconds: number,
  durationSeconds: number,
): boolean {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return false;
  const nearEndThreshold = Math.max(durationSeconds * 0.8, durationSeconds - 2);
  const beginningThreshold = Math.min(1.5, durationSeconds * 0.1);
  return previousTimeSeconds >= nearEndThreshold &&
    currentTimeSeconds <= beginningThreshold &&
    previousTimeSeconds - currentTimeSeconds >= 1;
}

export function calculateHardTimeoutMs(durationSeconds: number): number {
  return Math.round(durationSeconds * 1000) + FULL_CAPTURE_HARD_TIMEOUT_TOLERANCE_MS;
}

export function hasHardTimedOut(elapsedWallMs: number, durationSeconds: number): boolean {
  return elapsedWallMs >= calculateHardTimeoutMs(durationSeconds);
}

export function isVideoIdentityChanged(
  initial: FullVideoIdentity,
  current: FullVideoIdentity,
): boolean {
  if (initial.pageUrl !== current.pageUrl) return true;
  if (initial.videoId && current.videoId && initial.videoId !== current.videoId) return true;
  return Boolean(initial.source && current.source && initial.source !== current.source);
}

const TRANSITIONS: Record<FullTranscriptionState, readonly FullTranscriptionState[]> = {
  idle: ["readingVideo"],
  readingVideo: ["preparing", "cancelling", "error"],
  preparing: ["capturing", "cancelling", "error"],
  capturing: ["processing", "cancelling", "error"],
  processing: ["uploading", "transcribing", "completed", "error"],
  uploading: ["transcribing", "completed", "error"],
  transcribing: ["completed", "error"],
  completed: ["readingVideo"],
  cancelling: ["cancelled", "error"],
  cancelled: ["readingVideo"],
  error: ["readingVideo"],
};

export function canTransitionFullTranscription(
  from: FullTranscriptionState,
  to: FullTranscriptionState,
): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function isFullTranscriptionActive(state: FullTranscriptionState): boolean {
  return state === "readingVideo" ||
    state === "preparing" ||
    state === "capturing" ||
    state === "processing" ||
    state === "uploading" ||
    state === "transcribing" ||
    state === "cancelling";
}

