import { describe, expect, it } from "vitest";
import { isAudioCaptureActive, transitionAudioCaptureState } from "./state";

describe("audio capture state machine", () => {
  it("moves from request to recording to completed", () => {
    expect(transitionAudioCaptureState("idle", "REQUEST_START")).toBe("requesting");
    expect(transitionAudioCaptureState("requesting", "RECORDING_STARTED")).toBe("recording");
    expect(transitionAudioCaptureState("recording", "REQUEST_STOP")).toBe("stopping");
    expect(transitionAudioCaptureState("stopping", "COMPLETED")).toBe("completed");
  });

  it("keeps an active state when a duplicate start is requested", () => {
    expect(isAudioCaptureActive("recording")).toBe(true);
    expect(transitionAudioCaptureState("recording", "REQUEST_START")).toBe("recording");
    expect(transitionAudioCaptureState("completed", "REQUEST_START")).toBe("requesting");
  });
});
