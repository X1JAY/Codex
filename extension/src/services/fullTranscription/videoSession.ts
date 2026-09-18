import {
  calculateFullVideoProgress,
  calculateHardTimeoutMs,
  detectLoopReset,
  isNearVideoEnd,
  isVideoIdentityChanged,
  validateVideoDuration,
} from "./logic";
import type {
  FullTranscriptionError,
  FullVideoCompletionReason,
  FullVideoIdentity,
  VideoPlaybackState,
} from "./types";

const SEEK_TIMEOUT_MS = 5_000;
const MONITOR_INTERVAL_MS = 250;

export interface FullVideoSessionEvents {
  onProgress: (progress: { elapsedMs: number; durationMs: number; progress: number }) => void;
  onCompleted: (details: {
    elapsedMs: number;
    durationMs: number;
    reason: FullVideoCompletionReason;
  }) => void;
  onError: (error: FullTranscriptionError) => void;
}

export interface FullVideoSessionPlatform {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

const defaultPlatform: FullVideoSessionPlatform = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
};

export class FullVideoSessionError extends Error {
  public constructor(public readonly details: FullTranscriptionError) {
    super(details.message);
    this.name = "FullVideoSessionError";
  }
}

function rawError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function capturePlaybackState(video: HTMLVideoElement): VideoPlaybackState {
  return {
    duration: video.duration,
    currentTime: video.currentTime,
    paused: video.paused,
    muted: video.muted,
    playbackRate: video.playbackRate,
    loop: video.loop,
  };
}

export function videoSource(video: HTMLVideoElement): string {
  return video.currentSrc || video.src || "";
}

