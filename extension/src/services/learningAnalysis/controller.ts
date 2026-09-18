import {
  BackendLearningAnalysisClient,
  LearningAnalysisClientError,
  type LearningAnalysisClient,
} from "./backendClient";
import {
  LEARNING_ANALYSIS_GET_STATUS,
  LEARNING_ANALYSIS_START,
  LEARNING_ANALYSIS_STATUS,
  LEARNING_ANALYSIS_STORAGE_KEY,
  type LearningAnalysisError,
  type LearningAnalysisGetStatusMessage,
  type LearningAnalysisPanelMessage,
  type LearningAnalysisResponse,
  type LearningAnalysisStartMessage,
  type LearningAnalysisStatus,
} from "./types";

export interface LearningAnalysisStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export type LearningAnalysisBroadcast = (status: LearningAnalysisStatus) => Promise<void>;

function baseStatus(): LearningAnalysisStatus {
  return { state: "idle" };
}

function defaultStorage(): LearningAnalysisStorage {
  return {
    get: (key) => chrome.storage.session.get(key) as Promise<Record<string, unknown>>,
    set: (items) => chrome.storage.session.set(items),
  };
}

function defaultBroadcast(status: LearningAnalysisStatus): Promise<void> {
  return chrome.runtime.sendMessage({
    target: "sidepanel",
    type: LEARNING_ANALYSIS_STATUS,
    status,
  }).then(() => undefined);
}

function normalizedError(error: unknown): LearningAnalysisError {
  if (error instanceof LearningAnalysisClientError) {
    return {
      code: error.code,
      stage: error.stage,
      message: error.message,
      rawMessage: error.rawMessage,
    };
  }
  return {
    code: "ANALYSIS_FAILED",
    stage: "provider",
    message: "生成学习整理时发生未知错误。",
    rawMessage: error instanceof Error ? error.message : String(error),
  };
}

export class LearningAnalysisController {
  private status: LearningAnalysisStatus = baseStatus();
  private readonly client: LearningAnalysisClient;
  private readonly storage: LearningAnalysisStorage;
  private readonly broadcast: LearningAnalysisBroadcast;

  public constructor(
    client: LearningAnalysisClient = new BackendLearningAnalysisClient(),
    storage: LearningAnalysisStorage = defaultStorage(),
    broadcast: LearningAnalysisBroadcast = defaultBroadcast,
  ) {
    this.client = client;
    this.storage = storage;
    this.broadcast = broadcast;
  }

  public register(): void {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!this.isPanelMessage(message)) return false;
      void this.handleMessage(message)
        .then(sendResponse)
        .catch((error: unknown) => {
          const details = normalizedError(error);
          sendResponse({ ok: false, error: details } satisfies LearningAnalysisResponse);
        });
      return true;
    });
  }

  private isPanelMessage(message: unknown): message is LearningAnalysisPanelMessage {
    if (!message || typeof message !== "object") return false;
    const type = (message as { type?: unknown }).type;
    return type === LEARNING_ANALYSIS_START || type === LEARNING_ANALYSIS_GET_STATUS;
  }

  private handleMessage(message: LearningAnalysisPanelMessage): Promise<LearningAnalysisResponse> {
    return message.type === LEARNING_ANALYSIS_START
      ? this.start(message)
      : this.getStatus(message);
  }

  public async start(message: LearningAnalysisStartMessage): Promise<LearningAnalysisResponse> {
    const input = message.input;
    const analysisStartedAt = Date.now();
    console.debug(`[phase4b] analysis started sessionId=${input.sourceSessionId}`);
    if (!input.sourceSessionId || !input.transcript.trim()) {
      return this.fail({
        code: "ANALYSIS_INPUT_EMPTY",
        stage: "input",
        message: "完整逐字稿为空，无法生成学习整理。",
      }, input.sourceSessionId, input.tabId);
    }
    if (this.status.state === "processing" && this.status.sourceSessionId === input.sourceSessionId) {
      const error: LearningAnalysisError = {
        code: "ANALYSIS_FAILED",
        stage: "session",
        message: "当前完整逐字稿正在生成学习整理。",
      };
      return { ok: false, status: this.status, error };
    }

    this.status = {
      state: "processing",
      sourceSessionId: input.sourceSessionId,
      tabId: input.tabId,
    };
    await this.persistAndBroadcast();

    try {
      const result = await this.client.analyze(input);
      if (this.status.sourceSessionId !== input.sourceSessionId || this.status.state !== "processing") {
        return {
          ok: false,
          status: this.status,
          error: {
            code: "STALE_ANALYSIS_SESSION",
            stage: "session",
            message: "旧学习整理结果已丢弃，因为当前视频任务已经改变。",
          },
        };
      }
      if (result.sourceSessionId !== input.sourceSessionId) {
        throw new LearningAnalysisClientError(
          "STALE_ANALYSIS_SESSION",
          "session",
          "学习整理结果不属于当前完整转写任务。",
          `Expected ${input.sourceSessionId}, received ${result.sourceSessionId}`,
        );
      }
      this.status = {
        state: "completed",
        sourceSessionId: input.sourceSessionId,
        tabId: input.tabId,
        result,
      };
      await this.persistAndBroadcast();
      console.debug(`[phase4b] completed persisted elapsedMs=${Date.now() - analysisStartedAt}`);
      return { ok: true, status: this.status };
    } catch (error) {
      if (this.status.sourceSessionId !== input.sourceSessionId || this.status.state !== "processing") {
        return {
          ok: false,
          status: this.status,
          error: {
            code: "STALE_ANALYSIS_SESSION",
            stage: "session",
            message: "旧学习整理错误已丢弃，因为当前视频任务已经改变。",
          },
        };
      }
      return this.fail(normalizedError(error), input.sourceSessionId, input.tabId);
    }
  }

  public async getStatus(message: LearningAnalysisGetStatusMessage): Promise<LearningAnalysisResponse> {
    if (this.status.state === "idle") {
      const stored = await this.storage.get(LEARNING_ANALYSIS_STORAGE_KEY) as {
        [LEARNING_ANALYSIS_STORAGE_KEY]?: LearningAnalysisStatus;
      };
      this.status = stored[LEARNING_ANALYSIS_STORAGE_KEY] ?? this.status;
    }

    if (message.sourceSessionId && this.status.sourceSessionId !== message.sourceSessionId) {
      this.status = {
        state: "ready",
        sourceSessionId: message.sourceSessionId,
        tabId: message.tabId,
      };
      await this.persistAndBroadcast();
    }
    return { ok: true, status: this.status };
  }

  private async fail(
    error: LearningAnalysisError,
    sourceSessionId?: string,
    tabId?: number,
  ): Promise<LearningAnalysisResponse> {
    this.status = { state: "error", sourceSessionId, tabId, error };
    await this.persistAndBroadcast();
    return { ok: false, status: this.status, error };
  }

  private async persistAndBroadcast(): Promise<void> {
    const persistedStatus = this.status;
    await this.storage.set({ [LEARNING_ANALYSIS_STORAGE_KEY]: persistedStatus });
    void this.broadcast(persistedStatus).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.debug(`[learning-analysis] sidepanel status unavailable message=${message}`);
    });
  }
}
