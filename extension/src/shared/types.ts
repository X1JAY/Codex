export interface VideoMetadata {
  platform: "douyin";
  url: string;
  videoId?: string;
  author?: string;
  caption?: string;
  hashtags: string[];
  durationSeconds?: number;
  extractedAt: string;
}

export type ExtractionErrorCode =
  | "NOT_DOUYIN"
  | "NO_CURRENT_VIDEO"
  | "CAPTION_NOT_FOUND"
  | "CONTENT_SCRIPT_UNAVAILABLE"
  | "UNKNOWN";

export type ExtractionStatus = "success" | "partial" | "error";

export interface ExtractionResponse {
  status: ExtractionStatus;
  metadata?: VideoMetadata;
  errorCode?: ExtractionErrorCode;
  message?: string;
}

export interface ExtractCurrentVideoMessage {
  type: "EXTRACT_CURRENT_VIDEO";
}

export interface ContentScriptPingMessage {
  type: "CONTENT_SCRIPT_PING";
}

export interface ContentScriptPongResponse {
  ok: true;
  type: "CONTENT_SCRIPT_PONG";
  href: string;
}
