import { describe, expect, it, vi } from "vitest";
import {
  BackendLearningAnalysisClient,
  LearningAnalysisClientError,
} from "./backendClient";
import { MAX_ANALYSIS_TRANSCRIPT_CHARS } from "./logic";
import type { LearningAnalysisInput } from "./types";

function input(transcript = "第一句。第二句。第三句。"): LearningAnalysisInput {
  return {
    sourceSessionId: "source-session-1",
    tabId: 10,
    metadata: {
      platform: "douyin",
      url: "https://www.douyin.com/video/10",
      hashtags: [],
      durationSeconds: 10,
      extractedAt: "2026-09-18T00:00:00.000Z",
    },
    caption: "文案",
    transcript,
    transcriptLanguage: "zh",
    outputLanguage: "zh",
  };
}

function responseBody(overrides: Record<string, unknown> = {}) {
  return {
    sourceSessionId: "source-session-1",
    cleanedTranscript: "第一句。第二句。第三句。",
    keyPoints: ["一", "二", "三"],
    structure: [{ title: "开头", summary: "第一句" }],
    hooks: [],
    notableQuotes: [],
    learningNotes: "学习记录",
    ...overrides,
  };
}

describe("BackendLearningAnalysisClient", () => {
  it("calls only /api/analyze with the unmodified transcript", async () => {
    const raw = "  English. 日本語。 한국어.  ";
    const fetchMock = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response(JSON.stringify(responseBody({
        cleanedTranscript: raw.trim(),
      })), { status: 200 }));
    });
    const client = new BackendLearningAnalysisClient(
      "http://127.0.0.1:8787",
      fetchMock as typeof fetch,
    );

    await client.analyze(input(raw));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/analyze");
    expect(url).not.toContain("/api/transcribe");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.transcript).toBe(raw);
    expect(body.sessionId).toBe("source-session-1");
  });

  it("logs response timing without logging transcript content", async () => {
    const raw = "不得写入日志的逐字稿正文。第二句。第三句。";
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(responseBody()), {
      status: 200,
    }));
    const client = new BackendLearningAnalysisClient("http://local", fetchMock as typeof fetch);

    await client.analyze(input(raw));

    const messages = debug.mock.calls.map(([message]) => String(message));
    expect(messages.some((message) => message.startsWith("[phase4b] response received status=200 elapsedMs="))).toBe(true);
    expect(messages.some((message) => message.startsWith("[phase4b] response parsed elapsedMs="))).toBe(true);
    expect(messages.join("\n")).not.toContain(raw);
    debug.mockRestore();
  });

  it("rejects empty and over-limit input before fetch without truncation", async () => {
    const fetchMock = vi.fn();
    const client = new BackendLearningAnalysisClient(
      "http://127.0.0.1:8787",
      fetchMock as typeof fetch,
    );

    await expect(client.analyze(input("   "))).rejects.toMatchObject({
      code: "ANALYSIS_INPUT_EMPTY",
    });
    const longTranscript = "字".repeat(MAX_ANALYSIS_TRANSCRIPT_CHARS + 1);
    await expect(client.analyze(input(longTranscript))).rejects.toMatchObject({
      code: "ANALYSIS_INPUT_TOO_LONG",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid response shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(responseBody({
      keyPoints: ["只有一条"],
    })), { status: 200 }));
    const client = new BackendLearningAnalysisClient("http://local", fetchMock as typeof fetch);

    await expect(client.analyze(input())).rejects.toMatchObject({
      code: "ANALYSIS_INVALID_RESPONSE",
      stage: "response",
    });
  });

  it("rejects a response from a stale source session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(responseBody({
      sourceSessionId: "older-session",
    })), { status: 200 }));
    const client = new BackendLearningAnalysisClient("http://local", fetchMock as typeof fetch);

    await expect(client.analyze(input())).rejects.toMatchObject({
      code: "STALE_ANALYSIS_SESSION",
      stage: "session",
    });
  });

  it("maps backend provider errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: "ANALYSIS_PROVIDER_UNAVAILABLE",
        message: "Provider unavailable",
        raw_message: "mock disabled",
      },
    }), { status: 503 }));
    const client = new BackendLearningAnalysisClient("http://local", fetchMock as typeof fetch);

    await expect(client.analyze(input())).rejects.toEqual(
      expect.objectContaining<Partial<LearningAnalysisClientError>>({
        code: "ANALYSIS_PROVIDER_UNAVAILABLE",
        stage: "provider",
        rawMessage: "mock disabled",
      }),
    );
  });

  it("aborts and reports a timeout", async () => {
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      })
    ));
    const client = new BackendLearningAnalysisClient(
      "http://local",
      fetchMock as typeof fetch,
      5,
    );

    await expect(client.analyze(input())).rejects.toMatchObject({
      code: "ANALYSIS_TIMEOUT",
      stage: "provider",
    });
  });
});
