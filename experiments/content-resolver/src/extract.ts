export interface RawPageSnapshot {
  pageUrl: string;
  documentTitle: string;
  videoId?: string;
  videoIdSource?: "url" | "link" | "visible-dom" | "meta";
  author?: string;
  authorSource?: "visible-dom" | "meta";
  titleOrDescription?: string;
  titleOrDescriptionSource?: "visible-dom" | "meta";
  visibleText: string;
  subtitles: {
    exists: boolean;
    confidence: "strong" | "weak" | "none";
    visibleText?: string;
    visibleNodeCount: number;
    trackCount: number;
    textTrackCount: number;
    evidence: string[];
  };
  audio: {
    mediaElementCount: number;
    readyMediaCount: number;
    sourceUrls: string[];
    performanceResourceUrls: string[];
  };
}

/**
 * This function is serialized and executed in the normal page context by
 * Playwright. Keep helpers inside it so no private API or extension runtime is
 * required in the experiment.
 */
export function collectPageSnapshot(): RawPageSnapshot {
  const normalize = (value: string | null | undefined): string =>
    (value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

  const normalizeMultiline = (value: string | null | undefined): string =>
    (value ?? "")
      .replace(/\u00a0/g, " ")
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n")
      .trim();

  const isVisible = (element: Element): boolean => {
    if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  };

  const textOf = (element: Element): string => normalize(element.textContent);

  const firstVisibleText = (
    selectors: readonly string[],
    maxLength = 1600,
    accept: (text: string) => boolean = () => true
  ): { text?: string; selector?: string } => {
    for (const selector of selectors) {
      for (const element of Array.from(document.querySelectorAll(selector))) {
        if (!isVisible(element)) continue;
        const text = textOf(element);
        if (text.length >= 2 && text.length <= maxLength && accept(text)) return { text, selector };
      }
    }
    return {};
  };

  const firstMeta = (selectors: readonly string[]): string | undefined => {
    for (const selector of selectors) {
      const content = document.querySelector<HTMLMetaElement>(selector)?.content;
      if (content && normalize(content)) return normalize(content);
    }
    return undefined;
  };

  const extractId = (value: string): string | undefined => {
    try {
      const parsed = new URL(value);
      const pathMatch = parsed.pathname.match(/\/(?:video|shipin)\/(\d+)/i);
      if (pathMatch?.[1]) return pathMatch[1];
      for (const key of ["modal_id", "item_id", "video_id", "aweme_id"]) {
        const queryValue = parsed.searchParams.get(key);
        if (queryValue && /^\d+$/.test(queryValue)) return queryValue;
      }
    } catch {
      return undefined;
    }
    return undefined;
  };

  const pageUrl = window.location.href;
  let videoId = extractId(pageUrl);
  let videoIdSource: RawPageSnapshot["videoIdSource"] = videoId ? "url" : undefined;

  if (!videoId) {
    const videoLink = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"], a[href*="/shipin/"]'))
      .find((element) => isVisible(element));
    if (videoLink) {
      videoId = extractId(videoLink.href);
      if (videoId) videoIdSource = "link";
    }
  }

  if (!videoId) {
    const dataElement = Array.from(document.querySelectorAll("[data-video-id], [data-item-id], [data-aweme-id]"))
      .find((element) => isVisible(element));
    for (const key of ["data-video-id", "data-item-id", "data-aweme-id"]) {
      const value = dataElement?.getAttribute(key);
      if (value && /^\d+$/.test(value)) {
        videoId = value;
        videoIdSource = "visible-dom";
        break;
      }
    }
  }

  if (!videoId) {
    const metadataUrl = firstMeta(['meta[property="og:url"]']);
    videoId = metadataUrl ? extractId(metadataUrl) : undefined;
    if (videoId) videoIdSource = "meta";
  }

  const authorCandidate = firstVisibleText([
    '[data-e2e="video-author-nickname"]',
    '[data-e2e*="author"]',
    '[data-e2e*="nickname"]',
    '[data-e2e*="username"]',
    '[class*="author-name"]',
    '[class*="author"]',
    '[class*="nickname"]',
    '[class*="user-name"]',
    'a[href*="/user/"]'
  ], 120, (text) => !/^(首页|推荐|精选|朋友|消息|我的|登录|注册|关注|粉丝|获赞|分享|评论|收藏|举报|更多)$/.test(text));
  const authorMeta = firstMeta(['meta[name="author"]']);
  const author = authorCandidate.text || authorMeta;
  const authorSource: RawPageSnapshot["authorSource"] = authorCandidate.text
    ? "visible-dom"
    : authorMeta
      ? "meta"
      : undefined;

  const titleCandidate = firstVisibleText([
    '[data-e2e="feed-video-desc"]',
    '[data-e2e*="video-desc"]',
    '[data-e2e*="caption"]',
    '[data-e2e*="desc"]',
    '[class*="video-desc"]',
    '[class*="description"]',
    'h1'
  ]);
  const titleMeta = firstMeta([
    'meta[property="og:title"]',
    'meta[property="og:description"]',
    'meta[name="description"]'
  ]);
  const titleOrDescription = titleCandidate.text || titleMeta || normalize(document.title) || undefined;
  const titleOrDescriptionSource: RawPageSnapshot["titleOrDescriptionSource"] = titleCandidate.text
    ? "visible-dom"
    : titleMeta
      ? "meta"
      : undefined;

  const visibleText = normalizeMultiline(
    (document.body as HTMLElement | null)?.innerText || document.body?.textContent
  ).slice(0, 30000);

  const subtitleSelectors = [
    '[data-e2e*="subtitle"]',
    '[data-e2e*="caption-text"]',
    '[class*="subtitle"]',
    '[class*="caption-text"]',
    '[aria-live="polite"]'
  ];
  const visibleSubtitleTexts: string[] = [];
  for (const selector of subtitleSelectors) {
    for (const element of Array.from(document.querySelectorAll(selector))) {
      if (!isVisible(element)) continue;
      const text = textOf(element);
      if (text.length >= 1 && text.length <= 1000) visibleSubtitleTexts.push(text);
    }
  }
  const trackCount = document.querySelectorAll('track[kind="subtitles"], track[kind="captions"], track:not([kind])').length;
  let textTrackCount = 0;
  for (const media of Array.from(document.querySelectorAll<HTMLVideoElement>("video"))) {
    try {
      textTrackCount += media.textTracks?.length ?? 0;
    } catch {
      // A browser may expose the element but deny the track list.
    }
  }
  const subtitleExists = visibleSubtitleTexts.length > 0 || trackCount > 0 || textTrackCount > 0;
  const subtitleConfidence: RawPageSnapshot["subtitles"]["confidence"] = visibleSubtitleTexts.length > 0
    ? "strong"
    : subtitleExists
      ? "weak"
      : "none";
  const subtitleEvidence: string[] = [];
  if (visibleSubtitleTexts.length > 0) subtitleEvidence.push("visible subtitle/caption DOM text");
  if (trackCount > 0) subtitleEvidence.push(`${trackCount} subtitle track element(s)`);
  if (textTrackCount > 0) subtitleEvidence.push(`${textTrackCount} browser text track(s)`);

  const mediaElements = Array.from(document.querySelectorAll<HTMLMediaElement>("video, audio"));
  const sourceUrls = new Set<string>();
  let readyMediaCount = 0;
  for (const media of mediaElements) {
    if (media.readyState >= 2 && (media.currentSrc || media.getAttribute("src"))) readyMediaCount += 1;
    if (media.currentSrc) sourceUrls.add(media.currentSrc);
    const directSrc = media.getAttribute("src");
    if (directSrc) sourceUrls.add(new URL(directSrc, pageUrl).href);
    for (const source of Array.from(media.querySelectorAll("source[src]"))) {
      const sourceValue = source.getAttribute("src");
      if (sourceValue) sourceUrls.add(new URL(sourceValue, pageUrl).href);
    }
  }

  const performanceResourceUrls: string[] = [];
  try {
    for (const entry of performance.getEntriesByType("resource")) {
      const resource = entry as PerformanceResourceTiming;
      if (resource.initiatorType === "video" || /\.(?:m3u8|mp4|webm|aac|mp3)(?:$|\?)/i.test(resource.name)) {
        performanceResourceUrls.push(resource.name);
      }
    }
  } catch {
    // Performance resource timing is optional in some browser contexts.
  }

  return {
    pageUrl,
    documentTitle: normalize(document.title),
    videoId,
    videoIdSource,
    author,
    authorSource,
    titleOrDescription,
    titleOrDescriptionSource,
    visibleText,
    subtitles: {
      exists: subtitleExists,
      confidence: subtitleConfidence,
      visibleText: visibleSubtitleTexts[0],
      visibleNodeCount: visibleSubtitleTexts.length,
      trackCount,
      textTrackCount,
      evidence: subtitleEvidence
    },
    audio: {
      mediaElementCount: mediaElements.length,
      readyMediaCount,
      sourceUrls: [...sourceUrls],
      performanceResourceUrls
    }
  };
}
