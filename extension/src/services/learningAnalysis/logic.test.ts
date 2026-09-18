import { describe, expect, it } from "vitest";
import type { FullTranscriptionStatus } from "../fullTranscription/types";
import {
  createLearningAnalysisInput,
  formatLearningAnalysisCopy,
} from "./logic";
import type { LearningAnalysisResult } from "./types";

function completedStatus(transcript = "第一句。\n第二句。\n第三句。"): FullTranscriptionStatus {
  return {
    state: "completed",
    sessionId: "full-session-4b",
    tabId: 42,
    elapsedMs: 15_000,
    durationMs: 15_000,
    result: {
      metadata: {
        platform: "douyin",
        url: "https://www.douyin.com/video/42",
        videoId: "42",
        author: "测试作者",
        caption: "原视频文案",
        hashtags: ["学习"],
        durationSeconds: 15,
        extractedAt: "2026-09-18T00:00:00.000Z",
      },
      transcript: {
        text: transcript,
        language: "zh",
        durationSeconds: 15,
        source: "speech_to_text",
        model: "small",
      },
      capture: {
        mimeType: "audio/webm;codecs=opus",
        audioTrackCount: 1,
        sizeBytes: 1024,
        durationMs: 15_000,
        tabId: 42,
        startedAt: "2026-09-18T00:00:00.000Z",
        endedAt: "2026-09-18T00:00:15.000Z",
      },
    },
  };
}

const result: LearningAnalysisResult = {
  sourceSessionId: "full-session-4b",
  cleanedTranscript: "整理后的原文",
  keyPoints: ["观点一", "观点二", "观点三"],
  structure: [{ title: "开头", summary: "提出问题" }],
  hooks: ["问题型钩子"],
  notableQuotes: [],
  learningNotes: "学习笔记正文",
};

describe("Phase 4B input boundary", () => {
  it("does not allow analysis before Phase 4A is completed", () => {
    expect(createLearningAnalysisInput({
      ...completedStatus(),
      state: "processing",
    })).toBeUndefined();
  });

  it("rejects an empty transcript", () => {
    expect(createLearningAnalysisInput(completedStatus("  \n  "))).toBeUndefined();
  });

  it("passes the exact raw transcript without mutating the Phase 4A result", () => {
    const raw = "  原文第一行。\n原文第二行保持不变。  ";
    const status = completedStatus(raw);
    const before = structuredClone(status);

    const input = createLearningAnalysisInput(status);

    expect(input?.transcript).toBe(raw);
    expect(status).toEqual(before);
    expect(input?.metadata).not.toBe(status.result?.metadata);
    expect(input?.metadata.hashtags).not.toBe(status.result?.metadata.hashtags);
  });

  it("keeps multilingual transcript text and requests Chinese analysis output", () => {
    const multilingual = "English opening. 日本語の本文です。 한국어 문장입니다.";

    const input = createLearningAnalysisInput(completedStatus(multilingual));

    expect(input?.transcript).toBe(multilingual);
    expect(input?.outputLanguage).toBe("zh");
  });
});

describe("Phase 4B copy output", () => {
  it("copies cleaned transcript, learning notes, and all six sections independently", () => {
    expect(formatLearningAnalysisCopy(result, "cleanedTranscript")).toBe("整理后的原文");
    expect(formatLearningAnalysisCopy(result, "learningNotes")).toBe("学习笔记正文");
    const all = formatLearningAnalysisCopy(result, "all");
    expect(all).toContain("【整理稿】\n整理后的原文");
    expect(all).toContain("【核心观点】");
    expect(all).toContain("【内容结构】");
    expect(all).toContain("【开头钩子】");
    expect(all).toContain("【金句】\n（未识别到）");
    expect(all).toContain("【学习笔记】\n学习笔记正文");
  });
});
