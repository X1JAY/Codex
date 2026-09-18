import { describe, expect, it } from "vitest";
import { assertNonEmptyBlob, AudioCaptureException, normalizeAudioCaptureError, publicAudioCaptureError } from "./errors";

describe("audio capture error handling", () => {
  it("normalizes browser permission errors", () => {
    const result = normalizeAudioCaptureError(
      { name: "NotAllowedError", message: "Permission denied" },
      "TAB_CAPTURE_FAILED"
    );
    expect(result.code).toBe("TAB_CAPTURE_DENIED");
    expect(result.message).toContain("拒绝");
  });

  it("rejects an empty Blob", () => {
    expect(() => assertNonEmptyBlob(new Blob())).toThrow(/结果为空/);
    expect(() => assertNonEmptyBlob(new Blob(["audio"]))).not.toThrow();
  });

  it("preserves the diagnostic stage and raw browser message", () => {
    const normalized = normalizeAudioCaptureError(
      new AudioCaptureException(
        "TAB_CAPTURE_FAILED",
        "无法启动当前标签页音频捕获。",
        undefined,
        "getMediaStreamId",
        "No tab capture stream ID available"
      )
    );
    expect(normalized.stage).toBe("getMediaStreamId");
    expect(normalized.rawMessage).toBe("No tab capture stream ID available");
    expect(publicAudioCaptureError(normalized)).toEqual({
      code: "TAB_CAPTURE_FAILED",
      stage: "getMediaStreamId",
      message: "无法启动当前标签页音频捕获。",
      rawMessage: "No tab capture stream ID available"
    });
  });
});
