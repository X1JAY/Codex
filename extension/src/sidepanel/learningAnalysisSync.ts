import {
  LEARNING_ANALYSIS_START,
  LEARNING_ANALYSIS_STATUS,
  LEARNING_ANALYSIS_STORAGE_KEY,
  type LearningAnalysisError,
  type LearningAnalysisInput,
  type LearningAnalysisResponse,
  type LearningAnalysisStatus,
} from "../services/learningAnalysis/types";

export type LearningAnalysisStatusSource = "local" | "response" | "runtime" | "storage";
export type LearningAnalysisStatusApplier = (
  status: LearningAnalysisStatus,
  source: LearningAnalysisStatusSource,
) => void;

export type LearningAnalysisRuntimeListener = (message: unknown) => void;
export type LearningAnalysisStorageListener = (
  changes: Record<string, { newValue?: unknown }>,
  areaName: string,
) => void;

interface LearningAnalysisSubscriptionOptions {
  sourceSessionId: string;
  applyStatus: LearningAnalysisStatusApplier;
  addRuntimeListener: (listener: LearningAnalysisRuntimeListener) => void;
  removeRuntimeListener: (listener: LearningAnalysisRuntimeListener) => void;
  addStorageListener: (listener: LearningAnalysisStorageListener) => void;
  removeStorageListener: (listener: LearningAnalysisStorageListener) => void;
}

interface RunLearningAnalysisOptions {
  input: LearningAnalysisInput;
  sendMessage: (message: {
    type: typeof LEARNING_ANALYSIS_START;
    input: LearningAnalysisInput;
  }) => Promise<LearningAnalysisResponse>;
  applyStatus: LearningAnalysisStatusApplier;
}

const STATES = new Set(["idle", "ready", "processing", "completed", "error"]);

function isLearningAnalysisStatus(value: unknown): value is LearningAnalysisStatus {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { state?: unknown; sourceSessionId?: unknown };
  return typeof candidate.state === "string" && STATES.has(candidate.state) &&
    (candidate.sourceSessionId === undefined || typeof candidate.sourceSessionId === "string");
}

function statusMatchesSource(
  status: LearningAnalysisStatus,
  sourceSessionId: string,
): boolean {
  return status.sourceSessionId === sourceSessionId;
}

export function subscribeToLearningAnalysisStatus({
  sourceSessionId,
  applyStatus,
  addRuntimeListener,
  removeRuntimeListener,
  addStorageListener,
  removeStorageListener,
}: LearningAnalysisSubscriptionOptions): () => void {
  const runtimeListener: LearningAnalysisRuntimeListener = (message) => {
    if (!message || typeof message !== "object") return;
    const value = message as { target?: unknown; type?: unknown; status?: unknown };
    if (value.target !== "sidepanel" || value.type !== LEARNING_ANALYSIS_STATUS ||
      !isLearningAnalysisStatus(value.status) || !statusMatchesSource(value.status, sourceSessionId)) {
      return;
    }
    applyStatus(value.status, "runtime");
  };

  const storageListener: LearningAnalysisStorageListener = (changes, areaName) => {
    if (areaName !== "session") return;
    const value = changes[LEARNING_ANALYSIS_STORAGE_KEY]?.newValue;
    if (!isLearningAnalysisStatus(value) || !statusMatchesSource(value, sourceSessionId)) return;
    applyStatus(value, "storage");
  };

  addRuntimeListener(runtimeListener);
  addStorageListener(storageListener);
  return () => {
    removeRuntimeListener(runtimeListener);
    removeStorageListener(storageListener);
  };
}

function responseErrorStatus(
  input: LearningAnalysisInput,
  error: LearningAnalysisError,
): LearningAnalysisStatus {
  return {
    state: "error",
    sourceSessionId: input.sourceSessionId,
    tabId: input.tabId,
    error,
  };
}

export async function runLearningAnalysis({
  input,
  sendMessage,
  applyStatus,
}: RunLearningAnalysisOptions): Promise<LearningAnalysisStatus> {
  const processing: LearningAnalysisStatus = {
    state: "processing",
    sourceSessionId: input.sourceSessionId,
    tabId: input.tabId,
  };
  applyStatus(processing, "local");

  let finalStatus: LearningAnalysisStatus;
  try {
    const response = await sendMessage({ type: LEARNING_ANALYSIS_START, input });
    if (response.status?.sourceSessionId === input.sourceSessionId) {
      finalStatus = response.status;
    } else if (response.error) {
      finalStatus = responseErrorStatus(input, response.error);
    } else {
      finalStatus = responseErrorStatus(input, {
        code: response.status ? "STALE_ANALYSIS_SESSION" : "ANALYSIS_INVALID_RESPONSE",
        stage: response.status ? "session" : "response",
        message: response.status
          ? "学习整理结果不属于当前完整转写任务。"
          : "学习整理服务没有返回最终状态。",
      });
    }
  } catch (error) {
    finalStatus = responseErrorStatus(input, {
      code: "ANALYSIS_PROVIDER_UNAVAILABLE",
      stage: "backend",
      message: "无法连接扩展学习整理服务。",
      rawMessage: error instanceof Error ? error.message : String(error),
    });
  }

  applyStatus(finalStatus, "response");
  return finalStatus;
}
