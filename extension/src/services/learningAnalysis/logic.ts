import type { FullTranscriptionStatus } from "../fullTranscription/types";
import type {
  LearningAnalysisInput,
  LearningAnalysisResult,
} from "./types";

export const MAX_ANALYSIS_TRANSCRIPT_CHARS = 50_000;

export type LearningCopyTarget = "cleanedTranscript" | "learningNotes" | "all";

export function createLearningAnalysisInput(
  fullStatus: FullTranscriptionStatus,
): LearningAnalysisInput | undefined {
  const rawTranscript = fullStatus.result?.transcript.text;
  if (fullStatus.state !== "completed" ||
    !fullStatus.sessionId ||
    !fullStatus.result ||
    !rawTranscript?.trim()) {
    return undefined;
  }

  return {
    sourceSessionId: fullStatus.sessionId,
    tabId: fullStatus.tabId,
    metadata: {
      ...fullStatus.result.metadata,
      hashtags: [...fullStatus.result.metadata.hashtags],
    },
    caption: fullStatus.result.metadata.caption,
    transcript: rawTranscript,
    transcriptLanguage: fullStatus.result.transcript.language,
    outputLanguage: "zh",
  };
}

function numbered(values: string[]): string {
  return values.length > 0
    ? values.map((value, index) => `${index + 1}. ${value}`).join("\n")
    : "（未识别到）";
}

export function formatLearningAnalysisCopy(
  result: LearningAnalysisResult,
  target: LearningCopyTarget,
): string {
  if (target === "cleanedTranscript") return result.cleanedTranscript;
  if (target === "learningNotes") return result.learningNotes;

  const structure = result.structure.length > 0
    ? result.structure.map((item, index) => `${index + 1}. ${item.title}：${item.summary}`).join("\n")
    : "（未识别到）";
  return [
    "【整理稿】",
    result.cleanedTranscript,
    "",
    "【核心观点】",
    numbered(result.keyPoints),
    "",
    "【内容结构】",
    structure,
    "",
    "【开头钩子】",
    numbered(result.hooks),
    "",
    "【金句】",
    numbered(result.notableQuotes),
    "",
    "【学习笔记】",
    result.learningNotes,
  ].join("\n");
}
