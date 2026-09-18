import { describe, expect, it } from "vitest";
import {
  calculateFullVideoProgress,
  calculateHardTimeoutMs,
  canTransitionFullTranscription,
  detectLoopReset,
  hasHardTimedOut,
  isVideoIdentityChanged,
  validateVideoDuration,
} from "./logic";

describe("full-video duration and progress", () => {
  it("rejects unavailable and over-limit durations while accepting ten minutes", () => {
    expect(validateVideoDuration(Number.NaN)?.code).toBe("VIDEO_DURATION_UNAVAILABLE");
    expect(validateVideoDuration(Number.POSITIVE_INFINITY)?.code).toBe("VIDEO_DURATION_UNAVAILABLE");
    expect(validateVideoDuration(0)?.code).toBe("VIDEO_DURATION_UNAVAILABLE");
    expect(validateVideoDuration(600)).toBeUndefined();
    expect(validateVideoDuration(600.01)?.code).toBe("VIDEO_TOO_LONG");
  });

  it("calculates bounded elapsed/total progress", () => {
    expect(calculateFullVideoProgress(84.4, 198)).toEqual({
      elapsedMs: 84_400,
      durationMs: 198_000,
      progress: 84.4 / 198,
    });
    expect(calculateFullVideoProgress(250, 198)).toEqual({
      elapsedMs: 198_000,
      durationMs: 198_000,
      progress: 1,
    });
  });
});

describe("full-video safety decisions", () => {
  it("detects a loop reset only after playback reached the end region", () => {
    expect(detectLoopReset(29.7, 0.1, 30)).toBe(true);
    expect(detectLoopReset(10, 0.1, 30)).toBe(false);
    expect(detectLoopReset(29.7, 28, 30)).toBe(false);
  });

  it("adds a bounded hard-timeout tolerance", () => {
    expect(calculateHardTimeoutMs(30)).toBe(40_000);
    expect(hasHardTimedOut(39_999, 30)).toBe(false);
    expect(hasHardTimedOut(40_000, 30)).toBe(true);
  });

  it("detects page, source, and video-id changes", () => {
    const initial = { pageUrl: "https://www.douyin.com/video/1", source: "blob:one", videoId: "1" };
    expect(isVideoIdentityChanged(initial, initial)).toBe(false);
    expect(isVideoIdentityChanged(initial, { ...initial, pageUrl: "https://www.douyin.com/video/2" })).toBe(true);
    expect(isVideoIdentityChanged(initial, { ...initial, source: "blob:two" })).toBe(true);
    expect(isVideoIdentityChanged(initial, { ...initial, videoId: "2" })).toBe(true);
  });
});

describe("full-transcript state machine", () => {
  it("accepts the complete happy path and rejects invalid backwards transitions", () => {
    const path = [
      "idle",
      "readingVideo",
      "preparing",
      "capturing",
      "processing",
      "uploading",
      "transcribing",
      "completed",
    ] as const;
    for (let index = 1; index < path.length; index += 1) {
      expect(canTransitionFullTranscription(path[index - 1], path[index])).toBe(true);
    }
    expect(canTransitionFullTranscription("capturing", "readingVideo")).toBe(false);
    expect(canTransitionFullTranscription("transcribing", "capturing")).toBe(false);
  });

  it("accepts the cancellation cleanup path", () => {
    expect(canTransitionFullTranscription("capturing", "cancelling")).toBe(true);
    expect(canTransitionFullTranscription("cancelling", "cancelled")).toBe(true);
    expect(canTransitionFullTranscription("cancelled", "readingVideo")).toBe(true);
  });
});
