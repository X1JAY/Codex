import type { SiteAdapter } from "./types";
import type { VideoMetadata } from "../../shared/types";

/**
 * Douyin changes class names frequently. Keep every site-specific selector in
 * this map so later selector updates do not leak into the content script or UI.
 */
const SELECTORS = {
  videoContainers: [
    '[data-e2e="feed-video"]',
    '[data-e2e*="video"]',
    '[class*="video-card"]',
    '[class*="feed-item"]',
    '[class*="video-container"]'
  ],
  caption: [
    '[data-e2e="feed-video-desc"]',
    '[data-e2e*="video-desc"]',
    '[data-e2e*="caption"]',
    '[data-e2e*="desc"]',
    '[class*="video-desc"]',
    '[class*="caption"]',
    '[class*="description"]'
  ],
  author: [
    '[data-e2e="video-author-nickname"]',
    '[data-e2e*="author"]',
    '[data-e2e*="nickname"]',
    '[data-e2e*="username"]',
    '[class*="author-name"]',
    '[class*="author"]',
    '[class*="nickname"]',
    '[class*="user-name"]',
    'a[href*="/user/"]'
  ],
  videoLinks: ['a[href*="/video/"]', 'a[href*="/shipin/"]', 'a[data-e2e*="video"]'],
  subtitle: [
    '[data-e2e*="subtitle"]',
    '[data-e2e*="caption-text"]',
    '[class*="subtitle"]',
    '[class*="caption-text"]'
  ]
} as const;

const CONTAINER_SCAN_LIMIT = 5;
const TEXT_SCAN_LIMIT = 250;

export function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function isVisible(element: Element): boolean {
  const htmlElement = element as HTMLElement;
  const rect = htmlElement.getBoundingClientRect();
  const style = window.getComputedStyle(htmlElement);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.opacity !== "0"
  );
}

