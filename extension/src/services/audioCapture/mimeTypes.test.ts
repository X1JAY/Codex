import { describe, expect, it } from "vitest";
import { getSupportedAudioMimeTypes, selectSupportedAudioMimeType, type MediaRecorderConstructorLike } from "./mimeTypes";

describe("audio MIME fallback", () => {
  it("selects the first supported format in priority order", () => {
    const recorder = {
      isTypeSupported: (mimeType: string) => mimeType === "audio/webm"
    } as unknown as MediaRecorderConstructorLike;
    expect(getSupportedAudioMimeTypes(recorder)).toEqual(["audio/webm"]);
    expect(selectSupportedAudioMimeType(recorder)).toBe("audio/webm");
  });

  it("fails clearly when no format is supported", () => {
    const recorder = { isTypeSupported: () => false } as unknown as MediaRecorderConstructorLike;
    expect(() => selectSupportedAudioMimeType(recorder)).toThrow(/没有支持的音频/);
  });
});
