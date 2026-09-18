import type {
  TranscriptionErrorCode,
  TranscriptionResult,
  TranscriptionStage,
  TranscriptionState
} from "./types";

export const DEFAULT_BACKEND_BASE_URL = "http://127.0.0.1:8787";
const HEALTH_TIMEOUT_MS = 5_000;
const MAX_DECLARED_AUDIO_DURATION_SECONDS = 10 * 60;
// A 10-minute source can legitimately take several minutes on CPU/int8.
// This is a request safety timeout, not a supported media-duration limit.
const TRANSCRIPTION_TIMEOUT_MS = 15 * 60_000;

type FetchLike = typeof fetch;
type TranscriptionProgressState = Extract<TranscriptionState, "uploading" | "transcribing">;

interface BackendErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
    raw_message?: unknown;
  };
}

interface BackendTranscriptionBody {
  text?: unknown;
  language?: unknown;
  duration_seconds?: unknown;
}

export class TranscriptionClientError extends Error {
  public constructor(
    public readonly code: TranscriptionErrorCode,
    public readonly stage: TranscriptionStage,
    message: string,
    public readonly rawMessage?: string,
  ) {
    super(message);
    this.name = "TranscriptionClientError";
  }
}

function rawMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

interface JsonReadResult {
  parsed: boolean;
  body?: unknown;
  rawError?: string;
}

async function readJson(response: Response): Promise<JsonReadResult> {
  try {
    return { parsed: true, body: await response.json() };
  } catch (error) {
    return { parsed: false, rawError: rawMessage(error) };
  }
}

export class BackendTranscriptionClient {
  public constructor(
    private readonly baseUrl = DEFAULT_BACKEND_BASE_URL,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  public async transcribe(
    blob: Blob,
    durationMs: number,
    language = "zh",
    onStage?: (state: TranscriptionProgressState) => void,
  ): Promise<TranscriptionResult> {
    if (blob.size <= 0) {
      throw new TranscriptionClientError(
        "AUDIO_EMPTY",
        "audioCapture",
        "捕获到的音频为空，无法转写。",
      );
    }

    await this.checkHealth();
    onStage?.("uploading");

    const form = new FormData();
    form.append("file", blob, "douyin-capture.webm");
    form.append("language", language);
    form.append(
      "duration_seconds",
      String(Math.min(MAX_DECLARED_AUDIO_DURATION_SECONDS, Math.max(0, durationMs) / 1000)),
    );

    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/api/transcribe`,
      {
        method: "POST",
        body: form,
      },
      TRANSCRIPTION_TIMEOUT_MS,
      "UPLOAD_FAILED",
      "upload",
      () => onStage?.("transcribing"),
    );
    console.debug(`[transcription] response status=${response.status}`);

    const json = await readJson(response);
    if (json.parsed) console.debug("[transcription] response parsed");
    const body = json.body as BackendErrorBody & BackendTranscriptionBody | undefined;
    if (!response.ok) {
      const backendCode = body?.error?.code;
      const backendMessage = body?.error?.message;
      const backendRawMessage = body?.error?.raw_message;
      throw new TranscriptionClientError(
        backendCode === "TRANSCRIPTION_FAILED" ? "TRANSCRIPTION_FAILED" : "UPLOAD_FAILED",
        backendCode === "TRANSCRIPTION_FAILED" ? "transcription" : "upload",
        typeof backendMessage === "string" && backendMessage
          ? backendMessage
          : "本地转写服务返回失败状态。",
        typeof backendRawMessage === "string"
          ? backendRawMessage
          : `HTTP ${response.status}`,
      );
    }

    const text = typeof body?.text === "string" ? body.text.trim() : "";
    const responseLanguage = typeof body?.language === "string" ? body.language : "";
    const durationSeconds = body?.duration_seconds;
    console.debug(`[transcription] textLength=${text.length}`);
    if (!text || !responseLanguage || typeof durationSeconds !== "number") {
      throw new TranscriptionClientError(
        "INVALID_RESPONSE",
        "response",
        "本地转写服务返回了无效结果。",
        json.parsed
          ? "Response must contain non-empty text/language and numeric duration_seconds."
          : `Response body was not valid JSON: ${json.rawError ?? "unknown parse error"}`,
      );
    }

    return { text, language: responseLanguage, durationSeconds };
  }

  private async checkHealth(): Promise<void> {
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/health`,
      { method: "GET" },
      HEALTH_TIMEOUT_MS,
      "BACKEND_UNAVAILABLE",
      "backendHealth",
    );
    const json = await readJson(response);
    const body = json.body as { ok?: unknown } | undefined;
    if (!response.ok || !json.parsed || body?.ok !== true) {
      throw new TranscriptionClientError(
        "BACKEND_UNAVAILABLE",
        "backendHealth",
        "无法连接本地转写服务，请确认 backend 已启动。",
        json.parsed
          ? `Health check failed with HTTP ${response.status}.`
          : `Health response was not valid JSON: ${json.rawError ?? "unknown parse error"}`,
      );
    }
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    fallbackCode: TranscriptionErrorCode,
    stage: TranscriptionStage,
    onRequestStarted?: () => void,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const request = this.fetchImpl.call(
        globalThis,
        url,
        { ...init, signal: controller.signal },
      );
      onRequestStarted?.();
      return await request;
    } catch (error) {
      if (error instanceof TranscriptionClientError) throw error;
      const isTimeout = error instanceof DOMException && error.name === "AbortError";
      throw new TranscriptionClientError(
        isTimeout ? "TIMEOUT" : fallbackCode,
        stage,
        isTimeout
          ? "本地转写请求超时。"
          : stage === "backendHealth"
            ? "无法连接本地转写服务，请确认 backend 已启动。"
            : "音频上传失败，请确认本地转写服务正常运行。",
        rawMessage(error),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
