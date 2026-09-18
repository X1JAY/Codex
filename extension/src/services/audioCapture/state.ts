import type { AudioCaptureState } from "./types";

export type AudioCaptureEvent =
  | "REQUEST_START"
  | "RECORDING_STARTED"
  | "REQUEST_STOP"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED"
  | "RESET";

export function isAudioCaptureActive(state: AudioCaptureState): boolean {
  return state === "requesting" || state === "recording" || state === "stopping";
}

export function transitionAudioCaptureState(
  state: AudioCaptureState,
  event: AudioCaptureEvent
): AudioCaptureState {
  if (event === "RESET") return "idle";
  if (event === "REQUEST_START" && !isAudioCaptureActive(state)) return "requesting";
  if (event === "RECORDING_STARTED" && (state === "requesting" || state === "idle")) return "recording";
  if (event === "REQUEST_STOP" && (state === "requesting" || state === "recording")) return "stopping";
  if (event === "COMPLETED" && (state === "recording" || state === "stopping")) return "completed";
  if (event === "CANCELLED" && isAudioCaptureActive(state)) return "cancelled";
  if (event === "FAILED" && isAudioCaptureActive(state)) return "error";
  return state;
}
