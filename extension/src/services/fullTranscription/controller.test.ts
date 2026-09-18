import { describe, expect, it, vi } from "vitest";
import {
  AuthorizedTabStore,
  type SessionStorageLike,
} from "../actionAuthorization";
import { ContentScriptUnavailableError } from "../contentScript/bridge";
import {
  buildFullCaptureStartMessage,
  contentScriptUnavailableError,
  fullStatusMatchesIdentity,
  reduceFullTranscriptionOffscreenEvent,
  resolvePhase4AuthorizedTab,
  shouldAbortForRemovedTab,
} from "./controller";
import type {
  FullTranscriptionOffscreenEvent,
  FullTranscriptionStatus,
} from "./types";

class MemoryStorage implements SessionStorageLike {
  private values: Record<string, unknown> = {};
  async get(): Promise<Record<string, unknown>> { return this.values; }
  async set(items: Record<string, unknown>): Promise<void> { this.values = { ...this.values, ...items }; }
  async remove(key: string): Promise<void> { delete this.values[key]; }
}

describe("Phase 4A target resolution", () => {
  it("uses the last invoked authorized tab rather than another active tab", async () => {
    const store = new AuthorizedTabStore(new MemoryStorage());
    store.saveInMemory({
      id: 808,
      windowId: 12,
      url: "https://www.douyin.com/video/808",
    });
    const getTab = vi.fn(async (tabId: number) => ({
      id: tabId,
      windowId: 12,
      active: true,
      url: "https://www.douyin.com/video/808",
    }));

    const result = await resolvePhase4AuthorizedTab(store, getTab);

    expect(result.ok).toBe(true);
    expect(getTab).toHaveBeenCalledOnce();
    expect(getTab).toHaveBeenCalledWith(808);
    if (result.ok) expect(result.authorization.tabId).toBe(808);
  });

  it("maps a missing receiver to CONTENT_SCRIPT_UNAVAILABLE, never VIDEO_NOT_FOUND", () => {
    const result = contentScriptUnavailableError(new ContentScriptUnavailableError(
      "页面脚本注入后仍无法建立通信。",
      "Could not establish connection. Receiving end does not exist.",
    ));

    expect(result).toEqual({
      code: "CONTENT_SCRIPT_UNAVAILABLE",
      stage: "videoDiscovery",
      message: "无法与抖音页面中的视频控制脚本建立通信。",
      rawMessage: "Could not establish connection. Receiving end does not exist.",
    });
  });
});

const processingStatus: FullTranscriptionStatus = {
  state: "processing",
  sessionId: "full-session-1",
  tabId: 381389381,
  elapsedMs: 185_000,
  durationMs: 185_000,
  progress: 1,
  metadata: {
    platform: "douyin",
    url: "https://www.douyin.com/video/1",
    videoId: "1",
    author: "测试作者",
    caption: "测试文案",
    hashtags: [],
    durationSeconds: 185,
    extractedAt: "2026-09-18T00:00:00.000Z",
  },
};

const completedEvent: FullTranscriptionOffscreenEvent = {
  target: "background",
  type: "FULL_TRANSCRIPTION_OFFSCREEN_EVENT",
  sessionId: "full-session-1",
  status: {
    state: "completed",
    captureResult: {
      mimeType: "audio/webm;codecs=opus",
      audioTrackCount: 1,
      sizeBytes: 123_456,
      durationMs: 185_000,
      tabId: 381389381,
      startedAt: "2026-09-18T00:00:00.000Z",
      endedAt: "2026-09-18T00:03:05.000Z",
    },
    result: {
      text: "完整视频中文逐字稿",
      language: "zh",
      durationSeconds: 185,
    },
  },
};

describe("Phase 4A result association", () => {
  it("passes the full-video session id into audio capture", () => {
    expect(buildFullCaptureStartMessage("full-session-1", 185)).toEqual({
      type: "AUDIO_CAPTURE_START",
      purpose: "full-transcription",
      sessionId: "full-session-1",
      maxDurationMs: 200_000,
    });
  });

  it("reduces an HTTP-success transcript event to completed UI state", () => {
    const result = reduceFullTranscriptionOffscreenEvent(processingStatus, completedEvent);

    expect(result.state).toBe("completed");
    expect(result.result?.transcript).toMatchObject({
      text: "完整视频中文逐字稿",
      language: "zh",
      source: "speech_to_text",
      model: "small",
    });
    expect(result.result?.capture.mimeType).toBe("audio/webm;codecs=opus");
  });

  it("ignores a completed event from a different session", () => {
    const result = reduceFullTranscriptionOffscreenEvent(processingStatus, {
      ...completedEvent,
      sessionId: "audio-session-created-by-mistake",
    });

    expect(result).toBe(processingStatus);
    expect(result.state).toBe("processing");
  });

  it("uses explicit session and tab identity for status reads", () => {
    expect(fullStatusMatchesIdentity(processingStatus, {
      sessionId: "full-session-1",
      tabId: 381389381,
    })).toBe(true);
    expect(fullStatusMatchesIdentity(processingStatus, {
      sessionId: "stale-session",
      tabId: 381389381,
    })).toBe(false);
  });

  it("only aborts the active session when its exact tab is removed", () => {
    expect(shouldAbortForRemovedTab(processingStatus, 381389380)).toBe(false);
    expect(shouldAbortForRemovedTab(processingStatus, 381389381)).toBe(true);
    expect(shouldAbortForRemovedTab({ ...processingStatus, state: "completed" }, 381389381)).toBe(false);
  });
});
