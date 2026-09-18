import { describe, expect, it } from "vitest";
import { extractVideoId, isDouyinHost, parseInputUrl, redactLogText, redactUrl } from "./url.js";

describe("Douyin URL helpers", () => {
  it("accepts normal Douyin and short-share hosts", () => {
    expect(isDouyinHost("www.douyin.com")).toBe(true);
    expect(isDouyinHost("v.douyin.com")).toBe(true);
    expect(isDouyinHost("www.example.com")).toBe(false);
    expect(parseInputUrl("https://v.douyin.com/abc/").hostname).toBe("v.douyin.com");
  });

  it("extracts video IDs from paths and query parameters", () => {
    expect(extractVideoId("https://www.douyin.com/video/7341234567890123456")).toBe("7341234567890123456");
    expect(extractVideoId("https://www.douyin.com/jingxuan?modal_id=7341234567890123456")).toBe("7341234567890123456");
    expect(extractVideoId("https://www.douyin.com/jingxuan")).toBeUndefined();
  });

  it("redacts query values before logging media URLs", () => {
    expect(redactUrl("https://cdn.example.com/video.m3u8?token=secret&expires=1")).toContain("token=%5Bredacted%5D");
    expect(redactUrl("https://cdn.example.com/video.m3u8?token=secret")).not.toContain("secret");
    expect(redactLogText("WebSocket wss://example.com/ws?access_key=secret&device_id=1")).not.toContain("secret");
  });
});
