export type ResolverStatus = "success" | "partial" | "blocked" | "error";

export type ResolverLogLevel = "info" | "warn" | "error";

export interface ResolverLogEntry {
  timestamp: string;
  level: ResolverLogLevel;
  phase: string;
  event: string;
  details?: Record<string, unknown>;
}

export interface RedirectHop {
  url: string;
  method?: string;
  status?: number;
}

export interface FieldEvidence {
  source: "url" | "link" | "visible-dom" | "meta" | "media-element" | "performance-resource" | "not-found";
  selector?: string;
  detail?: string;
}

export interface SubtitleResult {
  exists: boolean;
  confidence: "strong" | "weak" | "none";
  visibleText?: string;
  visibleNodeCount: number;
  trackCount: number;
  textTrackCount: number;
  evidence: string[];
}

export interface AudioResult {
  exists: boolean;
  usableInPage: boolean;
  mediaElementCount: number;
  readyMediaCount: number;
  sourceCount: number;
  sourceKinds: Array<"network" | "blob" | "data" | "unknown">;
  sourceUrls: string[];
  evidence: string[];
}

export interface VideoResult {
  videoId?: string;
  author?: string;
  titleOrDescription?: string;
  visibleText: string;
  evidence: {
    videoId: FieldEvidence;
    author: FieldEvidence;
    titleOrDescription: FieldEvidence;
    visibleText: FieldEvidence;
  };
}

export interface ResolverReport {
  schemaVersion: "1.0";
  resolverVersion: string;
  status: ResolverStatus;
  input: {
    shareUrl: string;
    acceptedHost: boolean;
    receivedAt: string;
  };
  navigation: {
    finalUrl?: string;
    responseStatus?: number;
    pageTitle?: string;
    redirectChain: RedirectHop[];
  };
  video: VideoResult;
  subtitles: SubtitleResult;
  audio: AudioResult;
  warnings: string[];
  errors: string[];
  logs: ResolverLogEntry[];
  environment?: {
    browser: "chrome" | "edge" | "custom";
    executablePath?: string;
    headless: boolean;
    platform: string;
  };
  startedAt: string;
  completedAt?: string;
}
