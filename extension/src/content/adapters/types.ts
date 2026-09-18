import type { VideoMetadata } from "../../shared/types";

export interface SiteAdapter {
  matches(url: string): boolean;
  getMetadata(): Promise<VideoMetadata>;
  getVisibleCaption(): Promise<string | undefined>;
  getVisibleSubtitles(): Promise<string | undefined>;
}

