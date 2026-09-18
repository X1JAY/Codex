import { describe, expect, it } from "vitest";
import { extractHashtags, parseVideoId } from "./douyin";

describe("DouyinAdapter pure helpers", () => {
  it("parses a video id from a Douyin video URL", () => {
    expect(parseVideoId("https://www.douyin.com/video/1234567890")).toBe("1234567890");
    expect(parseVideoId("https://www.douyin.com/shipin/9876543210")).toBe("9876543210");
  });

  it("parses query ids without accepting arbitrary text", () => {
    expect(parseVideoId("https://www.douyin.com/?modal_id=123")).toBe("123");
    expect(parseVideoId("https://www.douyin.com/?modal_id=abc")).toBeUndefined();
  });

  it("deduplicates visible hashtag tokens", () => {
    expect(extractHashtags("#减脂 今天记录 #健身 #减脂")).toEqual(["减脂", "健身"]);
  });
});

