import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LearningAnalysisResult } from "../services/learningAnalysis/types";
import { LearningAnalysisResultView } from "./LearningAnalysisPanel";

const result: LearningAnalysisResult = {
  sourceSessionId: "session-ui",
  cleanedTranscript: "整理稿正文",
  keyPoints: ["观点一", "观点二", "观点三"],
  structure: [{ title: "开头", summary: "提出问题" }],
  hooks: ["问题型钩子"],
  notableQuotes: ["值得记录的原话"],
  learningNotes: "学习笔记正文",
};

describe("LearningAnalysisResultView", () => {
  it("renders all six result sections and three copy actions", () => {
    const html = renderToStaticMarkup(
      <LearningAnalysisResultView
        result={result}
        copyFeedback={{ cleanedTranscript: "idle", learningNotes: "idle", all: "idle" }}
        onCopy={vi.fn()}
      />,
    );

    for (const heading of ["整理稿", "核心观点", "内容结构", "开头钩子", "金句", "学习笔记"]) {
      expect(html).toContain(`<h3>${heading}</h3>`);
    }
    expect(html).toContain("复制整理稿");
    expect(html).toContain("复制学习笔记");
    expect(html).toContain("复制全部学习内容");
    expect(html).toContain("整理稿正文");
    expect(html).toContain("学习笔记正文");
  });
});
