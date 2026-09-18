import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AudioCaptureController,
  audioCaptureStatusMatchesIdentity,
  resolveCaptureSessionId,
} from "./controller";
import {
  AUDIO_CAPTURE_GET_STATUS,
  type AudioCaptureResponse,
  type AudioCaptureStatus,
} from "./types";

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: AudioCaptureResponse) => void,
) => boolean | undefined;

const completedStatus: AudioCaptureStatus = {
  state: "completed",
  elapsedMs: 185_000,
  sessionId: "full-session-1",
  tabId: 381389381,
  purpose: "full-transcription",
  transcriptionState: "completed",
  transcriptLength: 128,
};

function registerWithStoredStatus(storedStatus: AudioCaptureStatus): RuntimeListener {
  let listener: RuntimeListener | undefined;
  const chromeMock = {
    runtime: {
      lastError: undefined,
      onMessage: {
        addListener: vi.fn((registered: RuntimeListener) => {
          listener = registered;
        }),
      },
    },
    offscreen: {
      hasDocument: vi.fn(async () => false),
    },
    storage: {
      session: {
        get: vi.fn(async () => ({ audioCaptureStatus: storedStatus })),
        set: vi.fn(async () => undefined),
      },
    },
  };
  vi.stubGlobal("chrome", chromeMock);
  new AudioCaptureController().register();
  if (!listener) throw new Error("AudioCaptureController did not register its runtime listener.");
  return listener;
}

function requestStatus(
  listener: RuntimeListener,
  message: { type: typeof AUDIO_CAPTURE_GET_STATUS; sessionId?: string; tabId?: number },
): Promise<AudioCaptureResponse> {
  return new Promise((resolve) => {
    const keepsChannelOpen = listener(message, {} as chrome.runtime.MessageSender, resolve);
    expect(keepsChannelOpen).toBe(true);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("audio capture session identity", () => {
  it("preserves an explicit full-video session id and generates one for short mode", () => {
    const create = vi.fn(() => "generated-short-session");

    expect(resolveCaptureSessionId("full-session-1", create)).toBe("full-session-1");
    expect(create).not.toHaveBeenCalled();
    expect(resolveCaptureSessionId(undefined, create)).toBe("generated-short-session");
  });

  it("matches both explicit sessionId and tabId", () => {
    expect(audioCaptureStatusMatchesIdentity(completedStatus, {
      sessionId: "full-session-1",
      tabId: 381389381,
    })).toBe(true);
    expect(audioCaptureStatusMatchesIdentity(completedStatus, {
      sessionId: "another-session",
      tabId: 381389381,
    })).toBe(false);
  });

  it("answers Side Panel GET_STATUS when sender.tab is undefined", async () => {
    const listener = registerWithStoredStatus(completedStatus);

    const response = await requestStatus(listener, {
      type: AUDIO_CAPTURE_GET_STATUS,
      sessionId: "full-session-1",
      tabId: 381389381,
    });

    expect(response.ok).toBe(true);
    expect(response.status).toEqual(completedStatus);
    expect(response.status?.sessionId).not.toBe("unknown");
  });

  it("does not return another session for an explicit status query", async () => {
    const listener = registerWithStoredStatus(completedStatus);

    const response = await requestStatus(listener, {
      type: AUDIO_CAPTURE_GET_STATUS,
      sessionId: "stale-session",
      tabId: 381389380,
    });

    expect(response).toEqual({ ok: true, status: { state: "idle", elapsedMs: 0 } });
  });
});
