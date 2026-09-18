import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { collectPageSnapshot } from "./extract.js";

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
});

describe("page snapshot extraction", () => {
  it("reads public DOM metadata, visible text, subtitle signals, and media sources", () => {
    const dom = new JSDOM(
      `<!doctype html>
        <html>
          <head>
            <title>测试视频标题</title>
            <meta property="og:url" content="https://www.douyin.com/video/7341234567890123456">
          </head>
          <body>
            <article data-e2e="feed-video">
              <a href="/video/7341234567890123456"><span data-e2e="video-author-nickname">测试作者</span></a>
              <p data-e2e="feed-video-desc">这是视频描述 #测试话题</p>
              <p data-e2e="subtitle">这是页面可见字幕</p>
              <video src="blob:https://www.douyin.com/media"></video>
            </article>
          </body>
        </html>`,
      { url: "https://www.douyin.com/video/7341234567890123456" }
    );
    Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
    Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });

    const snapshot = collectPageSnapshot();
    expect(snapshot.videoId).toBe("7341234567890123456");
    expect(snapshot.author).toBe("测试作者");
    expect(snapshot.titleOrDescription).toContain("这是视频描述");
    expect(snapshot.visibleText).toContain("测试作者");
    expect(snapshot.subtitles.exists).toBe(true);
    expect(snapshot.subtitles.confidence).toBe("strong");
    expect(snapshot.audio.sourceUrls[0]).toContain("blob:");
  });

  it("reports missing subtitle and media signals without inventing them", () => {
    const dom = new JSDOM("<body><p>只有普通可见文字</p></body>", {
      url: "https://www.douyin.com/jingxuan"
    });
    Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
    Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });

    const snapshot = collectPageSnapshot();
    expect(snapshot.videoId).toBeUndefined();
    expect(snapshot.subtitles.exists).toBe(false);
    expect(snapshot.audio.sourceUrls).toEqual([]);
    expect(snapshot.audio.performanceResourceUrls).toEqual([]);
  });

  it("skips navigation labels when looking for an author", () => {
    const dom = new JSDOM(
      '<body><span class="user-name">我的</span><a href="/user/real-author"><span>真实作者</span></a></body>',
      { url: "https://www.douyin.com/video/7341234567890123456" }
    );
    Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
    Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });

    const snapshot = collectPageSnapshot();
    expect(snapshot.author).toBe("真实作者");
  });
});
