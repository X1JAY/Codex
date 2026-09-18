import {
  CONTENT_SCRIPT_PING,
  CONTENT_SCRIPT_PONG,
  EXTRACTION_MESSAGE,
} from "../shared/constants";
import type {
  ContentScriptPingMessage,
  ContentScriptPongResponse,
  ExtractionResponse,
  ExtractCurrentVideoMessage,
} from "../shared/types";
import {
  FULL_VIDEO_CONTENT_EVENT,
  FULL_VIDEO_HALT,
  FULL_VIDEO_PLAY,
  FULL_VIDEO_PREPARE,
  FULL_VIDEO_RESTORE,
  type FullTranscriptionError,
  type FullVideoContentEvent,
  type FullVideoContentMessage,
  type FullVideoContentResponse,
  type FullVideoIdentity,
} from "../services/fullTranscription/types";
import {
  FullVideoPlaybackSession,
  FullVideoSessionError,
  videoSource,
} from "../services/fullTranscription/videoSession";
import { DouyinAdapter, parseVideoId } from "./adapters/douyin";
import { initializeContentScriptOnce } from "../services/contentScript/initialization";

const adapter = new DouyinAdapter();
let fullVideoSession: FullVideoPlaybackSession | undefined;
let fullVideoSessionId: string | undefined;

function errorResponse(
  errorCode: ExtractionResponse["errorCode"],
  message: string
): ExtractionResponse {
  return { status: "error", errorCode, message };
}

async function extractCurrentVideo(): Promise<ExtractionResponse> {
  const url = window.location.href;
  if (!adapter.matches(url)) {
    return errorResponse("NOT_DOUYIN", "当前页面不是抖音，请打开抖音视频页面后再试。");
  }
  if (!adapter.hasCurrentVideo()) {
    return errorResponse("NO_CURRENT_VIDEO", "未识别到当前正在观看的视频，请先播放或滚动到目标视频。");
  }

  const metadata = await adapter.getMetadata();
  if (!metadata.caption) {
    return {
      status: "partial",
      errorCode: "CAPTION_NOT_FOUND",
      message: "已识别到当前视频，但没有获取到可见的视频文案。",
      metadata
    };
  }
  return { status: "success", metadata, message: "已提取当前视频的可见信息。" };
}

function fullVideoError(
  code: FullTranscriptionError["code"],
  stage: FullTranscriptionError["stage"],
  message: string,
  rawMessage?: string,
): FullVideoContentResponse {
  return { ok: false, error: { code, stage, message, ...(rawMessage ? { rawMessage } : {}) } };
}

function sendFullVideoEvent(event: FullVideoContentEvent): void {
  void chrome.runtime.sendMessage(event).catch((error: unknown) => {
    console.error("[full-transcription] failed to send content event", error);
  });
}

function currentIdentity(video: HTMLVideoElement, videoId?: string): FullVideoIdentity {
  return {
    pageUrl: window.location.href,
    source: videoSource(video),
    videoId: parseVideoId(window.location.href) ?? videoId,
  };
}

