import { assertNonEmptyBlob, AudioCaptureException, normalizeAudioCaptureError } from "./errors";
import { selectSupportedAudioMimeType, type MediaRecorderConstructorLike } from "./mimeTypes";
import type { AudioCaptureError, AudioCaptureResult } from "./types";

const DEFAULT_MAX_DURATION_MS = 15_000;
const TIMESLICE_MS = 250;

interface CaptureResources {
  stream?: MediaStream;
  sourceNode?: MediaStreamAudioSourceNode;
  audioContext?: AudioContext;
}

export interface TabAudioRecorderEvents {
  onLog?: (event: string, details?: Record<string, unknown>) => void;
  onStarted?: (info: { mimeType: string; startedAt: string }) => void;
  onProgress?: (elapsedMs: number) => void;
  onChunk?: (sizeBytes: number) => void;
  onCompleted?: (result: AudioCaptureResult, blob: Blob) => void;
  onError?: (error: AudioCaptureError) => void;
}

export interface TabAudioRecorderPlatform {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  mediaRecorderConstructor?: MediaRecorderConstructorLike;
  createAudioContext?: () => AudioContext;
  now?: () => number;
  dateNow?: () => Date;
}

export interface TabAudioRecorderStartResult {
  mimeType: string;
  audioTrackCount: number;
  startedAt: string;
}

export async function releaseCaptureResources(resources: CaptureResources): Promise<void> {
  resources.sourceNode?.disconnect();
  resources.stream?.getTracks().forEach((track) => track.stop());
  if (resources.audioContext && resources.audioContext.state !== "closed") {
    await resources.audioContext.close();
  }
}

export class TabAudioRecorder {
  private readonly events: TabAudioRecorderEvents;
  private readonly platform: Required<Pick<TabAudioRecorderPlatform, "now" | "dateNow">> & TabAudioRecorderPlatform;
  private resources: CaptureResources = {};
  private mediaRecorder?: MediaRecorder;
  private chunks: Blob[] = [];
  private mimeType?: string;
  private audioTrackCount = 0;
  private trackEndListeners: Array<{ track: MediaStreamTrack; listener: EventListener }> = [];
  private tabId?: number;
  private startedAt?: string;
  private startedAtMs?: number;
  private stopTimer?: ReturnType<typeof setTimeout>;
  private progressTimer?: ReturnType<typeof setInterval>;
  private stopPromise?: Promise<AudioCaptureResult>;
  private resolveStop?: (result: AudioCaptureResult) => void;
  private rejectStop?: (error: AudioCaptureError) => void;
  private finalizing = false;
  private ignoreRecorderStop = false;
  private cleaningUp = false;
  private lastBlob?: Blob;
  private lastResult?: AudioCaptureResult;

  constructor(events: TabAudioRecorderEvents = {}, platform: TabAudioRecorderPlatform = {}) {
    this.events = events;
    this.platform = {
      ...platform,
      now: platform.now ?? (() => performance.now()),
      dateNow: platform.dateNow ?? (() => new Date())
    };
  }

  get active(): boolean {
    return Boolean(this.mediaRecorder && this.mediaRecorder.state !== "inactive");
  }

  get lastCapture(): { blob?: Blob; result?: AudioCaptureResult } {
    return { blob: this.lastBlob, result: this.lastResult };
  }

  clearLastCapture(): void {
    this.lastBlob = undefined;
    this.lastResult = undefined;
  }

  async start(
    streamId: string,
    tabId: number,
    maxDurationMs = DEFAULT_MAX_DURATION_MS
  ): Promise<TabAudioRecorderStartResult> {
    if (this.active || this.stopPromise) {
      throw new AudioCaptureException("ALREADY_RECORDING", "已经有一个音频捕获任务正在进行。" );
    }
    this.lastBlob = undefined;
    this.lastResult = undefined;
    this.chunks = [];
    this.finalizing = false;
    this.ignoreRecorderStop = false;
    this.cleaningUp = false;
    this.tabId = tabId;

    const getUserMedia = this.platform.getUserMedia ?? navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);
    if (!getUserMedia) {
      throw new AudioCaptureException(
        "TAB_CAPTURE_FAILED",
        "当前 Offscreen Document 不支持 getUserMedia。",
        undefined,
        "getUserMedia"
      );
    }

