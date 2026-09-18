import type { Browser } from "playwright-core";
import { navigateNormally, launchNormalBrowser, type BrowserOptions } from "./browser.js";
import { collectPageSnapshot, type RawPageSnapshot } from "./extract.js";
import { ResolverLogger } from "./logging.js";
import { extractVideoId, isDouyinHost, parseInputUrl, redactUrl } from "./url.js";
import type { AudioResult, FieldEvidence, ResolverReport, SubtitleResult, VideoResult } from "./types.js";

export const RESOLVER_VERSION = "0.1.0";

function mediaKind(value: string): "network" | "blob" | "data" | "unknown" {
  if (value.startsWith("blob:")) return "blob";
  if (value.startsWith("data:")) return "data";
  if (value.startsWith("http://") || value.startsWith("https://")) return "network";
  return "unknown";
}

function buildVideoResult(snapshot: RawPageSnapshot, finalUrl: string): VideoResult {
  const videoId = snapshot.videoId || extractVideoId(finalUrl);
  return {
    videoId,
    author: snapshot.author,
    titleOrDescription: snapshot.titleOrDescription,
    visibleText: snapshot.visibleText,
    evidence: {
      videoId: videoId
        ? { source: snapshot.videoIdSource || (extractVideoId(finalUrl) ? "url" : "not-found") }
        : { source: "not-found" },
      author: snapshot.author
        ? { source: snapshot.authorSource || "visible-dom" }
        : { source: "not-found" },
      titleOrDescription: snapshot.titleOrDescription
        ? { source: snapshot.titleOrDescriptionSource || "visible-dom" }
        : { source: "not-found" },
      visibleText: snapshot.visibleText
        ? { source: "visible-dom", detail: "document.body.innerText" }
        : { source: "not-found" }
    }
  };
}

function buildAudioResult(snapshot: RawPageSnapshot): AudioResult {
  const urls = [...new Set([...snapshot.audio.sourceUrls, ...snapshot.audio.performanceResourceUrls])];
  const sourceKinds = [...new Set(urls.map(mediaKind))];
  const evidence: string[] = [];
  if (snapshot.audio.sourceUrls.length > 0) evidence.push("HTMLMediaElement/source src");
  if (snapshot.audio.performanceResourceUrls.length > 0) evidence.push("performance resource timing");
  if (snapshot.audio.readyMediaCount > 0) evidence.push("media element readyState >= HAVE_CURRENT_DATA");
  return {
    exists: urls.length > 0,
    usableInPage: snapshot.audio.readyMediaCount > 0,
    mediaElementCount: snapshot.audio.mediaElementCount,
    readyMediaCount: snapshot.audio.readyMediaCount,
    sourceCount: urls.length,
    sourceKinds,
    sourceUrls: urls.map(redactUrl),
    evidence
  };
}

