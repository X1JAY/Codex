export const AUDIO_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg"
] as const;

export interface MediaRecorderConstructorLike {
  new (stream: MediaStream, options?: MediaRecorderOptions): MediaRecorder;
  isTypeSupported?: (mimeType: string) => boolean;
}

export function getSupportedAudioMimeTypes(
  recorderConstructor: MediaRecorderConstructorLike | undefined =
    typeof MediaRecorder === "undefined" ? undefined : MediaRecorder
): string[] {
  if (!recorderConstructor) return [];
  return AUDIO_MIME_CANDIDATES.filter((mimeType) => {
    try {
      return recorderConstructor.isTypeSupported?.(mimeType) ?? false;
    } catch {
      return false;
    }
  });
}

export function selectSupportedAudioMimeType(
  recorderConstructor: MediaRecorderConstructorLike | undefined =
    typeof MediaRecorder === "undefined" ? undefined : MediaRecorder
): string {
  const supported = getSupportedAudioMimeTypes(recorderConstructor);
  if (supported.length === 0) throw new Error("当前浏览器没有支持的音频 MediaRecorder MIME type。");
  return supported[0];
}
