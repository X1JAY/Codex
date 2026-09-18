import { describe, expect, it } from "vitest";
import type { AudioCaptureResult } from "../services/audioCapture/types";
import {
  FULL_TRANSCRIPTION_OFFSCREEN_GET_STATUS,
  type FullTranscriptionOffscreenGetStatusMessage,
} from "../services/fullTranscription/types";
import type { TranscriptionStatus } from "../services/transcription/types";
import {
  retainedFullTranscriptionStatus,
  structuredTranscriptionErrorLines,
  transcriptionEventType,
} from "./transcriptionBridge";

const captureResult: AudioCaptureResult = {
  mimeType: "audio/webm;codecs=opus",
  audioTrackCount: 1,
  sizeBytes: 123_456,
  durationMs: 185_000,
  tabId: 381389381,
  startedAt: "2026-09-18T00:00:00.000Z",
  endedAt: "2026-09-18T00:03:05.000Z",
};

const completed: TranscriptionStatus = {
  state: "completed",
  captureResult,
  result: {
    text: "完整视频中文逐字稿",
    language: "zh",
    durationSeconds: 185,
  },
};

const query: FullTranscriptionOffscreenGetStatusMessage = {
  target: "offscreen",
  type: FULL_TRANSCRIPTION_OFFSCREEN_GET_STATUS,
  sessionId: "full-session-1",
  tabId: 381389381,
};

describe("offscreen transcription result bridge", () => {
  it("keeps full-video and short-transcription event routes separate", () => {
    expect(transcriptionEventType("full-transcription")).toBe("FULL_TRANSCRIPTION_OFFSCREEN_EVENT");
    expect(transcriptionEventType("transcription")).toBe("TRANSCRIPTION_OFFSCREEN_EVENT");
    expect(transcriptionEventType("capture-test")).toBeUndefined();
  });

  it("returns a completed transcript after recorder resources and Blob references are cleared", () => {
    const response = retainedFullTranscriptionStatus(query, {
      sessionId: "full-session-1",
      tabId: 381389381,
      purpose: "full-transcription",
      status: completed,
    });

    expect(response.status?.state).toBe("completed");
    expect(response.status?.result?.text).toBe("完整视频中文逐字稿");
    expect(response.status?.captureResult).toEqual(captureResult);
  });

  it("does not leak completed state across session or tab identities", () => {
    const response = retainedFullTranscriptionStatus(
      { ...query, sessionId: "new-session" },
      {
        sessionId: "full-session-1",
        tabId: 381389381,
        purpose: "full-transcription",
        status: completed,
      },
    );

    expect(response.status).toBeUndefined();
  });

  it("formats transcription failures as named scalar fields", () => {
    const lines = structuredTranscriptionErrorLines(new Error("decoder failed"), {
      code: "TRANSCRIPTION_FAILED",
      stage: "transcription",
      message: "本地语音转写失败。",
      rawMessage: "decoder failed",
    });

    expect(lines).toEqual(expect.arrayContaining([
      "[transcription] code=TRANSCRIPTION_FAILED",
      "[transcription] message=本地语音转写失败。",
      "[transcription] stage=transcription",
    ]));
    expect(lines.some((line) => line.startsWith("[transcription] stack=Error: decoder failed"))).toBe(true);
    expect(lines.join("\n")).not.toContain("[object Object]");
  });
});