function blockedPageReason(finalUrl: string, visibleText: string, mediaElementCount: number): string | undefined {
  if (/\/(?:login|passport|verify|captcha)(?:[/?#]|$)/i.test(finalUrl)) {
    return "页面跳转到了登录/验证相关地址。";
  }
  const hasStrongAccessGate = /(安全验证|滑动验证|访问受限|请完成(?:验证码|安全验证)|请先(?:完成验证|验证)|请先登录(?:后)?(?:观看|查看|播放|继续)|登录后(?:观看|查看|播放|继续))/.test(visibleText);
  if (hasStrongAccessGate && mediaElementCount === 0) {
    return "页面可见文字疑似包含登录或安全验证提示。";
  }
  return undefined;
}

function initialReport(input: string, acceptedHost: boolean, startedAt: string): ResolverReport {
  const emptyEvidence: FieldEvidence = { source: "not-found" };
  return {
    schemaVersion: "1.0",
    resolverVersion: RESOLVER_VERSION,
    status: "error",
    input: { shareUrl: input, acceptedHost, receivedAt: startedAt },
    navigation: { redirectChain: [] },
    video: {
      visibleText: "",
      evidence: {
        videoId: emptyEvidence,
        author: emptyEvidence,
        titleOrDescription: emptyEvidence,
        visibleText: emptyEvidence
      }
    },
    subtitles: {
      exists: false,
      confidence: "none",
      visibleNodeCount: 0,
      trackCount: 0,
      textTrackCount: 0,
      evidence: []
    },
    audio: {
      exists: false,
      usableInPage: false,
      mediaElementCount: 0,
      readyMediaCount: 0,
      sourceCount: 0,
      sourceKinds: [],
      sourceUrls: [],
      evidence: []
    },
    warnings: [],
    errors: [],
    logs: [],
    startedAt
  };
}

export async function resolveDouyinShareLink(
  input: string,
  options: BrowserOptions
): Promise<ResolverReport> {
  const startedAt = new Date().toISOString();
  const logger = new ResolverLogger();
  let parsed: URL;
  try {
    parsed = parseInputUrl(input);
    logger.info("input", "accepted", { host: parsed.hostname, url: redactUrl(parsed.href) });
  } catch (error) {
    const report = initialReport(input, false, startedAt);
    const message = error instanceof Error ? error.message : "输入链接无效。";
    logger.error("input", "rejected", { message });
    report.errors.push(message);
    report.logs = logger.entries;
    report.completedAt = new Date().toISOString();
    return report;
  }

  const report = initialReport(parsed.href, isDouyinHost(parsed.hostname), startedAt);
  let browser: Browser | undefined;
  try {
    const launched = await launchNormalBrowser(options, logger);
    browser = launched.browser;
    report.environment = {
      browser: launched.kind,
      executablePath: launched.executablePath,
      headless: !options.headed,
      platform: process.platform
    };

    const context = await browser.newContext({ locale: "zh-CN" });
    const page = await context.newPage();
    const navigation = await navigateNormally(page, parsed.href, options, logger);
    report.navigation = navigation;

    const snapshot = await page.evaluate(collectPageSnapshot);
    logger.info("extract", "snapshot-collected", {
      finalUrl: redactUrl(snapshot.pageUrl),
      videoId: snapshot.videoId,
      authorFound: Boolean(snapshot.author),
      titleFound: Boolean(snapshot.titleOrDescription),
      visibleTextLength: snapshot.visibleText.length,
      subtitleExists: snapshot.subtitles.exists,
      mediaElementCount: snapshot.audio.mediaElementCount,
      mediaSourceCount: snapshot.audio.sourceUrls.length + snapshot.audio.performanceResourceUrls.length
    });

    report.navigation.finalUrl = snapshot.pageUrl || navigation.finalUrl;
    report.navigation.pageTitle = snapshot.documentTitle || undefined;
    report.video = buildVideoResult(snapshot, report.navigation.finalUrl);
    report.subtitles = snapshot.subtitles;
    report.audio = buildAudioResult(snapshot);

    const blockReason = blockedPageReason(report.navigation.finalUrl, report.video.visibleText, snapshot.audio.mediaElementCount);
    if (blockReason) {
      report.status = "blocked";
      report.warnings.push(blockReason);
      logger.warn("result", "possible-access-gate", { reason: blockReason });
    } else {
      if (!report.video.videoId) report.warnings.push("未从 URL、链接、DOM 数据属性或公开 meta 信息解析出视频 ID。");
      if (!report.video.author) report.warnings.push("没有稳定获取到作者名。");
      if (!report.video.titleOrDescription) report.warnings.push("没有稳定获取到视频标题/描述。");
      if (!report.video.visibleText) report.warnings.push("页面没有获取到可见文字，可能仍在加载或页面不可读。");
      if (!report.subtitles.exists) report.warnings.push("当前页面未发现可见字幕、字幕 track 或浏览器 text track。");
      if (!report.audio.exists) report.warnings.push("当前页面未发现可用的媒体来源信息。");
      else if (!report.audio.usableInPage) report.warnings.push("发现媒体来源，但媒体元素尚未达到可用播放状态。");

      report.status = report.warnings.length === 0 ? "success" : "partial";
    }
    await context.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : "解析过程中发生未知错误。";
    report.status = "error";
    report.errors.push(message);
    logger.error("resolver", "failed", { message });
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }

  report.logs = logger.entries;
  report.completedAt = new Date().toISOString();
  logger.info("result", "completed", {
    status: report.status,
    finalUrl: report.navigation.finalUrl ? redactUrl(report.navigation.finalUrl) : undefined,
    warningCount: report.warnings.length,
    errorCount: report.errors.length
  });
  report.logs = logger.entries;
  return report;
}
