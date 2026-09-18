import { describe, expect, it, vi } from "vitest";
import { TabAudioRecorder, releaseCaptureResources } from "./recorder";
import type { MediaRecorderConstructorLike } from "./mimeTypes";

class FakeMediaRecorder {
  static isTypeSupported(mimeType: string): boolean {
    return mimeType === "audio/webm;codecs=opus";
  }

  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(readonly stream: MediaStream, readonly options?: MediaRecorderOptions) {}

  start(): void {
    this.state = "recording";
    this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm;codecs=opus" }) } as BlobEvent);
  }

  stop(): void {
    this.state = "inactive";
    this.onstop?.();
  }
}

class EmptyMediaRecorder extends FakeMediaRecorder {
  override start(): void {
    this.state = "recording";
  }
}

function fakeResources() {
  const track = {
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  } as unknown as MediaStreamTrack;
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track]
  } as unknown as MediaStream;
  const sourceNode = {
    connect: vi.fn(),
    disconnect: vi.fn()
  } as unknown as MediaStreamAudioSourceNode;
  const audioContext = {
    state: "running",
    destination: {},
    createMediaStreamSource: vi.fn(() => sourceNode),
    close: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined)
  } as unknown as AudioContext;
  return { track, stream, sourceNode, audioContext };
}

describe("TabAudioRecorder", () => {
  it("stops, creates a non-empty Blob, releases resources, and can record twice", async () => {
    const first = fakeResources();
    const second = fakeResources();
    const resources = [first, second];
    let now = 1_000;
    let index = 0;
    const completed = vi.fn();
    const recorderConstructor = FakeMediaRecorder as unknown as MediaRecorderConstructorLike;
    const recorder = new TabAudioRecorder(
      { onCompleted: completed },
      {
        getUserMedia: vi.fn(async () => resources[index].stream),
        mediaRecorderConstructor: recorderConstructor,
        createAudioContext: () => resources[index].audioContext,
        now: () => now,
        dateNow: () => new Date(now)
      }
    );

    await recorder.start("stream-1", 42, 15_000);
    await expect(recorder.start("duplicate", 42, 15_000)).rejects.toMatchObject({ code: "ALREADY_RECORDING" });
    now = 6_000;
    const firstResult = await recorder.stop();
    expect(firstResult.sizeBytes).toBeGreaterThan(0);
    expect(firstResult.durationMs).toBe(5_000);
    expect(firstResult.mimeType).toBe("audio/webm;codecs=opus");
    expect(firstResult.audioTrackCount).toBe(1);
    expect(first.track.stop).toHaveBeenCalledTimes(1);
    expect(first.track.removeEventListener).toHaveBeenCalledTimes(1);
    expect(first.sourceNode.disconnect).toHaveBeenCalledTimes(1);
    expect(first.audioContext.close).toHaveBeenCalledTimes(1);

    index = 1;
    now = 7_000;
    await recorder.start("stream-2", 42, 15_000);
    now = 8_000;
    const secondResult = await recorder.stop();
    expect(secondResult.sizeBytes).toBeGreaterThan(0);
    expect(completed).toHaveBeenCalledTimes(2);
    expect(second.track.stop).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty Blob and still releases resources", async () => {
    const resources = fakeResources();
    const errors: unknown[] = [];
    const recorder = new TabAudioRecorder(
      { onError: (error) => errors.push(error) },
      {
        getUserMedia: vi.fn(async () => resources.stream),
        mediaRecorderConstructor: EmptyMediaRecorder as unknown as MediaRecorderConstructorLike,
        createAudioContext: () => resources.audioContext,
        now: () => 1_000,
        dateNow: () => new Date(1_000)
      }
    );

    await recorder.start("stream-empty", 7, 15_000);
    await expect(recorder.stop()).rejects.toMatchObject({ code: "EMPTY_BLOB" });
    expect(errors).toHaveLength(1);
    expect(resources.track.stop).toHaveBeenCalledTimes(1);
    expect(resources.audioContext.close).toHaveBeenCalledTimes(1);
  });

  it("cancels without producing a Blob and releases every capture resource", async () => {
    const resources = fakeResources();
    const completed = vi.fn();
    const recorder = new TabAudioRecorder(
      { onCompleted: completed },
      {
        getUserMedia: vi.fn(async () => resources.stream),
        mediaRecorderConstructor: FakeMediaRecorder as unknown as MediaRecorderConstructorLike,
        createAudioContext: () => resources.audioContext,
        now: () => 1_000,
        dateNow: () => new Date(1_000)
      }
    );

    await recorder.start("stream-cancel", 9, 15_000);
    await recorder.cancel();

    expect(completed).not.toHaveBeenCalled();
    expect(recorder.active).toBe(false);
    expect(recorder.lastCapture).toEqual({ blob: undefined, result: undefined });
    expect(resources.track.stop).toHaveBeenCalledTimes(1);
    expect(resources.track.removeEventListener).toHaveBeenCalledTimes(1);
    expect(resources.sourceNode.disconnect).toHaveBeenCalledTimes(1);
    expect(resources.audioContext.close).toHaveBeenCalledTimes(1);
  });
});

describe("resource cleanup", () => {
  it("stops tracks, disconnects Web Audio, and closes AudioContext", async () => {
    const resources = fakeResources();
    await releaseCaptureResources(resources);
    expect(resources.track.stop).toHaveBeenCalledTimes(1);
    expect(resources.sourceNode.disconnect).toHaveBeenCalledTimes(1);
    expect(resources.audioContext.close).toHaveBeenCalledTimes(1);
  });
});
