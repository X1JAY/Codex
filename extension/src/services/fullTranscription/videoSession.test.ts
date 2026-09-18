import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FullVideoPlaybackSession,
  type FullVideoSessionPlatform,
} from "./videoSession";

class FakeVideo extends EventTarget {
  duration = 30;
  currentTime = 12;
  paused = false;
  muted = true;
  playbackRate = 1.5;
  loop = true;
  readyState = 4;
  isConnected = true;
  currentSrc = "blob:video-one";
  src = "";
  pause = vi.fn(() => {
    this.paused = true;
  });
  play = vi.fn(async () => {
    this.paused = false;
  });
}

function timerPlatform(): FullVideoSessionPlatform {
  return { setTimeout, clearTimeout, setInterval, clearInterval };
}

function createSession(video: FakeVideo, activeVideo = () => video) {
  const onProgress = vi.fn();
  const onCompleted = vi.fn();
  const onError = vi.fn();
  const session = new FullVideoPlaybackSession({
    video: video as unknown as HTMLVideoElement,
    identity: {
      pageUrl: "https://www.douyin.com/video/1",
      source: video.currentSrc,
      videoId: "1",
    },
    getActiveVideo: () => activeVideo() as unknown as HTMLVideoElement,
    getCurrentIdentity: () => ({
      pageUrl: "https://www.douyin.com/video/1",
      source: video.currentSrc,
      videoId: "1",
    }),
    events: { onProgress, onCompleted, onError },
    platform: timerPlatform(),
  });
  return { session, onProgress, onCompleted, onError };
}

describe("FullVideoPlaybackSession", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("hard-stops with FULL_CAPTURE_TIMEOUT without waiting in real time", async () => {
    const video = new FakeVideo();
    video.duration = 1;
    const { session, onError } = createSession(video);
    await session.prepare();
    await session.start();

    await vi.advanceTimersByTimeAsync(11_000);

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "FULL_CAPTURE_TIMEOUT",
      stage: "monitor",
    }));
    expect(video.pause).toHaveBeenCalled();
  });

  it("halts cleanly and restores the original playback position and attributes", async () => {
    const video = new FakeVideo();
    const { session, onError } = createSession(video);
    await session.prepare();
    expect(video.currentTime).toBe(0);
    expect(video.loop).toBe(false);
    expect(video.muted).toBe(false);
    expect(video.playbackRate).toBe(1);
    await session.start();

    session.halt();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(onError).not.toHaveBeenCalled();

    const warning = await session.restore();
    expect(warning).toBeUndefined();
    expect(video.currentTime).toBe(12);
    expect(video.muted).toBe(true);
    expect(video.playbackRate).toBe(1.5);
    expect(video.loop).toBe(true);
    expect(video.paused).toBe(false);
  });

  it("fails safely when the active video element changes", async () => {
    const video = new FakeVideo();
    const replacement = new FakeVideo();
    let active = video;
    const { session, onError } = createSession(video, () => active);
    await session.prepare();
    await session.start();
    active = replacement;

    await vi.advanceTimersByTimeAsync(250);

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "VIDEO_CHANGED_DURING_CAPTURE",
    }));
  });

  it("stops once when playback reaches the end and does not record a loop", async () => {
    const video = new FakeVideo();
    const { session, onCompleted } = createSession(video);
    await session.prepare();
    await session.start();
    video.currentTime = 29.95;
    video.dispatchEvent(new Event("timeupdate"));
    video.currentTime = 0;
    video.dispatchEvent(new Event("timeupdate"));

    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(onCompleted).toHaveBeenCalledWith(expect.objectContaining({ reason: "near-end" }));
  });
});
