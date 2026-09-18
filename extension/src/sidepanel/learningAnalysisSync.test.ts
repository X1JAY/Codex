import { describe, expect, it, vi } from "vitest";
import type {
  LearningAnalysisInput,
  LearningAnalysisResult,
  LearningAnalysisStatus,
} from "../services/learningAnalysis/types";
import {
  runLearningAnalysis,
  subscribeToLearningAnalysisStatus,
  type LearningAnalysisRuntimeListener,
  type LearningAnalysisStorageListener,
} from "./learningAnalysisSync";

class RuntimeEvents {
  listeners = new Set<LearningAnalysisRuntimeListener>();
  add = (listener: LearningAnalysisRuntimeListener) => { this.listeners.add(listener); };
  remove = (listener: LearningAnalysisRuntimeListener) => { this.listeners.delete(listener); };
  emit(message: unknown) { for (const listener of this.listeners) listener(message); }
}

class StorageEvents {
  listeners = new Set<LearningAnalysisStorageListener>();
  add = (listener: LearningAnalysisStorageListener) => { this.listeners.add(listener); };
  remove = (listener: LearningAnalysisStorageListener) => { this.listeners.delete(listener); };
  emit(newValue: unknown, areaName = "session") {
    const changes = { learningAnalysisStatus: { newValue } };
    for (const listener of this.listeners) listener(changes, areaName);
  }
}

function input(sourceSessionId = "source-live"): LearningAnalysisInput {
  return {
    sourceSessionId,
    tabId: 91,
    metadata: {
      platform: "douyin",
      url: "https://www.douyin.com/video/91",
      hashtags: [],
      durationSeconds: 86,
      extractedAt: "2026-09-18T00:00:00.000Z",
    },
    transcript: "第一句。第二句。第三句。",
    transcriptLanguage: "zh",
    outputLanguage: "zh",
  };
}

function result(sourceSessionId = "source-live"): LearningAnalysisResult {
  return {
    sourceSessionId,
    cleanedTranscript: "整理稿",
    keyPoints: ["一", "二", "三"],
    structure: [{ title: "开头", summary: "摘要" }],
    hooks: [],
    notableQuotes: [],
    learningNotes: "学习笔记",
  };
}

function completed(sourceSessionId = "source-live"): LearningAnalysisStatus {
  return {
    state: "completed",
    sourceSessionId,
    tabId: 91,
    result: result(sourceSessionId),
  };
}

describe("live Phase 4B UI synchronization", () => {
  it("applies a completed storage.session change without remounting", () => {
    const runtime = new RuntimeEvents();
    const storage = new StorageEvents();
    const applied: LearningAnalysisStatus[] = [];
    const cleanup = subscribeToLearningAnalysisStatus({
      sourceSessionId: "source-live",
      applyStatus: (status) => applied.push(status),
      addRuntimeListener: runtime.add,
      removeRuntimeListener: runtime.remove,
      addStorageListener: storage.add,
      removeStorageListener: storage.remove,
    });

    storage.emit(completed());

    expect(applied).toEqual([completed()]);
    cleanup();
  });

  it("applies current-session runtime errors immediately", () => {
    const runtime = new RuntimeEvents();
    const storage = new StorageEvents();
    const applied: LearningAnalysisStatus[] = [];
    const cleanup = subscribeToLearningAnalysisStatus({
      sourceSessionId: "source-live",
      applyStatus: (status) => applied.push(status),
      addRuntimeListener: runtime.add,
      removeRuntimeListener: runtime.remove,
      addStorageListener: storage.add,
      removeStorageListener: storage.remove,
    });
    const errorStatus: LearningAnalysisStatus = {
      state: "error",
      sourceSessionId: "source-live",
      error: { code: "ANALYSIS_FAILED", stage: "provider", message: "失败" },
    };

    runtime.emit({ target: "sidepanel", type: "LEARNING_ANALYSIS_STATUS", status: errorStatus });

    expect(applied).toEqual([errorStatus]);
    cleanup();
  });

  it("ignores stale sessions and non-session storage areas", () => {
    const runtime = new RuntimeEvents();
    const storage = new StorageEvents();
    const applyStatus = vi.fn();
    const cleanup = subscribeToLearningAnalysisStatus({
      sourceSessionId: "source-live",
      applyStatus,
      addRuntimeListener: runtime.add,
      removeRuntimeListener: runtime.remove,
      addStorageListener: storage.add,
      removeStorageListener: storage.remove,
    });

    storage.emit(completed("stale-source"));
    storage.emit(completed(), "local");
    runtime.emit({
      target: "sidepanel",
      type: "LEARNING_ANALYSIS_STATUS",
      status: completed("stale-source"),
    });

    expect(applyStatus).not.toHaveBeenCalled();
    cleanup();
  });

  it("removes both listeners during component cleanup", () => {
    const runtime = new RuntimeEvents();
    const storage = new StorageEvents();
    const applyStatus = vi.fn();
    const cleanup = subscribeToLearningAnalysisStatus({
      sourceSessionId: "source-live",
      applyStatus,
      addRuntimeListener: runtime.add,
      removeRuntimeListener: runtime.remove,
      addStorageListener: storage.add,
      removeStorageListener: storage.remove,
    });

    expect(runtime.listeners.size).toBe(1);
    expect(storage.listeners.size).toBe(1);
    cleanup();
    expect(runtime.listeners.size).toBe(0);
    expect(storage.listeners.size).toBe(0);
    storage.emit(completed());
    expect(applyStatus).not.toHaveBeenCalled();
  });
});

describe("runLearningAnalysis", () => {
  it("updates the current UI from processing to completed after one response", async () => {
    const statuses: LearningAnalysisStatus[] = [];
    const sendMessage = vi.fn(async () => ({ ok: true, status: completed() }));

    const pending = runLearningAnalysis({
      input: input(),
      sendMessage,
      applyStatus: (status) => { statuses.push(status); },
    });

    expect(statuses).toEqual([expect.objectContaining({ state: "processing" })]);
    const finalStatus = await pending;
    expect(finalStatus.state).toBe("completed");
    expect(statuses.map((status) => status.state)).toEqual(["processing", "completed"]);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("updates the current UI from processing to error without remounting", async () => {
    const statuses: LearningAnalysisStatus[] = [];

    const finalStatus = await runLearningAnalysis({
      input: input(),
      sendMessage: vi.fn().mockRejectedValue(new Error("message channel failed")),
      applyStatus: (status) => { statuses.push(status); },
    });

    expect(finalStatus).toMatchObject({
      state: "error",
      error: { code: "ANALYSIS_PROVIDER_UNAVAILABLE" },
    });
    expect(statuses.map((status) => status.state)).toEqual(["processing", "error"]);
  });
});
