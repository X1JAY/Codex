const DOUYIN_HOST_SUFFIXES = ["douyin.com", "iesdouyin.com"] as const;

function isAcceptedSuffix(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

export function isDouyinHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return DOUYIN_HOST_SUFFIXES.some((suffix) => isAcceptedSuffix(normalized, suffix));
}

export function parseInputUrl(value: string): URL {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("只接受 http 或 https 抖音分享链接。");
  }
  if (!isDouyinHost(parsed.hostname)) {
    throw new Error(`链接域名不是抖音分享域名：${parsed.hostname}`);
  }
  return parsed;
}

export function extractVideoId(value: string): string | undefined {
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
}

export function redactUrl(value: string): string {
  try {
    const parsed = new URL(value);
    for (const key of parsed.searchParams.keys()) parsed.searchParams.set(key, "[redacted]");
    if (parsed.hash) parsed.hash = "#redacted";
    return parsed.href;
  } catch {
    return "[invalid-url]";
  }
}

export function redactLogText(value: string): string {
  return value
    .replace(/\b(?:https?|wss?|bitbrowser):\/\/[^\s'"<>]+/gi, (match) => redactUrl(match))
    .replace(/((?:access[_-]?key|token|authorization|cookie|sig(?:nature)?)\s*[=:]\s*)[^&\s,}"']+/gi, "$1[redacted]");
}
