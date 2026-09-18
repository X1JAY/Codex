import { useEffect, useMemo, useRef, useState } from "react";
import {
  formatLearningAnalysisCopy,
  createLearningAnalysisInput,
  type LearningCopyTarget,
} from "../services/learningAnalysis/logic";
import {
  LEARNING_ANALYSIS_GET_STATUS,
  type LearningAnalysisPanelMessage,
  type LearningAnalysisResponse,
  type LearningAnalysisResult,
  type LearningAnalysisStatus,
} from "../services/learningAnalysis/types";
import type { FullTranscriptionStatus } from "../services/fullTranscription/types";
import {
  runLearningAnalysis,
  subscribeToLearningAnalysisStatus,
  type LearningAnalysisStatusSource,
} from "./learningAnalysisSync";

type CopyFeedback = "idle" | "copied" | "error";

function sendLearningAnalysisMessage(
  message: LearningAnalysisPanelMessage,
): Promise<LearningAnalysisResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: LearningAnalysisResponse | undefined) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(response ?? {
        ok: false,
        error: {
          code: "ANALYSIS_INVALID_RESPONSE",
          stage: "response",
          message: "学习整理服务没有返回状态。",
        },
      });
    });
  });
}

function statusLabel(status: LearningAnalysisStatus): string {
  if (status.state === "processing") return "PROCESSING";
  if (status.state === "completed") return "COMPLETED";
  if (status.state === "error") return "ERROR";
  if (status.state === "ready") return "READY";
  return "IDLE";
}

function copyLabel(feedback: CopyFeedback, idleLabel: string): string {
  if (feedback === "copied") return "已复制";
  if (feedback === "error") return "复制失败";
  return idleLabel;
}

export function LearningAnalysisResultView({
  result,
  copyFeedback,
  onCopy,
}: {
  result: LearningAnalysisResult;
  copyFeedback: Record<LearningCopyTarget, CopyFeedback>;
  onCopy: (target: LearningCopyTarget) => void;
}) {
  return (
    <div className="analysis-result">
      <section>
        <h3>整理稿</h3>
        <p>{result.cleanedTranscript}</p>
      </section>
      <section>
        <h3>核心观点</h3>
        <ol>{result.keyPoints.map((point, index) => <li key={`${index}-${point}`}>{point}</li>)}</ol>
      </section>
      <section>
        <h3>内容结构</h3>
        <ol>{result.structure.map((item, index) => (
          <li key={`${index}-${item.title}`}><strong>{item.title}</strong><span>{item.summary}</span></li>
        ))}</ol>
      </section>
      <section>
        <h3>开头钩子</h3>
        {result.hooks.length > 0
          ? <ul>{result.hooks.map((hook, index) => <li key={`${index}-${hook}`}>{hook}</li>)}</ul>
          : <p className="analysis-empty">未识别到明确开头钩子。</p>}
      </section>
      <section>
        <h3>金句</h3>
        {result.notableQuotes.length > 0
          ? <ul>{result.notableQuotes.map((quote, index) => <li key={`${index}-${quote}`}>{quote}</li>)}</ul>
          : <p className="analysis-empty">没有提取到明确金句。</p>}
      </section>
      <section>
        <h3>学习笔记</h3>
        <p>{result.learningNotes}</p>
      </section>
      <div className="analysis-copy-grid">
        <button className="copy-button" onClick={() => onCopy("cleanedTranscript")}>
          {copyLabel(copyFeedback.cleanedTranscript, "复制整理稿")}
        </button>
        <button className="copy-button" onClick={() => onCopy("learningNotes")}>
          {copyLabel(copyFeedback.learningNotes, "复制学习笔记")}
        </button>
        <button className="copy-button" onClick={() => onCopy("all")}>
          {copyLabel(copyFeedback.all, "复制全部学习内容")}
        </button>
      </div>
    </div>
  );
}

