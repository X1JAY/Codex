import { describe, expect, it, vi } from "vitest";
import {
  CONTENT_SCRIPT_BUNDLE,
  ContentScriptUnavailableError,
  ensureContentScript,
  isMissingContentScriptReceiver,
  pingContentScript,
  type ContentScriptBridgePlatform,
} from "./bridge";

const href = "https://www.douyin.com/video/123";
const pong = { ok: true as const, type: "CONTENT_SCRIPT_PONG" as const, href };

function platform(overrides: Partial<ContentScriptBridgePlatform> = {}): ContentScriptBridgePlatform {
  return {
    getTab: vi.fn(async (tabId) => ({ id: tabId, url: href, active: true })),
    sendMessage: vi.fn(async () => pong),
    executeScript: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("content-script PING", () => {
  it("accepts a valid PONG", async () => {
    const adapter = platform();
    await expect(pingContentScript(101, adapter)).resolves.toEqual(pong);
    expect(adapter.sendMessage).toHaveBeenCalledWith(101, { type: "CONTENT_SCRIPT_PING" });
  });

  it("identifies Chrome's missing-receiver error", async () => {
    const error = new Error("Could not establish connection. Receiving end does not exist.");
    const adapter = platform({ sendMessage: vi.fn(async () => { throw error; }) });
    await expect(pingContentScript(101, adapter)).rejects.toBe(error);
    expect(isMissingContentScriptReceiver(error)).toBe(true);
  });
});

describe("ensureContentScript", () => {
  it("does not inject when the existing content script answers PING", async () => {
    const adapter = platform();
    const result = await ensureContentScript(101, adapter);
    expect(result.injected).toBe(false);
    expect(adapter.executeScript).not.toHaveBeenCalled();
  });

  it("injects the built content bundle after a missing receiver and PINGs again", async () => {
    let pingCount = 0;
    const adapter = platform({
      sendMessage: vi.fn(async () => {
        pingCount += 1;
        if (pingCount === 1) {
          throw new Error("Could not establish connection. Receiving end does not exist.");
        }
        return pong;
      }),
    });

    const result = await ensureContentScript(202, adapter);

    expect(result.injected).toBe(true);
    expect(adapter.executeScript).toHaveBeenCalledWith(202, CONTENT_SCRIPT_BUNDLE);
    expect(adapter.sendMessage).toHaveBeenCalledTimes(2);
    expect(adapter.sendMessage).toHaveBeenNthCalledWith(2, 202, { type: "CONTENT_SCRIPT_PING" });
  });

  it("returns CONTENT_SCRIPT_UNAVAILABLE when PING still fails after injection", async () => {
    const adapter = platform({
      sendMessage: vi.fn(async () => {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }),
    });

    await expect(ensureContentScript(303, adapter)).rejects.toMatchObject({
      code: "CONTENT_SCRIPT_UNAVAILABLE",
      message: "页面脚本注入后仍无法建立通信。",
    });
    expect(adapter.executeScript).toHaveBeenCalledTimes(1);
  });

  it("refuses to inject into a non-Douyin URL", async () => {
    const adapter = platform({
      getTab: vi.fn(async () => ({ id: 404, url: "https://example.com/", active: true })),
    });

    await expect(ensureContentScript(404, adapter)).rejects.toBeInstanceOf(ContentScriptUnavailableError);
    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(adapter.executeScript).not.toHaveBeenCalled();
  });

  it("reports a missing tab without attempting PING or injection", async () => {
    const adapter = platform({
      getTab: vi.fn(async () => { throw new Error("No tab with id: 505"); }),
    });

    await expect(ensureContentScript(505, adapter)).rejects.toMatchObject({
      code: "CONTENT_SCRIPT_UNAVAILABLE",
      rawMessage: "No tab with id: 505",
    });
    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(adapter.executeScript).not.toHaveBeenCalled();
  });

  it("uses the exact authorized tab id for get, PING, and injection", async () => {
    let injected = false;
    const adapter = platform({
      sendMessage: vi.fn(async (tabId) => {
        expect(tabId).toBe(606);
        if (!injected) throw new Error("Receiving end does not exist.");
        return pong;
      }),
      executeScript: vi.fn(async (tabId) => {
        expect(tabId).toBe(606);
        injected = true;
      }),
    });

    await ensureContentScript(606, adapter);
    expect(adapter.getTab).toHaveBeenCalledWith(606);
  });

  it("does not inject again after the first injection made PING available", async () => {
    let injected = false;
    const adapter = platform({
      sendMessage: vi.fn(async () => {
        if (!injected) throw new Error("Receiving end does not exist.");
        return pong;
      }),
      executeScript: vi.fn(async () => { injected = true; }),
    });

    await ensureContentScript(707, adapter);
    await ensureContentScript(707, adapter);

    expect(adapter.executeScript).toHaveBeenCalledTimes(1);
  });
});

