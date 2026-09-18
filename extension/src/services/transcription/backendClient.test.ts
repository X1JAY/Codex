import { describe, expect, it, vi } from "vitest";
import {
  BackendTranscriptionClient,
  TranscriptionClientError
} from "./backendClient";

describe("BackendTranscriptionClient", () => {
  it("calls fetch with the browser global as its receiver", async () => {
    let requestCount = 0;
    const fetchMock = vi.fn(function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      requestCount += 1;
      const body = requestCount === 1
        ? { ok: true }
        : { text: "绑定正确", language: "zh", duration_seconds: 1 };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });
    const client = new BackendTranscriptionClient(
      "http://127.0.0.1:8787",
      fetchMock as typeof fetch,
    );

    const result = await client.transcribe(new Blob(["audio"]), 1_000);

    expect(result.text).toBe("绑定正确");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uploads the Blob as multipart data and returns a valid transcript", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        text: "真实中文口播",
        language: "zh",
        duration_seconds: 15
      }), { status: 200 }));
    const stages: string[] = [];
    const client = new BackendTranscriptionClient(
      "http://127.0.0.1:8787",
      fetchMock as typeof fetch,
    );

    const result = await client.transcribe(
      new Blob(["audio"], { type: "audio/webm;codecs=opus" }),
      15_000,
      "zh",
      (stage) => stages.push(stage),
    );

    expect(result).toEqual({
      text: "真实中文口播",
      language: "zh",
      durationSeconds: 15
    });
    expect(stages).toEqual(["uploading", "transcribing"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const postInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(postInit.body).toBeInstanceOf(FormData);
  });

  it("logs HTTP success, JSON parsing, and transcript length without logging transcript text", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const transcript = "不要写进日志的中文逐字稿";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        text: transcript,
        language: "zh",
        duration_seconds: 15,
      }), { status: 200 }));
    const client = new BackendTranscriptionClient(
      "http://127.0.0.1:8787",
      fetchMock as typeof fetch,
    );

    await client.transcribe(new Blob(["audio"]), 15_000);

    const messages = debug.mock.calls.map(([message]) => String(message));
    expect(messages).toContain("[transcription] response status=200");
    expect(messages).toContain("[transcription] response parsed");
    expect(messages).toContain(`[transcription] textLength=${transcript.length}`);
    expect(messages.join("\n")).not.toContain(transcript);
    debug.mockRestore();
  });

  it("clamps recorder overhead to the backend ten-minute duration contract", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        text: "十分钟完整口播",
        language: "zh",
        duration_seconds: 600
      }), { status: 200 }));
    const client = new BackendTranscriptionClient(
      "http://127.0.0.1:8787",
      fetchMock as typeof fetch,
    );

    await client.transcribe(new Blob(["audio"]), 600_250);

    const form = fetchMock.mock.calls[1]?.[1]?.body as FormData;
    expect(form.get("duration_seconds")).toBe("600");
  });

  it("rejects an empty Blob without making a request", async () => {
    const fetchMock = vi.fn();
    const client = new BackendTranscriptionClient(
      "http://127.0.0.1:8787",
      fetchMock as typeof fetch,
    );

    await expect(client.transcribe(new Blob(), 0)).rejects.toMatchObject({
      code: "AUDIO_EMPTY",
      stage: "audioCapture"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports an unavailable backend with a friendly code", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const client = new BackendTranscriptionClient(
      "http://127.0.0.1:8787",
      fetchMock as typeof fetch,
    );

    await expect(client.transcribe(new Blob(["audio"]), 1_000)).rejects.toEqual(
      expect.objectContaining<Partial<TranscriptionClientError>>({
        code: "BACKEND_UNAVAILABLE",
        stage: "backendHealth",
        rawMessage: "Failed to fetch"
      }),
    );
  });

  it("rejects a successful HTTP response without transcript text", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        text: "",
        language: "zh",
        duration_seconds: 15
      }), { status: 200 }));
    const client = new BackendTranscriptionClient(
      "http://127.0.0.1:8787",
      fetchMock as typeof fetch,
    );

    await expect(client.transcribe(new Blob(["audio"]), 15_000)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      stage: "response"
    });
  });
});
