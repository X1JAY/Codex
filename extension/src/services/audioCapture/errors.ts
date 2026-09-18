import type { AudioCaptureError, AudioCaptureErrorCode, AudioCaptureStage } from "./types";

export class AudioCaptureException extends Error {
  readonly code: AudioCaptureErrorCode | string;
  readonly causeValue?: unknown;
  readonly stage?: AudioCaptureStage;
  readonly rawMessage?: string;

  constructor(
    code: AudioCaptureErrorCode | string,
    message: string,
    causeValue?: unknown,
    stage?: AudioCaptureStage,
    rawMessage?: string
  ) {
    super(message);
    this.name = "AudioCaptureException";
    this.code = code;
    this.causeValue = causeValue;
    this.stage = stage;
    this.rawMessage = rawMessage;
  }
}

function errorName(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { name?: unknown };
  return typeof value.name === "string" ? value.name : undefined;
}

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.message) return error.message;
  if (!error || typeof error !== "object") return undefined;
  const value = error as { message?: unknown };
  return typeof value.message === "string" && value.message ? value.message : undefined;
}

export function rawErrorMessage(error: unknown): string | undefined {
  if (error instanceof AudioCaptureException && error.rawMessage) return error.rawMessage;
  if (typeof error === "string" && error) return error;
  return errorMessage(error);
}

export function normalizeAudioCaptureError(
  error: unknown,
  fallbackCode: AudioCaptureErrorCode | string = "UNKNOWN",
  fallbackMessage = "音频捕获失败，请重试。",
  fallbackStage?: AudioCaptureStage
): AudioCaptureError {
  if (error instanceof AudioCaptureException) {
    return {
      code: error.code,
      stage: error.stage ?? fallbackStage,
      message: error.message,
      ...(error.rawMessage || rawErrorMessage(error.causeValue)
        ? { rawMessage: error.rawMessage ?? rawErrorMessage(error.causeValue) }
        : {}),
      cause: error.causeValue
    };
  }

  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const value = error as {
      code: unknown;
      stage?: unknown;
      message: unknown;
      rawMessage?: unknown;
      cause?: unknown;
    };
    if (typeof value.code === "string" && typeof value.message === "string") {
      return {
        code: value.code,
        stage: typeof value.stage === "string" ? value.stage as AudioCaptureStage : fallbackStage,
        message: value.message,
        ...(typeof value.rawMessage === "string" && value.rawMessage
          ? { rawMessage: value.rawMessage }
          : rawErrorMessage(value.cause)
            ? { rawMessage: rawErrorMessage(value.cause) }
            : {}),
        cause: value.cause
      };
    }
  }

  const name = errorName(error);
  const detail = errorMessage(error);
  let code = fallbackCode;
  let message = fallbackMessage;
  if (name === "NotAllowedError") {
    code = "TAB_CAPTURE_DENIED";
    message = "Chrome 拒绝了当前标签页音频捕获请求。请确认当前标签页可捕获，并从扩展按钮重新开始。";
  } else if (name === "NotFoundError") {
    code = "TAB_UNAVAILABLE";
    message = "当前标签页或音频轨道已经不存在。请保持视频页打开并正常播放后重试。";
  } else if (name === "AbortError") {
    code = "TAB_CAPTURE_FAILED";
    message = "当前标签页音频捕获被中止，请重试。";
  } else if (detail && fallbackMessage === "音频捕获失败，请重试。") {
    message = `音频捕获失败：${detail}`;
  }

  return {
    code,
    stage: fallbackStage,
    message,
    ...(detail ? { rawMessage: detail } : {}),
    cause: detail ? { name, message: detail } : error
  };
}

export function publicAudioCaptureError(error: AudioCaptureError): AudioCaptureError {
  return {
    code: error.code,
    ...(error.stage ? { stage: error.stage } : {}),
    message: error.message,
    ...(error.rawMessage ? { rawMessage: error.rawMessage } : {})
  };
}

export function assertNonEmptyBlob(blob: Blob): void {
  if (!blob || blob.size <= 0) {
    throw new AudioCaptureException("EMPTY_BLOB", "录音结果为空，当前标签页可能没有输出音频。", blob);
  }
}
