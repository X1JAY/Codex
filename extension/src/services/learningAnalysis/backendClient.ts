import { MAX_ANALYSIS_TRANSCRIPT_CHARS } from "./logic";
import type {
  LearningAnalysisErrorCode,
  LearningAnalysisInput,
  LearningAnalysisResult,
  LearningAnalysisStage,
  LearningAnalysisStructureItem,
} from "./types";

export const DEFAULT_ANALYSIS_BACKEND_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_ANALYSIS_TIMEOUT_MS = 30_000;

type FetchLike = typeof fetch;

interface BackendErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
    raw_message?: unknown;
  };
}

interface BackendAnalysisBody {
  sourceSessionId?: unknown;
  cleanedTranscript?: unknown;
  keyPoints?: unknown;
  structure?: unknown;
  hooks?: unknown;
  notableQuotes?: unknown;
  learningNotes?: unknown;
}

const ERROR_CODES = new Set<LearningAnalysisErrorCode>([
  "ANALYSIS_INPUT_EMPTY",
  "ANALYSIS_INPUT_TOO_LONG",
  "ANALYSIS_PROVIDER_UNAVAILABLE",
  "ANALYSIS_TIMEOUT",
  "ANALYSIS_INVALID_RESPONSE",
  "ANALYSIS_FAILED",
  "STALE_ANALYSIS_SESSION",
]);

export class LearningAnalysisClientError extends Error {
  public constructor(
    public readonly code: LearningAnalysisErrorCode,
    public readonly stage: LearningAnalysisStage,
    message: string,
    public readonly rawMessage?: string,
  ) {
    super(message);
    this.name = "LearningAnalysisClientError";
  }
}

export interface LearningAnalysisClient {
  analyze(input: LearningAnalysisInput): Promise<LearningAnalysisResult>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    return undefined;
  }
  return value.map((item) => item.trim());
}

function structureArray(value: unknown): LearningAnalysisStructureItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: LearningAnalysisStructureItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const title = (item as { title?: unknown }).title;
    const summary = (item as { summary?: unknown }).summary;
    if (typeof title !== "string" || !title.trim() || typeof summary !== "string" || !summary.trim()) {
      return undefined;
    }
    items.push({ title: title.trim(), summary: summary.trim() });
  }
  return items;
}

function parseResult(body: BackendAnalysisBody, sourceSessionId: string): LearningAnalysisResult {
  const cleanedTranscript = typeof body.cleanedTranscript === "string"
    ? body.cleanedTranscript.trim()
    : "";
  const learningNotes = typeof body.learningNotes === "string" ? body.learningNotes.trim() : "";
  const keyPoints = stringArray(body.keyPoints);
  const structure = structureArray(body.structure);
  const hooks = stringArray(body.hooks);
  const notableQuotes = stringArray(body.notableQuotes);
  if (body.sourceSessionId !== sourceSessionId) {
    throw new LearningAnalysisClientError(
      "STALE_ANALYSIS_SESSION",
      "session",
      "学习整理结果不属于当前完整转写任务。",
      `Expected ${sourceSessionId}, received ${String(body.sourceSessionId)}`,
    );
  }
  if (!cleanedTranscript || !learningNotes || !keyPoints || keyPoints.length < 3 || keyPoints.length > 8 ||
    !structure || structure.length === 0 || !hooks || !notableQuotes) {
    throw new LearningAnalysisClientError(
      "ANALYSIS_INVALID_RESPONSE",
      "response",
      "学习整理服务返回了无效结果。",
      "Response must contain all six Phase 4B result fields and 3-8 key points.",
    );
  }
  return {
    sourceSessionId,
    cleanedTranscript,
    keyPoints,
    structure,
    hooks,
    notableQuotes,
    learningNotes,
  };
}

export class BackendLearningAnalysisClient implements LearningAnalysisClient {
  public constructor(
    private readonly baseUrl = DEFAULT_ANALYSIS_BACKEND_BASE_URL,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = DEFAULT_ANALYSIS_TIMEOUT_MS,
  ) {}

  public async analyze(input: LearningAnalysisInput): Promise<LearningAnalysisResult> {
    if (!input.transcript.trim()) {
      throw new LearningAnalysisClientError(
        "ANALYSIS_INPUT_EMPTY",
        "input",
        "完整逐字稿为空，无法生成学习整理。",
      );
    }
    if (input.transcript.length > MAX_ANALYSIS_TRANSCRIPT_CHARS) {
      throw new LearningAnalysisClientError(
        "ANALYSIS_INPUT_TOO_LONG",
        "input",
        `完整逐字稿超过 ${MAX_ANALYSIS_TRANSCRIPT_CHARS} 字符限制，当前版本不会静默截断。`,
      );
    }

    const requestStartedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl.call(globalThis, `${this.baseUrl}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: input.sourceSessionId,
          metadata: input.metadata,
          caption: input.caption,
          transcript: input.transcript,
          transcriptLanguage: input.transcriptLanguage,
          outputLanguage: input.outputLanguage,
        }),
        signal: controller.signal,
      });
      console.debug(
        `[phase4b] response received status=${response.status} elapsedMs=${Date.now() - requestStartedAt}`,
      );
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "AbortError";
      throw new LearningAnalysisClientError(
        timedOut ? "ANALYSIS_TIMEOUT" : "ANALYSIS_PROVIDER_UNAVAILABLE",
        timedOut ? "provider" : "backend",
        timedOut ? "学习整理请求超时。" : "无法连接本地学习整理服务。",
        errorMessage(error),
      );
    } finally {
      clearTimeout(timer);
    }

    let body: (BackendErrorBody & BackendAnalysisBody) | undefined;
    try {
      body = await response.json() as BackendErrorBody & BackendAnalysisBody;
      console.debug(`[phase4b] response parsed elapsedMs=${Date.now() - requestStartedAt}`);
    } catch (error) {
      throw new LearningAnalysisClientError(
        "ANALYSIS_INVALID_RESPONSE",
        "response",
        "学习整理服务返回了无法解析的结果。",
        errorMessage(error),
      );
    }

    if (!response.ok) {
      const backendCode = body.error?.code;
      const code = typeof backendCode === "string" && ERROR_CODES.has(backendCode as LearningAnalysisErrorCode)
        ? backendCode as LearningAnalysisErrorCode
        : "ANALYSIS_FAILED";
      throw new LearningAnalysisClientError(
        code,
        code === "ANALYSIS_PROVIDER_UNAVAILABLE" || code === "ANALYSIS_TIMEOUT" ? "provider" : "response",
        typeof body.error?.message === "string" && body.error.message
          ? body.error.message
          : "学习整理服务返回失败状态。",
        typeof body.error?.raw_message === "string" ? body.error.raw_message : `HTTP ${response.status}`,
      );
    }

    return parseResult(body, input.sourceSessionId);
  }
}