export function parseVideoId(value: string): string | undefined {
  try {
    const url = new URL(value);
    const pathMatch = url.pathname.match(/\/(?:video|shipin)\/(\d+)/i);
    if (pathMatch?.[1]) return pathMatch[1];
    for (const key of ["modal_id", "item_id", "video_id"]) {
      const queryValue = url.searchParams.get(key);
      if (queryValue && /^\d+$/.test(queryValue)) return queryValue;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function extractHashtags(caption: string | undefined): string[] {
  if (!caption) return [];
  const tags = caption.match(/#[\p{L}\p{N}_-]+/gu) ?? [];
  return [...new Set(tags.map((tag) => tag.slice(1)))];
}

function getVisibleElements(root: ParentNode, selectors: readonly string[]): Element[] {
  const result: Element[] = [];
  for (const selector of selectors) {
    for (const element of Array.from(root.querySelectorAll(selector))) {
      if (isVisible(element)) result.push(element);
    }
  }
  return result;
}

function getContainerCandidates(active: Element | null): Element[] {
  const candidates: Element[] = [];
  let current: Element | null = active;
  for (let index = 0; current && index < CONTAINER_SCAN_LIMIT; index += 1) {
    candidates.push(current);
    current = current.parentElement;
  }
  if (document.body) candidates.push(document.body);
  return [...new Set(candidates)];
}

function scoreCaption(element: Element): number {
  const text = normalizeText(element.textContent);
  if (!text || text.length < 2 || text.length > 1600) return -1;
  if (/^(关注|分享|评论|收藏|举报|更多|下载)$/.test(text)) return -1;
  let score = 0;
  if (text.includes("#")) score += 5;
  if (text.length <= 240) score += 2;
  if (element.getAttribute("data-e2e")) score += 2;
  if (element.closest("nav, header, footer")) score -= 4;
  if (element.matches("button, [role='button']")) score -= 3;
  return score;
}

function scoreAuthor(element: Element): number {
  const text = normalizeText(element.textContent);
  if (!text || text.length < 1 || text.length > 80) return -1;
  if (/^(首页|推荐|精选|朋友|消息|我的|登录|注册|关注|粉丝|获赞|分享|评论|收藏|举报|更多)$/.test(text)) return -1;
  let score = element.getAttribute("data-e2e") ? 4 : 0;
  if (element.matches("a")) score += 1;
  if (element.closest("nav, header, footer")) score -= 3;
  return score;
}

function bestTextCandidate(elements: Element[], scorer: (element: Element) => number): string | undefined {
  let best: { score: number; text: string } | undefined;
  for (const element of elements.slice(0, TEXT_SCAN_LIMIT)) {
    const score = scorer(element);
    if (score < 0) continue;
    const text = normalizeText(element.textContent);
    if (!best || score > best.score) best = { score, text };
  }
  return best?.text;
}

export function getActiveVideoElement(): HTMLVideoElement | undefined {
  const videos = Array.from(document.querySelectorAll("video")).filter(isVisible);
  if (videos.length === 0) return undefined;
  const viewportCenter = window.innerHeight / 2;
  return videos
    .map((video) => {
      const rect = video.getBoundingClientRect();
      const area = rect.width * rect.height;
      const centerDistance = Math.abs(rect.top + rect.height / 2 - viewportCenter);
      const playingScore = !video.paused && video.readyState >= 2 ? 1000000 : 0;
      return { video, score: playingScore + area - centerDistance * 100 };
    })
    .sort((a, b) => b.score - a.score)[0]?.video;
}

function getActiveVideoContainer(): Element | null {
  const video = getActiveVideoElement();
  if (!video) return null;
  for (const selector of SELECTORS.videoContainers) {
    const container = video.closest(selector);
    if (container && isVisible(container)) return container;
  }
  return video.parentElement;
}

function parseDouyinVideoUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value, window.location.href);
    if (parsed.hostname !== "douyin.com" && !parsed.hostname.endsWith(".douyin.com")) return undefined;
    if (!/(?:\/video|\/shipin)\/\d+/i.test(parsed.pathname)) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

function getDataVideoId(element: Element | null | undefined): string | undefined {
  if (!element) return undefined;
  for (const attribute of ["data-video-id", "data-item-id", "data-aweme-id"]) {
    const value = element.getAttribute(attribute);
    if (value && /^\d+$/.test(value)) return value;
  }
  return undefined;
}

function getCanonicalUrl(active: Element | null): string {
  const current = new URL(window.location.href);
  if (/(?:\/video|\/shipin)\//i.test(current.pathname)) return current.href;

  const activeVideo = getActiveVideoElement();
  const activeElements = [activeVideo, active, activeVideo?.closest("a") ?? null];
  for (const element of activeElements) {
    const href = parseDouyinVideoUrl(element?.getAttribute("href"));
    if (href) return href;
  }

  for (const container of getContainerCandidates(active)) {
    for (const link of getVisibleElements(container, SELECTORS.videoLinks)) {
      const href = parseDouyinVideoUrl(link.getAttribute("href"));
      if (href) return href;
    }
  }

  for (const element of activeElements) {
    const videoId = getDataVideoId(element);
    if (videoId) return `https://www.douyin.com/video/${videoId}`;
  }

  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
  return canonical || current.href;
}

export class DouyinAdapter implements SiteAdapter {
  matches(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.hostname === "douyin.com" || parsed.hostname.endsWith(".douyin.com");
    } catch {
      return false;
    }
  }

  hasCurrentVideo(): boolean {
    return Boolean(getActiveVideoElement());
  }

  getActiveVideoElement(): HTMLVideoElement | undefined {
    return getActiveVideoElement();
  }

  async getVisibleCaption(): Promise<string | undefined> {
    const active = getActiveVideoContainer();
    const candidates = getContainerCandidates(active);
    for (const container of candidates) {
      const caption = bestTextCandidate(getVisibleElements(container, SELECTORS.caption), scoreCaption);
      if (caption) return caption;
    }

    // Last resort: the page may render the caption as a plain visible paragraph.
    const fallbackNodes = getVisibleElements(document, ["p", "span", "div"]).filter((element) => {
      const text = normalizeText(element.textContent);
      return text.includes("#") && text.length >= 2 && text.length <= 1600;
    });
    const visibleCaption = bestTextCandidate(fallbackNodes, scoreCaption);
    if (visibleCaption) return visibleCaption;

    // Metadata is page-visible to the browser but is only used as a final fallback.
    const ogDescription = document.querySelector<HTMLMetaElement>('meta[property="og:description"]')?.content;
    return normalizeText(ogDescription) || undefined;
  }

  async getVisibleSubtitles(): Promise<string | undefined> {
    // Subtitle extraction is intentionally reserved for Phase 3. The method is
    // present to keep the adapter contract ready without claiming it works yet.
    return undefined;
  }

  async getMetadata(): Promise<VideoMetadata> {
    const caption = await this.getVisibleCaption();
    const active = getActiveVideoContainer();
    const containers = getContainerCandidates(active);
    const author = containers
      .map((container) => bestTextCandidate(getVisibleElements(container, SELECTORS.author), scoreAuthor))
      .find(Boolean);
    const url = getCanonicalUrl(active);
    return {
      platform: "douyin",
      url,
      videoId: parseVideoId(url),
      author,
      caption,
      hashtags: extractHashtags(caption),
      extractedAt: new Date().toISOString()
    };
  }
}
