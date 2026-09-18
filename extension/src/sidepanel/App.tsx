import { useEffect, useState } from "react";
import { EXTRACTION_MESSAGE, isDouyinUrl } from "../shared/constants";
import type { ExtractionResponse, VideoMetadata } from "../shared/types";
import { normalizeAudioCaptureError, publicAudioCaptureError } from "../services/audioCapture/errors";
import { isAudioCaptureActive } from "../services/audioCapture/state";
import {
  AUDIO_CAPTURE_GET_STATUS,
  AUDIO_CAPTURE_START,
  AUDIO_CAPTURE_STATUS,
  AUDIO_CAPTURE_STOP,
  type AudioCaptureError,
  type AudioCapturePanelMessage,
  type AudioCaptureResponse,
  type AudioCaptureStage,
  type AudioCaptureStatus
} from "../services/audioCapture/types";
import {
  TRANSCRIPTION_GET_STATUS,
  TRANSCRIPTION_START,
  TRANSCRIPTION_STATUS,
  type TranscriptionPanelMessage,
  type TranscriptionResponse,
  type TranscriptionStatus
} from "../services/transcription/types";
import { isFullTranscriptionActive } from "../services/fullTranscription/logic";
import {
  FULL_TRANSCRIPTION_CANCEL,
  FULL_TRANSCRIPTION_GET_STATUS,
  FULL_TRANSCRIPTION_START,
  FULL_TRANSCRIPTION_STATUS,
  type FullTranscriptionPanelMessage,
  type FullTranscriptionResponse,
  type FullTranscriptionStatus
} from "../services/fullTranscription/types";
import { LearningAnalysisPanel } from "./LearningAnalysisPanel";

type ViewState = "idle" | "loading" | "completed" | "partial" | "error";

function sendExtractionMessage(tabId: number): Promise<ExtractionResponse> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: EXTRACTION_MESSAGE }, (response: ExtractionResponse | undefined) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (!response) {
        reject(new Error("内容脚本没有返回结果"));
        return;
      }
      resolve(response);
    });
  });
}

function sendAudioCaptureMessage(message: AudioCapturePanelMessage): Promise<AudioCaptureResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: AudioCaptureResponse | undefined) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        const rawMessage = runtimeError.message || "Chrome runtime.lastError 未提供 message。";
        const error: AudioCaptureError = {
          code: "TAB_CAPTURE_FAILED",
          stage: "offscreenMessage",
          message: "无法连接到音频捕获服务。",
          rawMessage
        };
        console.error("[audio-capture] runtime message failed", {
          stage: error.stage,
          rawError: rawMessage
        });
        reject(error);
        return;
      }
      resolve(response ?? {
        ok: false,
        error: {
          code: "TAB_CAPTURE_FAILED",
          stage: "offscreenMessage",
          message: "音频捕获没有返回结果。",
          rawMessage: "Chrome runtime message 没有返回 response。"
        }
      });
    });
  });
}

function sendTranscriptionMessage(message: TranscriptionPanelMessage): Promise<TranscriptionResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: TranscriptionResponse | undefined) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(response ?? {
        ok: false,
        error: {
          code: "INVALID_RESPONSE",
          stage: "response",
          message: "转写服务没有返回状态。"
        }
      });
    });
  });
}