export function LearningAnalysisPanel({ fullStatus }: { fullStatus: FullTranscriptionStatus }) {
  const input = useMemo(() => createLearningAnalysisInput(fullStatus), [fullStatus]);
  const sourceSessionId = input?.sourceSessionId;
  const [status, setStatus] = useState<LearningAnalysisStatus>({ state: "idle" });
  const [copyFeedback, setCopyFeedback] = useState<Record<LearningCopyTarget, CopyFeedback>>({
    cleanedTranscript: "idle",
    learningNotes: "idle",
    all: "idle",
  });
  const analysisStartedAtRef = useRef<number | undefined>(undefined);
  const terminalStatusLogRef = useRef<string | undefined>(undefined);

  function applyStatusToUi(
    nextStatus: LearningAnalysisStatus,
    source: LearningAnalysisStatusSource,
  ): void {
    if (sourceSessionId && nextStatus.sourceSessionId !== sourceSessionId) return;
    setStatus(nextStatus);
    if (nextStatus.state === "completed" || nextStatus.state === "error") {
      const marker = `${nextStatus.sourceSessionId ?? "none"}:${nextStatus.state}`;
      if (terminalStatusLogRef.current !== marker) {
        terminalStatusLogRef.current = marker;
        const elapsedMs = analysisStartedAtRef.current === undefined
          ? 0
          : Date.now() - analysisStartedAtRef.current;
        console.debug(
          `[phase4b] ui status applied=${nextStatus.state} elapsedMs=${elapsedMs} source=${source}`,
        );
      }
    }
  }

  useEffect(() => {
    if (!sourceSessionId) return undefined;
    return subscribeToLearningAnalysisStatus({
      sourceSessionId,
      applyStatus: applyStatusToUi,
      addRuntimeListener: (listener) => chrome.runtime.onMessage.addListener(listener),
      removeRuntimeListener: (listener) => chrome.runtime.onMessage.removeListener(listener),
      addStorageListener: (listener) => chrome.storage.onChanged.addListener(listener),
      removeStorageListener: (listener) => chrome.storage.onChanged.removeListener(listener),
    });
  }, [sourceSessionId]);

  useEffect(() => {
    let cancelled = false;
    setCopyFeedback({ cleanedTranscript: "idle", learningNotes: "idle", all: "idle" });
    if (!input) {
      setStatus({ state: "idle" });
      return () => { cancelled = true; };
    }

    setStatus((current) => current.sourceSessionId === input.sourceSessionId
      ? current
      : { state: "ready", sourceSessionId: input.sourceSessionId, tabId: input.tabId });
    void sendLearningAnalysisMessage({
      type: LEARNING_ANALYSIS_GET_STATUS,
      sourceSessionId: input.sourceSessionId,
      tabId: input.tabId,
    }).then((response) => {
      if (!cancelled && response.status?.sourceSessionId === input.sourceSessionId) {
        applyStatusToUi(response.status, "response");
      }
    }).catch((error: unknown) => {
      if (!cancelled) {
        console.debug("[learning-analysis] stored status unavailable", error);
      }
    });
    return () => { cancelled = true; };
  }, [input?.sourceSessionId, input?.tabId]);

  if (fullStatus.state !== "completed") return null;

  const visibleStatus = input && status.sourceSessionId === input.sourceSessionId
    ? status
    : { state: input ? "ready" : "idle" } satisfies LearningAnalysisStatus;
  const result = visibleStatus.state === "completed" ? visibleStatus.result : undefined;
  const isProcessing = visibleStatus.state === "processing";

  async function handleStart() {
    if (!input || isProcessing) return;
    setCopyFeedback({ cleanedTranscript: "idle", learningNotes: "idle", all: "idle" });
    analysisStartedAtRef.current = Date.now();
    terminalStatusLogRef.current = undefined;
    await runLearningAnalysis({
      input,
      sendMessage: sendLearningAnalysisMessage,
      applyStatus: applyStatusToUi,
    });
  }

  async function handleCopy(target: LearningCopyTarget) {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(formatLearningAnalysisCopy(result, target));
      setCopyFeedback((current) => ({ ...current, [target]: "copied" }));
    } catch (error) {
      console.error("[learning-analysis] clipboard write failed", error);
      setCopyFeedback((current) => ({ ...current, [target]: "error" }));
    }
  }

  return (
    <section className="learning-analysis-card">
      <div className="section-heading">
        <div>
          <p className="eyebrow">PHASE 4B · LEARNING</p>
          <h2>学习整理</h2>
        </div>
        <span className={`capture-badge analysis-${visibleStatus.state}`}>
          {statusLabel(visibleStatus)}
        </span>
      </div>
      <p className="analysis-help">
        基于 Phase 4A 的完整原始逐字稿生成独立学习整理；不会重新捕获音频或覆盖原文。
      </p>

      {!input ? (
        <p className="analysis-unavailable">完整逐字稿为空，当前不能生成学习整理。</p>
      ) : null}

      {isProcessing ? (
        <p className="analysis-progress" role="status">正在整理完整逐字稿…</p>
      ) : null}

      {visibleStatus.state === "error" && visibleStatus.error ? (
        <div className="analysis-error" role="alert">
          <strong>学习整理失败</strong>
          <span>阶段：{visibleStatus.error.stage}</span>
          <span>错误码：{visibleStatus.error.code}</span>
          <span>{visibleStatus.error.message}</span>
          {visibleStatus.error.rawMessage ? <code>{visibleStatus.error.rawMessage}</code> : null}
        </div>
      ) : null}

      {result ? (
        <LearningAnalysisResultView
          result={result}
          copyFeedback={copyFeedback}
          onCopy={(target) => void handleCopy(target)}
        />
      ) : null}

      <button
        className="primary-button learning-analysis-button"
        onClick={() => void handleStart()}
        disabled={!input || isProcessing}
      >
        {isProcessing ? "正在整理完整逐字稿…" : result ? "重新生成学习整理" : "生成学习整理"}
      </button>
    </section>
  );
}