async function prepareFullVideo(message: FullVideoContentMessage): Promise<FullVideoContentResponse> {
  if (message.type !== FULL_VIDEO_PREPARE) {
    return fullVideoError("CONTENT_SCRIPT_UNAVAILABLE", "videoDiscovery", "无效的完整视频准备命令。");
  }
  if (!adapter.matches(window.location.href)) {
    return fullVideoError("VIDEO_NOT_FOUND", "videoDiscovery", "当前页面不是抖音视频页面。");
  }

  if (fullVideoSession) {
    fullVideoSession.halt();
    await fullVideoSession.restore();
    fullVideoSession = undefined;
    fullVideoSessionId = undefined;
  }

  const video = adapter.getActiveVideoElement();
  if (!video) {
    return fullVideoError(
      "VIDEO_NOT_FOUND",
      "videoDiscovery",
      "未识别到当前真正播放的抖音视频。",
    );
  }

  const metadata = await adapter.getMetadata();
  const identity = currentIdentity(video, metadata.videoId);
  const session = new FullVideoPlaybackSession({
    video,
    identity,
    getActiveVideo: () => adapter.getActiveVideoElement(),
    getCurrentIdentity: () => currentIdentity(video, metadata.videoId),
    events: {
      onProgress: (progress) => sendFullVideoEvent({
        target: "background",
        type: FULL_VIDEO_CONTENT_EVENT,
        sessionId: message.sessionId,
        event: "progress",
        ...progress,
      }),
      onCompleted: (details) => sendFullVideoEvent({
        target: "background",
        type: FULL_VIDEO_CONTENT_EVENT,
        sessionId: message.sessionId,
        event: "completed",
        ...details,
      }),
      onError: (error) => sendFullVideoEvent({
        target: "background",
        type: FULL_VIDEO_CONTENT_EVENT,
        sessionId: message.sessionId,
        event: "error",
        error,
      }),
    },
  });

  fullVideoSession = session;
  fullVideoSessionId = message.sessionId;
  try {
    const startOffsetSeconds = await session.prepare();
    const playbackState = session.originalPlaybackState;
    return {
      ok: true,
      prepared: {
        metadata: {
          ...metadata,
          durationSeconds: playbackState.duration,
        },
        playbackState,
        identity,
        startOffsetSeconds,
      },
    };
  } catch (error) {
    const warning = await session.restore();
    fullVideoSession = undefined;
    fullVideoSessionId = undefined;
    if (error instanceof FullVideoSessionError) {
      return { ok: false, error: error.details, ...(warning ? { warning } : {}) };
    }
    return fullVideoError(
      "VIDEO_SEEK_FAILED",
      "seek",
      "无法准备当前视频。",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function handleFullVideoMessage(message: FullVideoContentMessage): Promise<FullVideoContentResponse> {
  if (message.type === FULL_VIDEO_PREPARE) return prepareFullVideo(message);
  if (!fullVideoSession || fullVideoSessionId !== message.sessionId) {
    return fullVideoError(
      "VIDEO_CHANGED_DURING_CAPTURE",
      "monitor",
      "完整视频会话已失效，页面可能已经切换。",
    );
  }

  if (message.type === FULL_VIDEO_PLAY) {
    try {
      await fullVideoSession.start();
      return { ok: true };
    } catch (error) {
      if (error instanceof FullVideoSessionError) return { ok: false, error: error.details };
      return fullVideoError(
        "VIDEO_PLAY_FAILED",
        "playback",
        "无法播放当前视频。",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (message.type === FULL_VIDEO_HALT) {
    fullVideoSession.halt();
    return { ok: true };
  }

  if (message.type === FULL_VIDEO_RESTORE) {
    const warning = await fullVideoSession.restore();
    fullVideoSession = undefined;
    fullVideoSessionId = undefined;
    return { ok: true, ...(warning ? { warning } : {}) };
  }

  return fullVideoError("CONTENT_SCRIPT_UNAVAILABLE", "videoDiscovery", "未知的完整视频命令。");
}

initializeContentScriptOnce(
  globalThis as unknown as Record<string, unknown>,
  () => chrome.runtime.onMessage.addListener(
    (
      message: ExtractCurrentVideoMessage | FullVideoContentMessage | ContentScriptPingMessage,
      _sender,
      sendResponse,
    ) => {
    if (message?.type === CONTENT_SCRIPT_PING) {
      sendResponse({
        ok: true,
        type: CONTENT_SCRIPT_PONG,
        href: window.location.href,
      } satisfies ContentScriptPongResponse);
      return false;
    }
    if (message?.type === EXTRACTION_MESSAGE) {
      void extractCurrentVideo()
        .then(sendResponse)
        .catch((error: unknown) => {
          console.error("[douyin-adapter] extraction failed", error);
          sendResponse(errorResponse("UNKNOWN", "读取当前视频时发生未知错误，请刷新页面后重试。"));
        });
      return true;
    }
    if (message && typeof message === "object" && "target" in message && message.target === "content") {
      void handleFullVideoMessage(message as FullVideoContentMessage)
        .then(sendResponse)
        .catch((error: unknown) => {
          console.error("[full-transcription] content command failed", error);
          sendResponse(fullVideoError(
            "CONTENT_SCRIPT_UNAVAILABLE",
            "videoDiscovery",
            "页面视频控制脚本执行失败。",
            error instanceof Error ? error.message : String(error),
          ));
        });
      return true;
    }
    return false;
    },
  ),
);
