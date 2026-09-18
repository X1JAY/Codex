import type { FullTranscriptResult } from "../fullTranscription/types";

export type LearningAnalysisState = "idle" | "ready" | "processing" | "completed" | "error";

export type LearningAnalysisErrorCode =
  | "ANALYSIS_INPUT_EMPTY"
  | "ANALYSIS_INPUT_TOO_LONG"
  | "ANALYSIS_PROVIDER_UNAVAILABLE"
  | "ANALYSIS_TIMEOUT"
  | "ANALYSIS_INVALID_RESPONSE"
  | "ANALYSIS_FAILED"
  | "STALE_ANALYSIS_SESSION";

export type LearningAnalysisStage = "input" | "backend" | "provider" | "response" | "session";

export interface LearningAnalysisError {
  code: LearningAnalysisErrorCode;
  stage: LearningAnalysisStage;
  message: string;
  rawMessage?: string;
}

export interface LearningAnalysisStructureItem {
  title: string;
  summary: string;
}

export interface LearningAnalysisInput {
  sourceSessionId: string;
  tabId?: number;
  metadata: FullTranscriptResult["metadata"];
  caption?: string;
  transcript: string;
  transcriptLanguage?: string;
  outputLanguage: "zh";
}

export interface LearningAnalysisResult {
  sourceSessionId: string;
  cleanedTranscript: string;
  keyPoints: string[];
  structure: LearningAnalysisStructureItem[];
  hooks: string[];
  notableQuotes: string[];
  learningNotes: string;
}

export interface LearningAnalysisStatus {
  state: LearningAnalysisState;
  sourceSessionId?: string;
  tabId?: number;
  result?: LearningAnalysisResult;
  error?: LearningAnalysisError;
}

export const LEARNING_ANALYSIS_START = "LEARNING_ANALYSIS_START" as const;
export const LEARNING_ANALYSIS_GET_STATUS = "LEARNING_ANALYSIS_GET_STATUS" as const;
export const LEARNING_ANALYSIS_STATUS = "LEARNING_ANALYSIS_STATUS" as const;
export const LEARNING_ANALYSIS_STORAGE_KEY = "learningAnalysisStatus" as const;

export interface LearningAnalysisStartMessage {
  type: typeof LEARNING_ANALYSIS_START;
  input: LearningAnalysisInput;
}

export interface LearningAnalysisGetStatusMessage {
  type: typeof LEARNING_ANALYSIS_GET_STATUS;
  sourceSessionId?: string;
  tabId?: number;
}

export type LearningAnalysisPanelMessage =
  | LearningAnalysisStartMessage
  | LearningAnalysisGetStatusMessage;

export interface LearningAnalysisResponse {
  ok: boolean;
  status?: LearningAnalysisStatus;
  error?: LearningAnalysisError;
}