function sendFullTranscriptionMessage(
  message: FullTranscriptionPanelMessage
): Promise<FullTranscriptionResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: FullTranscriptionResponse | undefined) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(response ?? {
        ok: false,
        error: {
          code: "INVALID_RESPONSE",
          stage: "response",
          message: "完整视频转写服务没有返回状态。"
        }
      });
    });
  });
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function formatSize(sizeBytes: number): string {
  return `${(sizeBytes / 1024).toFixed(1)} KB`;
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)} 秒`;
}

function isTranscriptionActive(status: TranscriptionStatus): boolean {
  return status.state === "capturing" ||
    status.state === "uploading" ||
    status.state === "transcribing";
}

function audioLog(event: string, details?: Record<string, unknown>): void {
  console.debug(`[audio-capture] ${event}`, details ?? "");
}

function localAudioError(
  message: string,
  stage: AudioCaptureStage = "resolveActiveTab",
  rawMessage?: string,
  tabId?: number
): AudioCaptureStatus {
  return {
    state: "error",
    elapsedMs: 0,
    ...(tabId === undefined ? {} : { tabId }),
    error: {
      code: "TAB_UNAVAILABLE",
      stage,
      message,
      ...(rawMessage ? { rawMessage } : {})
    }
  };
}

function errorAudioStatus(
  error: unknown,
  fallbackMessage: string,
  stage: AudioCaptureStage,
  tabId?: number
): AudioCaptureStatus {
  const normalized = publicAudioCaptureError(normalizeAudioCaptureError(
    error,
    "TAB_CAPTURE_FAILED",
    fallbackMessage,
    stage
  ));
  return {
    state: "error",
    elapsedMs: 0,
    ...(tabId === undefined ? {} : { tabId }),
    error: normalized
  };
}

function statusText(state: ViewState): string {
  switch (state) {
    case "loading":
      return "正在读取当前视频页面…";
    case "completed":
      return "已完成当前视频信息提取。";
    case "partial":
      return "已读取部分信息，还缺少可见视频文案。";
    case "error":
      return "暂时无法读取当前视频。";
    default:
      return "打开抖音视频后，点击下方按钮开始。";
  }
}

function errorMessage(response: ExtractionResponse): string {
  if (response.message) return response.message;
  switch (response.errorCode) {
    case "NOT_DOUYIN":
      return "当前页面不是抖音。";
    case "NO_CURRENT_VIDEO":
      return "未识别到当前正在观看的视频。";
    case "CAPTION_NOT_FOUND":
      return "识别到视频但没有获取到可见文案。";
    case "CONTENT_SCRIPT_UNAVAILABLE":
      return "抖音页面还没有加载插件脚本，请刷新页面后重试。";
    default:
      return "读取失败，请刷新抖音页面后重试。";
  }
}

function MetadataView({ metadata }: { metadata: VideoMetadata }) {
  return (
    <div className="result-stack">
      <section className="metadata-card">
        <div className="metadata-row">
          <span>作者</span>
          <strong>{metadata.author || "未识别"}</strong>
        </div>
        <div className="metadata-row">
          <span>视频 ID</span>
          <strong>{metadata.videoId || "未从 URL 安全解析"}</strong>
        </div>
        <div className="metadata-row metadata-row-column">
          <span>当前 URL</span>
          <a href={metadata.url} target="_blank" rel="noreferrer">
            {metadata.url}
          </a>
        </div>
      </section>

      <section className="content-section">
        <div className="section-heading">
          <h2>原视频文案</h2>
          <span>{metadata.caption ? "已获取" : "未获取"}</span>
        </div>
        <p className={metadata.caption ? "caption-text" : "empty-text"}>
          {metadata.caption || "当前页面没有找到可见文案。"}
        </p>
      </section>

      <section className="content-section">
        <div className="section-heading">
          <h2>可见话题标签</h2>
          <span>{metadata.hashtags.length} 个</span>
        </div>
        {metadata.hashtags.length > 0 ? (
          <div className="tag-list">
            {metadata.hashtags.map((tag) => (
              <span className="tag" key={tag}>#{tag}</span>
            ))}
          </div>
        ) : (
          <p className="empty-text">没有从可见文案中识别到话题标签。</p>
        )}
      </section>
    </div>
  );
}

function AudioCaptureView({
  status,
  disabled,
  onStart,
  onStop
}: {
  status: AudioCaptureStatus;
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const active = isAudioCaptureActive(status.state);
  const canStart = !active && !disabled;
  const errorMessage = status.error?.message;
  return (
    <section className="audio-capture-card">
      <div className="section-heading">
        <div>
          <p className="eyebrow">PHASE 3A · TAB AUDIO</p>
          <h2>当前标签页音频捕获</h2>
        </div>
        <span className={`capture-badge capture-${status.state}`}>{status.state}</span>
      </div>

      <p className="audio-help">只验证当前抖音标签页能否产生内存中的音频 Blob，不上传、不转写、不保存音频文件。</p>

      {status.state === "recording" ? (
        <div className="recording-progress" role="status">
          <strong>正在录制 {formatElapsed(status.elapsedMs)}</strong>
          <button className="secondary-button" onClick={onStop}>停止录制</button>
        </div>
      ) : null}
      {status.state === "requesting" ? <p className="capture-status-text">正在准备当前标签页音频…</p> : null}
      {status.state === "stopping" ? <p className="capture-status-text">正在停止录制并生成 Blob…</p> : null}
      {status.state === "cancelled" ? <p className="capture-status-text">录制已取消，可以重新测试。</p> : null}
      {errorMessage ? (
        <div className="capture-error" role="alert">
          <strong>音频捕获失败</strong>
          <span>阶段：{status.error?.stage ?? "unknown"}</span>
          <span>错误码：{status.error?.code}</span>
          <span>消息：{errorMessage}</span>
          <span>Chrome 原始错误：</span>
          <code>{status.error?.rawMessage ?? "未返回原始错误信息"}</code>
        </div>
      ) : null}

      {status.result ? (
        <div className="capture-result">
          <strong>音频捕获成功</strong>
          <div className="capture-result-grid">
            <span>格式</span><b>{status.result.mimeType}</b>
            <span>音轨</span><b>{status.result.audioTrackCount}</b>
            <span>大小</span><b>{formatSize(status.result.sizeBytes)}</b>
            <span>时长</span><b>{formatDuration(status.result.durationMs)}</b>
            <span>状态</span><b>ready</b>
            <span>Tab ID</span><b>{status.result.tabId}</b>
            <span>开始时间</span><b>{status.result.startedAt}</b>
            <span>结束时间</span><b>{status.result.endedAt}</b>
          </div>
        </div>
      ) : null}

      <button className="primary-button" onClick={onStart} disabled={!canStart}>
        {status.state === "completed" ? "再次测试音频捕获" : "测试音频捕获"}
      </button>
    </section>
  );
}

function TranscriptionView({
  status,
  captureStatus,
  copyState,
  disabled,
  onStart,
  onCopy
}: {
  status: TranscriptionStatus;
  captureStatus: AudioCaptureStatus;
  copyState: "idle" | "copied" | "error";
  disabled: boolean;
  onStart: () => void;
  onCopy: () => void;
}) {
  const active = isTranscriptionActive(status);
  let progressText: string | undefined;
  if (status.state === "capturing") {
    progressText = `正在捕获音频… ${formatElapsed(captureStatus.elapsedMs)}`;
  } else if (status.state === "uploading") {
    progressText = "正在上传音频…";
  } else if (status.state === "transcribing") {
    progressText = "正在识别口播…";
  } else if (status.state === "completed") {
    progressText = "转写完成";
  }

  return (
    <section className="transcription-card">
      <div className="section-heading">
        <div>
          <p className="eyebrow">PHASE 3B · SPEECH TO TEXT</p>
          <h2>口播转写</h2>
        </div>
        <span className={`capture-badge transcript-${status.state}`}>{status.state}</span>
      </div>

      <p className="audio-help">捕获约 15 秒当前标签页音频，发送到本机转写服务；音频不写入数据库或浏览器存储。</p>

      {progressText ? <p className="transcription-progress" role="status">{progressText}</p> : null}

      {status.error ? (
        <div className="capture-error" role="alert">
          <strong>转写失败</strong>
          <span>阶段：{status.error.stage}</span>
          <span>错误码：{status.error.code}</span>
          <span>消息：{status.error.message}</span>
          <span>原始错误：</span>
          <code>{status.error.rawMessage ?? "未返回原始错误信息"}</code>
        </div>
      ) : null}

      {status.result ? (
        <div className="transcript-result">
          <div className="section-heading">
            <h2>口播逐字稿</h2>
            <span>{status.result.language}</span>
          </div>
          <p>{status.result.text}</p>
          <button className="copy-button" onClick={onCopy}>
            {copyState === "copied" ? "已复制" : copyState === "error" ? "复制失败" : "复制逐字稿"}
          </button>
        </div>
      ) : null}

      <button className="primary-button transcription-button" onClick={onStart} disabled={active || disabled}>
        {active ? "转写进行中…" : status.state === "completed" ? "重新转写当前口播" : "转写当前口播"}
      </button>
    </section>
  );
}

type FullCopyTarget = "caption" | "transcript" | "all";
type CopyFeedback = "idle" | "copied" | "error";

function fullProgressText(status: FullTranscriptionStatus): string | undefined {
  switch (status.state) {
    case "readingVideo":
      return "正在读取视频信息…";
    case "preparing":
      return "正在准备完整视频…";
    case "capturing":
      return `正在录制：${formatElapsed(status.elapsedMs)} / ${formatElapsed(status.durationMs)}`;
    case "processing":
    case "uploading":
      return "正在处理音频…";
    case "transcribing":
      return "正在本地识别完整口播…";
    case "cancelling":
      return "正在取消并释放录音资源…";
    case "cancelled":
      return "已取消；不完整音频未上传。";
    case "completed":
      return "完整视频转写完成";
    default:
      return undefined;
  }
}

function copyButtonText(label: string, state: CopyFeedback): string {
  if (state === "copied") return "已复制";
  if (state === "error") return "复制失败";
  return label;
}

function FullTranscriptionView({
  status,
  copyFeedback,
  disabled,
  onStart,
  onCancel,
  onCopy
}: {
  status: FullTranscriptionStatus;
  copyFeedback: Record<FullCopyTarget, CopyFeedback>;
  disabled: boolean;
  onStart: () => void;
  onCancel: () => void;
  onCopy: (target: FullCopyTarget) => void;
}) {
  const active = isFullTranscriptionActive(status.state);
  const canCancel = status.state === "readingVideo" ||
    status.state === "preparing" ||
    status.state === "capturing";
  const progressText = fullProgressText(status);
  const metadata = status.result?.metadata ?? status.metadata;
  const transcript = status.result?.transcript;
  const progressPercent = Math.round(Math.min(1, Math.max(0, status.progress ?? 0)) * 100);

  return (
    <section className="full-transcription-card">
      <div className="section-heading">
        <div>
          <p className="eyebrow">PHASE 4A · FULL VIDEO</p>
          <h2>完整视频口播转写</h2>
        </div>
        <span className={`capture-badge full-${status.state}`}>{status.state}</span>
      </div>

      <p className="audio-help">自动从当前视频开头录到结尾，最多支持 10 分钟；音频只在内存中用于本机 Whisper 转写。</p>

      {progressText ? <p className="full-progress-text" role="status">{progressText}</p> : null}
      {status.state === "capturing" ? (
        <div className="full-progress-track" aria-label={`录制进度 ${progressPercent}%`}>
          <span style={{ width: `${progressPercent}%` }} />
        </div>
      ) : null}

      {status.state === "error" && status.error ? (
        <div className="capture-error" role="alert">
          <strong>完整视频转写失败</strong>
          <span>阶段：{status.error.stage}</span>
          <span>错误码：{status.error.code}</span>
          <span>消息：{status.error.message}</span>
          <span>原始错误：</span>
          <code>{status.error.rawMessage ?? "未返回原始错误信息"}</code>
        </div>
      ) : null}

      {status.warning ? <p className="restore-warning">播放状态恢复提示：{status.warning}</p> : null}

      {metadata ? (
        <div className="full-video-info">
          <div className="section-heading">
            <h2>视频信息</h2>
            <span>{formatElapsed(metadata.durationSeconds * 1000)}</span>
          </div>
          <div className="capture-result-grid">
            <span>作者</span><b>{metadata.author || "未识别"}</b>
            <span>时长</span><b>{formatElapsed(metadata.durationSeconds * 1000)}</b>
            <span>视频 ID</span><b>{metadata.videoId || "未识别"}</b>
            <span>链接</span><a href={metadata.url} target="_blank" rel="noreferrer">打开视频</a>
          </div>
          <div className="full-copy-section">
            <strong>原视频文案</strong>
            <p>{metadata.caption || "当前页面没有找到可见文案。"}</p>
          </div>
        </div>
      ) : null}

      {transcript ? (
        <div className="full-transcript-result">
          <div className="section-heading">
            <h2>完整口播逐字稿</h2>
            <span>{transcript.language} · {transcript.model}</span>
          </div>
          <p>{transcript.text}</p>
          <div className="copy-grid">
            <button className="copy-button" onClick={() => onCopy("caption")} disabled={!metadata?.caption}>
              {copyButtonText("复制原文案", copyFeedback.caption)}
            </button>
            <button className="copy-button" onClick={() => onCopy("transcript")}>
              {copyButtonText("复制完整逐字稿", copyFeedback.transcript)}
            </button>
            <button className="copy-button" onClick={() => onCopy("all")}>
              {copyButtonText("复制全部", copyFeedback.all)}
            </button>
          </div>
          <div className="capture-result-grid full-capture-details">
            <span>Blob</span><b>{formatSize(status.result?.capture.sizeBytes ?? 0)}</b>
            <span>捕获时长</span><b>{formatDuration(status.result?.capture.durationMs ?? 0)}</b>
          </div>
        </div>
      ) : null}

      {canCancel ? (
        <button className="cancel-button" onClick={onCancel}>取消</button>
      ) : (
        <button
          className="primary-button full-transcription-button"
          onClick={onStart}
          disabled={active || disabled}
        >
          {active ? "完整转写进行中…" : status.state === "completed" ? "重新转写完整视频" : "转写完整视频"}
        </button>
      )}
    </section>
  );
}

export default function App() {
  const [state, setState] = useState<ViewState>("idle");
  const [message, setMessage] = useState(statusText("idle"));
  const [metadata, setMetadata] = useState<VideoMetadata>();
  const [audioStatus, setAudioStatus] = useState<AudioCaptureStatus>({ state: "idle", elapsedMs: 0 });
  const [transcriptionStatus, setTranscriptionStatus] = useState<TranscriptionStatus>({ state: "idle" });
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [fullStatus, setFullStatus] = useState<FullTranscriptionStatus>({
    state: "idle",
    elapsedMs: 0,
    durationMs: 0
  });
  const [fullCopyFeedback, setFullCopyFeedback] = useState<Record<FullCopyTarget, CopyFeedback>>({
    caption: "idle",
    transcript: "idle",
    all: "idle"
  });

  useEffect(() => {
    const listener = (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const value = message as {
        target?: unknown;
        type?: unknown;
        status?: AudioCaptureStatus | TranscriptionStatus | FullTranscriptionStatus;
      };
      if (value.target === "sidepanel" && value.type === AUDIO_CAPTURE_STATUS && value.status) {
        setAudioStatus(value.status as AudioCaptureStatus);
      }
      if (value.target === "sidepanel" && value.type === TRANSCRIPTION_STATUS && value.status) {
        setTranscriptionStatus(value.status as TranscriptionStatus);
      }
      if (value.target === "sidepanel" && value.type === FULL_TRANSCRIPTION_STATUS && value.status) {
        setFullStatus(value.status as FullTranscriptionStatus);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    void sendTranscriptionMessage({ type: TRANSCRIPTION_GET_STATUS }).then((response) => {
      if (response.status) setTranscriptionStatus(response.status);
    }).catch((error: unknown) => {
      console.debug("[sidepanel] transcription status unavailable", error);
    });
    void sendFullTranscriptionMessage({ type: FULL_TRANSCRIPTION_GET_STATUS }).then((response) => {
      if (response.status) {
        setFullStatus(response.status);
      }
      return sendAudioCaptureMessage({
        type: AUDIO_CAPTURE_GET_STATUS,
        sessionId: response.status?.sessionId,
        tabId: response.status?.tabId,
      });
    }).then((response) => {
      if (response.status) setAudioStatus(response.status);
    }).catch((error: unknown) => {
      console.debug("[sidepanel] status refresh unavailable", error);
    });
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  async function handleExtract() {
    setState("loading");
    setMetadata(undefined);
    setMessage(statusText("loading"));

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !isDouyinUrl(tab.url)) {
        setState("error");
        setMessage("当前页面不是抖音，请先打开一个抖音视频页面。");
        return;
      }

      const response = await sendExtractionMessage(tab.id);
      setMetadata(response.metadata);
      setState(response.status === "success" ? "completed" : response.status);
      setMessage(response.status === "success" ? statusText("completed") : errorMessage(response));
    } catch (error) {
      console.error("[sidepanel] failed to contact content script", error);
      setState("error");
      setMessage("抖音页面还没有加载插件脚本，请刷新当前页面后重试。");
    }
  }

  async function handleAudioStart() {
    audioLog("sidepanel button clicked");
    if (isAudioCaptureActive(audioStatus.state)) return;
    setAudioStatus({ state: "requesting", elapsedMs: 0 });
    audioLog("sending START_CAPTURE message");
    try {
      const response = await sendAudioCaptureMessage({ type: AUDIO_CAPTURE_START });
      setAudioStatus(response.status ?? (response.error ? {
        state: "error",
        elapsedMs: 0,
        error: response.error
      } : localAudioError("音频捕获没有返回状态。", "offscreenMessage")));
    } catch (error) {
      const status = errorAudioStatus(
        error,
        "无法启动当前标签页音频捕获。",
        "offscreenMessage"
      );
      console.error("[audio-capture] sidepanel start failed", {
        stage: status.error?.stage,
        code: status.error?.code,
        rawError: status.error?.rawMessage ?? status.error?.message
      });
      setAudioStatus(status);
    }
  }

  async function handleAudioStop() {
    if (!isAudioCaptureActive(audioStatus.state)) return;
    setAudioStatus({ ...audioStatus, state: "stopping" });
    try {
      const response = await sendAudioCaptureMessage({ type: AUDIO_CAPTURE_STOP });
      if (response.status) setAudioStatus(response.status);
      else if (response.error) setAudioStatus({ ...audioStatus, state: "error", error: response.error });
    } catch (error) {
      const status = errorAudioStatus(error, "停止录音失败，请刷新扩展后重试。", "offscreenMessage", audioStatus.tabId);
      console.error("[audio-capture] sidepanel stop failed", {
        stage: status.error?.stage,
        code: status.error?.code,
        rawError: status.error?.rawMessage ?? status.error?.message
      });
      setAudioStatus(status);
    }
  }

  async function handleTranscriptionStart() {
    if (isTranscriptionActive(transcriptionStatus)) return;
    setCopyState("idle");
    setTranscriptionStatus({ state: "capturing" });
    try {
      const response = await sendTranscriptionMessage({ type: TRANSCRIPTION_START });
      if (response.status) {
        setTranscriptionStatus(response.status);
      } else if (response.error) {
        setTranscriptionStatus({ state: "error", error: response.error });
      }
    } catch (error) {
      setTranscriptionStatus({
        state: "error",
        error: {
          code: "TRANSCRIPTION_FAILED",
          stage: "transcription",
          message: "无法连接扩展转写服务。",
          rawMessage: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  async function handleCopyTranscript() {
    const text = transcriptionStatus.result?.text;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch (error) {
      console.error("[transcription] clipboard write failed", error);
      setCopyState("error");
    }
  }

  async function handleFullTranscriptionStart() {
    if (isFullTranscriptionActive(fullStatus.state)) return;
    setFullCopyFeedback({ caption: "idle", transcript: "idle", all: "idle" });
    setFullStatus({ state: "readingVideo", elapsedMs: 0, durationMs: 0 });
    try {
      const response = await sendFullTranscriptionMessage({ type: FULL_TRANSCRIPTION_START });
      if (response.status) {
        setFullStatus(response.status);
      } else if (response.error) {
        setFullStatus({
          state: "error",
          elapsedMs: 0,
          durationMs: 0,
          error: response.error
        });
      }
    } catch (error) {
      setFullStatus({
        state: "error",
        elapsedMs: 0,
        durationMs: 0,
        error: {
          code: "TRANSCRIPTION_FAILED",
          stage: "response",
          message: "无法连接扩展完整视频转写服务。",
          rawMessage: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  async function handleFullTranscriptionCancel() {
    try {
      const response = await sendFullTranscriptionMessage({ type: FULL_TRANSCRIPTION_CANCEL });
      if (response.status) setFullStatus(response.status);
    } catch (error) {
      setFullStatus((current) => ({
        ...current,
        state: "error",
        error: {
          code: "FULL_CAPTURE_CANCELLED",
          stage: "response",
          message: "取消完整视频转写时发生错误。",
          rawMessage: error instanceof Error ? error.message : String(error)
        }
      }));
    }
  }

  async function handleFullCopy(target: FullCopyTarget) {
    const result = fullStatus.result;
    if (!result) return;
    const caption = result.metadata.caption ?? "";
    const transcript = result.transcript.text;
    const all = [
      `作者：${result.metadata.author || "未识别"}`,
      `视频 ID：${result.metadata.videoId || "未识别"}`,
      `时长：${formatElapsed(result.metadata.durationSeconds * 1000)}`,
      `链接：${result.metadata.url}`,
      `话题：${result.metadata.hashtags.length > 0 ? result.metadata.hashtags.map((tag) => `#${tag}`).join(" ") : "无"}`,
      "",
      "【原视频文案】",
      caption || "（未获取）",
      "",
      "【完整口播逐字稿】",
      transcript
    ].join("\n");
    const text = target === "caption" ? caption : target === "transcript" ? transcript : all;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setFullCopyFeedback((current) => ({ ...current, [target]: "copied" }));
    } catch (error) {
      console.error("[full-transcription] clipboard write failed", error);
      setFullCopyFeedback((current) => ({ ...current, [target]: "error" }));
    }
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">DOUYIN ADAPTER · PHASE 2</p>
          <h1>视频文案助手</h1>
        </div>
        <span className="platform-badge">抖音</span>
      </header>

      <section className="intro-card">
        <p>读取当前正在观看的视频页面，提取 URL、作者、发布文案和可见话题标签。</p>
        <button className="primary-button" onClick={handleExtract} disabled={state === "loading"}>
          {state === "loading" ? "读取中…" : "提取当前视频"}
        </button>
      </section>

      <p className={`status-line status-${state}`} role="status">{message}</p>

      {metadata ? <MetadataView metadata={metadata} /> : null}

      <AudioCaptureView
        status={audioStatus}
        disabled={isFullTranscriptionActive(fullStatus.state) || isTranscriptionActive(transcriptionStatus)}
        onStart={() => void handleAudioStart()}
        onStop={() => void handleAudioStop()}
      />

      <TranscriptionView
        status={transcriptionStatus}
        captureStatus={audioStatus}
        copyState={copyState}
        disabled={isFullTranscriptionActive(fullStatus.state) || isAudioCaptureActive(audioStatus.state)}
        onStart={() => void handleTranscriptionStart()}
        onCopy={() => void handleCopyTranscript()}
      />

      <FullTranscriptionView
        status={fullStatus}
        copyFeedback={fullCopyFeedback}
        disabled={isAudioCaptureActive(audioStatus.state) || isTranscriptionActive(transcriptionStatus)}
        onStart={() => void handleFullTranscriptionStart()}
        onCancel={() => void handleFullTranscriptionCancel()}
        onCopy={(target) => void handleFullCopy(target)}
      />

      <LearningAnalysisPanel fullStatus={fullStatus} />

      {state === "error" && !metadata ? (
        <section className="error-card">
          <strong>没有产生提取结果</strong>
          <p>{message}</p>
        </section>
      ) : null}

      <footer className="app-footer">
        <span>Phase 4A 保留完整视频原始逐字稿；Phase 4B 学习整理作为独立结果保存。</span>
        <span>音频仅用于当前转写请求，不写入浏览器存储或数据库。</span>
      </footer>
    </main>
  );
}