    try {
      let stream: MediaStream;
      try {
        this.events.onLog?.("getUserMedia start", { tabId });
        stream = await getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: "tab",
              chromeMediaSourceId: streamId
            }
          } as MediaTrackConstraints,
          video: false
        });
        this.events.onLog?.("getUserMedia success", { tabId });
      } catch (error) {
        const normalized = normalizeAudioCaptureError(
          error,
          "TAB_CAPTURE_FAILED",
          "无法获取当前标签页音频流。",
          "getUserMedia"
        );
        this.events.onLog?.("getUserMedia failed", {
          rawError: normalized.rawMessage ?? normalized.message
        });
        throw new AudioCaptureException(
          normalized.code,
          normalized.message,
          normalized.cause,
          normalized.stage ?? "getUserMedia",
          normalized.rawMessage
        );
      }

      this.resources.stream = stream;
      const audioTracks = stream.getAudioTracks();
      this.audioTrackCount = audioTracks.length;
      this.events.onLog?.(`audioTracks=${audioTracks.length}`);
      if (audioTracks.length === 0) {
        throw new AudioCaptureException(
          "NO_AUDIO_TRACK",
          "当前标签页捕获流中没有 audio track。",
          undefined,
          "getUserMedia"
        );
      }

      const createAudioContext = this.platform.createAudioContext ?? (() => new AudioContext());
      this.resources.audioContext = createAudioContext();
      this.resources.sourceNode = this.resources.audioContext.createMediaStreamSource(stream);
      this.resources.sourceNode.connect(this.resources.audioContext.destination);
      if (this.resources.audioContext.state === "suspended") await this.resources.audioContext.resume();
      this.events.onLog?.("audio output restored");

      const recorderConstructor = this.platform.mediaRecorderConstructor ??
        (typeof MediaRecorder === "undefined" ? undefined : MediaRecorder);
      if (!recorderConstructor) {
        throw new AudioCaptureException(
          "MEDIA_RECORDER_UNAVAILABLE",
          "当前浏览器不支持 MediaRecorder。",
          undefined,
          "mediaRecorder"
        );
      }
      try {
        this.mimeType = selectSupportedAudioMimeType(recorderConstructor);
      } catch (error) {
        throw new AudioCaptureException(
          "MIME_TYPE_UNSUPPORTED",
          "当前浏览器没有支持的音频 MediaRecorder MIME type。",
          error,
          "mediaRecorder",
          normalizeAudioCaptureError(error, "MIME_TYPE_UNSUPPORTED", "当前浏览器没有支持的音频 MediaRecorder MIME type。", "mediaRecorder").rawMessage
        );
      }
      this.events.onLog?.("mime selected", { mimeType: this.mimeType });
      this.mediaRecorder = new recorderConstructor(stream, { mimeType: this.mimeType });
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size <= 0) return;
        this.chunks.push(event.data);
        this.events.onLog?.("chunk received", { sizeBytes: event.data.size });
        this.events.onChunk?.(event.data.size);
      };
      this.mediaRecorder.onerror = (event) => {
        const error = normalizeAudioCaptureError(
          (event as ErrorEvent).error ?? event,
          "RECORDER_FAILED",
          "MediaRecorder 发生异常。",
          "mediaRecorder"
        );
        void this.fail(error);
      };
      this.mediaRecorder.onstop = () => {
        void this.finishStop();
      };
      for (const track of audioTracks) {
        const listener: EventListener = () => {
          if (!this.cleaningUp && this.active) {
            void this.fail(new AudioCaptureException(
              "TARGET_TAB_CLOSED",
              "目标标签页的音频轨道已结束。",
              undefined,
              "getUserMedia"
            ));
          }
        };
        track.addEventListener("ended", listener);
        this.trackEndListeners.push({ track, listener });
      }

      const startedAtDate = this.platform.dateNow();
      this.startedAt = startedAtDate.toISOString();
      this.startedAtMs = this.platform.now();
      this.mediaRecorder.start(TIMESLICE_MS);
      this.events.onLog?.("recorder started", { mimeType: this.mimeType, startedAt: this.startedAt });
      this.events.onStarted?.({ mimeType: this.mimeType, startedAt: this.startedAt });
      this.progressTimer = setInterval(() => {
        if (this.startedAtMs === undefined) return;
        this.events.onProgress?.(Math.max(0, Math.round(this.platform.now() - this.startedAtMs)));
      }, 1000);
      this.stopTimer = setTimeout(() => {
        this.events.onLog?.("capture timeout", { maxDurationMs });
        void this.stop();
      }, maxDurationMs);
      return { mimeType: this.mimeType, audioTrackCount: this.audioTrackCount, startedAt: this.startedAt };
    } catch (error) {
      const normalized = normalizeAudioCaptureError(
        error,
        "RECORDER_FAILED",
        "无法创建或录制当前标签页音频。",
        "mediaRecorder"
      );
      await this.cleanup();
      this.events.onError?.(normalized);
      throw normalized;
    }
  }

  async stop(): Promise<AudioCaptureResult> {
    if (!this.mediaRecorder) {
      throw new AudioCaptureException(
        "STOP_FAILED",
        "当前没有正在进行的音频捕获任务。",
        undefined,
        "mediaRecorder"
      );
    }
    if (this.stopPromise) return this.stopPromise;
    this.events.onLog?.("recorder stopping");
    this.stopPromise = new Promise<AudioCaptureResult>((resolve, reject) => {
      this.resolveStop = resolve;
      this.rejectStop = reject;
    });
    if (this.mediaRecorder.state === "inactive") {
      await this.finishStop();
    } else {
      this.mediaRecorder.stop();
    }
    return this.stopPromise;
  }

  async cancel(): Promise<void> {
    if (!this.mediaRecorder) return;
    this.finalizing = true;
    this.ignoreRecorderStop = true;
    try {
      if (this.mediaRecorder.state !== "inactive") this.mediaRecorder.stop();
    } finally {
      await this.cleanup();
      this.clearLastCapture();
      this.resetActiveState();
    }
  }

  private async finishStop(): Promise<void> {
    if (this.finalizing || this.ignoreRecorderStop) return;
    this.finalizing = true;
    const endedAtDate = this.platform.dateNow();
    const endedAt = endedAtDate.toISOString();
    const durationMs = Math.max(0, Math.round(this.platform.now() - (this.startedAtMs ?? this.platform.now())));
    const blob = new Blob(this.chunks, { type: this.mimeType ?? "audio/webm" });
    try {
      assertNonEmptyBlob(blob);
      const result: AudioCaptureResult = {
        mimeType: blob.type || this.mimeType || "audio/webm",
        audioTrackCount: this.audioTrackCount,
        sizeBytes: blob.size,
        durationMs,
        tabId: this.tabId ?? -1,
        startedAt: this.startedAt ?? endedAt,
        endedAt
      };
      this.lastBlob = blob;
      this.lastResult = result;
      this.events.onLog?.("blob created", { mimeType: result.mimeType, sizeBytes: result.sizeBytes, durationMs });
      this.events.onCompleted?.(result, blob);
      await this.cleanup();
      this.resolveStop?.(result);
    } catch (error) {
      const normalized = normalizeAudioCaptureError(error, "RECORDER_FAILED");
      await this.cleanup();
      this.events.onError?.(normalized);
      this.rejectStop?.(normalized);
    } finally {
      this.resetActiveState();
    }
  }

  private async fail(error: AudioCaptureError): Promise<void> {
    if (this.finalizing) return;
    this.finalizing = true;
    this.ignoreRecorderStop = true;
    await this.cleanup();
    this.events.onError?.(error);
    this.rejectStop?.(error);
    this.resetActiveState();
  }

  private async cleanup(): Promise<void> {
    this.cleaningUp = true;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.stopTimer = undefined;
    this.progressTimer = undefined;
    for (const { track, listener } of this.trackEndListeners) {
      track.removeEventListener("ended", listener);
    }
    this.trackEndListeners = [];
    if (this.mediaRecorder) {
      this.mediaRecorder.ondataavailable = null;
      this.mediaRecorder.onerror = null;
      this.mediaRecorder.onstop = null;
    }
    await releaseCaptureResources(this.resources);
    this.resources = {};
    this.mediaRecorder = undefined;
    this.events.onLog?.("tracks released");
    this.cleaningUp = false;
  }

  private resetActiveState(): void {
    this.chunks = [];
    this.stopPromise = undefined;
    this.resolveStop = undefined;
    this.rejectStop = undefined;
    this.startedAt = undefined;
    this.startedAtMs = undefined;
    this.mimeType = undefined;
    this.audioTrackCount = 0;
    this.tabId = undefined;
    this.finalizing = false;
  }
}