export async function seekVideoTo(
  video: HTMLVideoElement,
  targetSeconds: number,
  platform: FullVideoSessionPlatform = defaultPlatform,
  timeoutMs = SEEK_TIMEOUT_MS,
): Promise<void> {
  if (!Number.isFinite(targetSeconds) || targetSeconds < 0) {
    throw new Error(`Invalid seek target: ${String(targetSeconds)}`);
  }
  if (Math.abs(video.currentTime - targetSeconds) <= 0.08 && video.readyState >= 2) return;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      platform.clearTimeout(timer);
      video.removeEventListener("seeked", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("error", onError);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onReady = () => {
      if (Math.abs(video.currentTime - targetSeconds) <= 0.15 && video.readyState >= 2) {
        finish(resolve);
      }
    };
    const onError = () => finish(() => reject(new Error("Video emitted an error while seeking.")));
    const timer = platform.setTimeout(
      () => finish(() => reject(new Error(`Seek timed out after ${timeoutMs}ms.`))),
      timeoutMs,
    );

    video.addEventListener("seeked", onReady);
    video.addEventListener("canplay", onReady);
    video.addEventListener("error", onError);
    try {
      video.currentTime = targetSeconds;
      onReady();
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

export interface FullVideoPlaybackSessionOptions {
  video: HTMLVideoElement;
  identity: FullVideoIdentity;
  getActiveVideo: () => HTMLVideoElement | undefined;
  getCurrentIdentity: () => FullVideoIdentity;
  events: FullVideoSessionEvents;
  platform?: FullVideoSessionPlatform;
}

export class FullVideoPlaybackSession {
  private readonly video: HTMLVideoElement;
  private readonly identity: FullVideoIdentity;
  private readonly getActiveVideo: () => HTMLVideoElement | undefined;
  private readonly getCurrentIdentity: () => FullVideoIdentity;
  private readonly events: FullVideoSessionEvents;
  private readonly platform: FullVideoSessionPlatform;
  private readonly playbackState: VideoPlaybackState;
  private monitorTimer?: ReturnType<typeof setInterval>;
  private hardTimeout?: ReturnType<typeof setTimeout>;
  private prepared = false;
  private started = false;
  private terminal = false;
  private previousCurrentTime = 0;
  private lastProgressElapsedMs = -1;

  public constructor(options: FullVideoPlaybackSessionOptions) {
    this.video = options.video;
    this.identity = options.identity;
    this.getActiveVideo = options.getActiveVideo;
    this.getCurrentIdentity = options.getCurrentIdentity;
    this.events = options.events;
    this.platform = options.platform ?? defaultPlatform;
    this.playbackState = capturePlaybackState(options.video);
  }

  public get originalPlaybackState(): VideoPlaybackState {
    return { ...this.playbackState };
  }

  public async prepare(): Promise<number> {
    const durationError = validateVideoDuration(this.playbackState.duration);
    if (durationError) throw new FullVideoSessionError(durationError);

    this.video.pause();
    this.video.loop = false;
    this.video.muted = false;
    this.video.playbackRate = 1;
    try {
      await seekVideoTo(this.video, 0, this.platform);
    } catch (error) {
      throw new FullVideoSessionError({
        code: "VIDEO_SEEK_FAILED",
        stage: "seek",
        message: "无法把当前视频定位到开头。",
        rawMessage: rawError(error),
      });
    }
    this.prepared = true;
    this.previousCurrentTime = this.video.currentTime;
    return this.video.currentTime;
  }

  public async start(): Promise<void> {
    if (!this.prepared) {
      throw new FullVideoSessionError({
        code: "VIDEO_SEEK_FAILED",
        stage: "seek",
        message: "完整视频尚未准备完成。",
      });
    }
    if (this.started) return;

    this.started = true;
    this.terminal = false;
    this.video.addEventListener("ended", this.handleEnded);
    this.video.addEventListener("timeupdate", this.handleTimeUpdate);
    this.monitorTimer = this.platform.setInterval(this.inspectPlayback, MONITOR_INTERVAL_MS);
    this.hardTimeout = this.platform.setTimeout(
      () => this.fail({
        code: "FULL_CAPTURE_TIMEOUT",
        stage: "monitor",
        message: "完整视频捕获超过安全时限，已停止。",
        rawMessage: `hardTimeoutMs=${calculateHardTimeoutMs(this.playbackState.duration)}`,
      }),
      calculateHardTimeoutMs(this.playbackState.duration),
    );

    try {
      await this.video.play();
      this.inspectPlayback();
    } catch (error) {
      this.cleanupMonitoring();
      this.video.pause();
      this.terminal = true;
      throw new FullVideoSessionError({
        code: "VIDEO_PLAY_FAILED",
        stage: "playback",
        message: "无法从开头播放当前视频。",
        rawMessage: rawError(error),
      });
    }
  }

  public halt(): void {
    this.terminal = true;
    this.cleanupMonitoring();
    this.video.pause();
  }

  public async restore(): Promise<string | undefined> {
    this.cleanupMonitoring();
    if (!this.video.isConnected) {
      return "原视频元素已离开页面，无法恢复原播放状态。";
    }
    this.video.pause();
    const warnings: string[] = [];

    try {
      this.video.muted = this.playbackState.muted;
      this.video.playbackRate = this.playbackState.playbackRate;
      this.video.loop = this.playbackState.loop;
    } catch (error) {
      warnings.push(`播放属性恢复失败：${rawError(error)}`);
    }

    try {
      await seekVideoTo(this.video, this.playbackState.currentTime, this.platform);
    } catch (error) {
      warnings.push(`播放位置恢复失败：${rawError(error)}`);
    }

    if (this.playbackState.paused) {
      this.video.pause();
    } else {
      try {
        await this.video.play();
      } catch (error) {
        warnings.push(`播放状态恢复失败：${rawError(error)}`);
      }
    }
    return warnings.length > 0 ? warnings.join("；") : undefined;
  }

  private readonly handleEnded = () => {
    this.finish("ended");
  };

  private readonly handleTimeUpdate = () => {
    this.inspectPlayback();
  };

  private readonly inspectPlayback = () => {
    if (this.terminal) return;
    if (!this.video.isConnected || this.getActiveVideo() !== this.video) {
      this.fail({
        code: "VIDEO_CHANGED_DURING_CAPTURE",
        stage: "monitor",
        message: "录制期间当前抖音视频发生了切换。",
      });
      return;
    }

    const currentIdentity = this.getCurrentIdentity();
    if (isVideoIdentityChanged(this.identity, currentIdentity) ||
      Math.abs(this.video.duration - this.playbackState.duration) > 0.5) {
      this.fail({
        code: "VIDEO_CHANGED_DURING_CAPTURE",
        stage: "monitor",
        message: "录制期间视频来源或页面发生了变化。",
      });
      return;
    }

    const currentTime = this.video.currentTime;
    if (detectLoopReset(this.previousCurrentTime, currentTime, this.playbackState.duration)) {
      this.finish("loop-reset");
      return;
    }
    if (isNearVideoEnd(currentTime, this.playbackState.duration)) {
      this.finish("near-end");
      return;
    }

    this.previousCurrentTime = Math.max(this.previousCurrentTime, currentTime);
    const progress = calculateFullVideoProgress(currentTime, this.playbackState.duration);
    if (progress.elapsedMs === 0 || progress.elapsedMs - this.lastProgressElapsedMs >= 250) {
      this.lastProgressElapsedMs = progress.elapsedMs;
      this.events.onProgress(progress);
    }
  };

  private finish(reason: FullVideoCompletionReason): void {
    if (this.terminal) return;
    this.terminal = true;
    const progress = calculateFullVideoProgress(this.video.currentTime, this.playbackState.duration);
    this.cleanupMonitoring();
    this.video.pause();
    this.events.onCompleted({ ...progress, reason });
  }

  private fail(error: FullTranscriptionError): void {
    if (this.terminal) return;
    this.terminal = true;
    this.cleanupMonitoring();
    this.video.pause();
    this.events.onError(error);
  }

  private cleanupMonitoring(): void {
    this.video.removeEventListener("ended", this.handleEnded);
    this.video.removeEventListener("timeupdate", this.handleTimeUpdate);
    if (this.monitorTimer !== undefined) this.platform.clearInterval(this.monitorTimer);
    if (this.hardTimeout !== undefined) this.platform.clearTimeout(this.hardTimeout);
    this.monitorTimer = undefined;
    this.hardTimeout = undefined;
  }
}
