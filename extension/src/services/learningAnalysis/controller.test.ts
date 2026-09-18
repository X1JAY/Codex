import { describe, expect, it, vi } from "vitest";
import { LearningAnalysisClientError, type LearningAnalysisClient } from "./backendClient";
import {
  LearningAnalysisController,
  type LearningAnalysisStorage,
} from "./controller";
import type {
  LearningAnalysisInput,
  LearningAnalysisResult,
  LearningAnalysisStatus,
} from "./types";

class MemoryStorage implements LearningAnalysisStorage {
  values: Record<string, unknown> = {};

  async get(key: string): Promise<Record<string, unknown>> {
    return key in this.values ? { [key]: this.values[key] } : {};
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.values = { ...this.values, ...items };
  }
}

function input(sourceSessionId = "source-1"): LearningAnalysisInput {
  return {
    sourceSessionId,
    tabId: 77,
    metadata: {
      platform: "douyin",
      url: "https://www.douyin.com/video/77",
      hashtags: [],
      durationSeconds: 20,
      extractedAt: "2026-09-18T00:00:00.000Z",
    },
    transcript: "原始逐字稿第一句。第二句。第三句。",
    transcriptLanguage: "zh",
    outputLanguage: "zh",
  };
}

function result(sourceSessionId = "source-1"): LearningAnalysisResult {
  return {
    sourceSessionId,
    cleanedTranscript: "整理稿",
    keyPoints: ["一", "二", "三"],
    structure: [{ title: "开头", summary: "提出主题" }],
    hooks: [],
    notableQuotes: [],
    learningNotes: "学习笔记",
  };
}

describe("LearningAnalysisController", () => {
  it("moves processing to completed and persists an independent status", async () => {
    let resolveAnalysis: ((value: LearningAnalysisResult) => void) | undefined;
    const analyze = vi.fn(() => new Promise<LearningAnalysisResult>((resolve) => {
      resolveAnalysis = resolve;
    }));
    const client: LearningAnalysisClient = { analyze };
    const storage = new MemoryStorage();
    const broadcasts: LearningAnalysisStatus[] = [];
    const controller = new LearningAnalysisController(
      client,
      storage,
      async (status) => { broadcasts.push(status); },
    );

    const pending = controller.start({ type: "LEARNING_ANALYSIS_START", input: input() });
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());
    expect(broadcasts[0]?.state).toBe("processing");
    resolveAnalysis?.(result());

    const response = await pending;
    expect(response.ok).toBe(true);
    expect(response.status?.state).toBe("completed");
    expect(broadcasts.map((status) => status.state)).toEqual(["processing", "completed"]);
    expect(storage.values.learningAnalysisStatus).toEqual(response.status);
  });

  it("returns completed after persistence even when the optional UI broadcast never settles", async () => {
    const storage = new MemoryStorage();
    const broadcast = vi.fn(() => new Promise<void>(() => undefined));
    const controller = new LearningAnalysisController(
      { analyze: async () => result() },
      storage,
      broadcast,
    );

    const response = await controller.start({ type: "LEARNING_ANALYSIS_START", input: input() });

    expect(response.status?.state).toBe("completed");
    expect(storage.values.learningAnalysisStatus).toEqual(response.status);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it("moves processing to error without touching the supplied Phase 4A data", async () => {
    const phase4AInput = input();
    const before = structuredClone(phase4AInput);
    const client: LearningAnalysisClient = {
      analyze: vi.fn(async () => {
        throw new LearningAnalysisClientError(
          "ANALYSIS_PROVIDER_UNAVAILABLE",
          "provider",
          "Provider unavailable",
        );
      }),
    };
    const controller = new LearningAnalysisController(client, new MemoryStorage(), async () => undefined);

    const response = await controller.start({ type: "LEARNING_ANALYSIS_START", input: phase4AInput });

    expect(response.ok).toBe(false);
    expect(response.status).toMatchObject({
      state: "error",
      sourceSessionId: "source-1",
      error: { code: "ANALYSIS_PROVIDER_UNAVAILABLE" },
    });
    expect(phase4AInput).toEqual(before);
  });

  it("restores a completed result when the Side Panel is reopened", async () => {
    const storage = new MemoryStorage();
    const first = new LearningAnalysisController(
      { analyze: async () => result() },
      storage,
      async () => undefined,
    );
    await first.start({ type: "LEARNING_ANALYSIS_START", input: input() });

    const reopened = new LearningAnalysisController(
      { analyze: vi.fn() },
      storage,
      async () => undefined,
    );
    const response = await reopened.getStatus({
      type: "LEARNING_ANALYSIS_GET_STATUS",
      sourceSessionId: "source-1",
      tabId: 77,
    });

    expect(response.status?.state).toBe("completed");
    expect(response.status?.result?.learningNotes).toBe("学习笔记");
  });

  it("rejects a stale completion after the source session changes", async () => {
    let resolveAnalysis: ((value: LearningAnalysisResult) => void) | undefined;
    const analyze = vi.fn(() => new Promise<LearningAnalysisResult>((resolve) => {
      resolveAnalysis = resolve;
    }));
    const controller = new LearningAnalysisController(
      { analyze },
      new MemoryStorage(),
      async () => undefined,
    );
    const oldRequest = controller.start({ type: "LEARNING_ANALYSIS_START", input: input("old") });
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());

    const newStatus = await controller.getStatus({
      type: "LEARNING_ANALYSIS_GET_STATUS",
      sourceSessionId: "new",
      tabId: 78,
    });
    resolveAnalysis?.(result("old"));
    const oldResponse = await oldRequest;

    expect(newStatus.status).toMatchObject({ state: "ready", sourceSessionId: "new" });
    expect(oldResponse).toMatchObject({
      ok: false,
      status: { state: "ready", sourceSessionId: "new" },
      error: { code: "STALE_ANALYSIS_SESSION" },
    });
  });

  it("uses only the text-analysis client and never starts audio capture", async () => {
    const analyze = vi.fn(async () => result());
    const controller = new LearningAnalysisController(
      { analyze },
      new MemoryStorage(),
      async () => undefined,
    );

    await controller.start({ type: "LEARNING_ANALYSIS_START", input: input() });

    expect(analyze).toHaveBeenCalledOnce();
    expect(analyze).toHaveBeenCalledWith(input());
  });
});
