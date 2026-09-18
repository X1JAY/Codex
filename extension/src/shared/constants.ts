export const EXTENSION_NAME = "视频文案助手";
export const EXTRACTION_MESSAGE = "EXTRACT_CURRENT_VIDEO" as const;
export const CONTENT_SCRIPT_PING = "CONTENT_SCRIPT_PING" as const;
export const CONTENT_SCRIPT_PONG = "CONTENT_SCRIPT_PONG" as const;

export function isDouyinUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "douyin.com" || url.hostname.endsWith(".douyin.com"));
  } catch {
    return false;
  }
}
