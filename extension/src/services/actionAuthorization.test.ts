import { describe, expect, it } from "vitest";
import {
  AuthorizedTabStore,
  isAuthorizedCaptureTarget,
  isHttpDouyinUrl,
  type SessionStorageLike
} from "./actionAuthorization";

class MemorySessionStorage implements SessionStorageLike {
  private values: Record<string, unknown> = {};

  async get(_keys: string): Promise<Record<string, unknown>> {
    return this.values;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.values = { ...this.values, ...items };
  }

  async remove(keys: string): Promise<void> {
    const next = { ...this.values };
    delete next[keys];
    this.values = next;
  }
}

describe("action invocation authorization", () => {
  it("saves the tab selected by an action click", async () => {
    const store = new AuthorizedTabStore(new MemorySessionStorage());

    const saved = await store.save(
      { id: 101, windowId: 7, url: "https://www.douyin.com/video/123" },
      1_789_646_400_000,
    );

    expect(saved).toEqual({
      tabId: 101,
      windowId: 7,
      url: "https://www.douyin.com/video/123",
      invokedAt: 1_789_646_400_000
    });
    expect(store.getMemory()).toEqual(saved);
    await expect(store.readSession()).resolves.toEqual(saved);
  });

  it("blocks capture when there is no action invocation", () => {
    expect(isAuthorizedCaptureTarget(undefined, {
      id: 101,
      windowId: 7,
      active: true,
      url: "https://www.douyin.com/video/123"
    })).toBe(false);
  });

  it("requires the capture target to be the same authorized active tab", async () => {
    const store = new AuthorizedTabStore(new MemorySessionStorage());
    const invocation = await store.save(
      { id: 101, windowId: 7, url: "https://www.douyin.com/" },
      1_789_646_400_000,
    );

    expect(isAuthorizedCaptureTarget(invocation, {
      id: 101,
      windowId: 7,
      active: true,
      url: "https://www.douyin.com/jingxuan?modal_id=123"
    })).toBe(true);
    expect(isAuthorizedCaptureTarget(invocation, {
      id: 102,
      windowId: 7,
      active: true,
      url: "https://www.douyin.com/"
    })).toBe(false);
    expect(isAuthorizedCaptureTarget(invocation, {
      id: 101,
      windowId: 7,
      active: false,
      url: "https://www.douyin.com/"
    })).toBe(false);
  });

  it("invalidates authorization when its tab is closed", async () => {
    const store = new AuthorizedTabStore(new MemorySessionStorage());
    await store.save({ id: 101, windowId: 7, url: "https://www.douyin.com/" });

    await expect(store.invalidateIfTabClosed(999)).resolves.toBe(false);
    await expect(store.invalidateIfTabClosed(101)).resolves.toBe(true);
    expect(store.getMemory()).toBeUndefined();
    await expect(store.readSession()).resolves.toBeUndefined();
  });

  it("rejects non-Douyin and non-http(s) URLs", () => {
    expect(isHttpDouyinUrl("https://www.douyin.com/video/123")).toBe(true);
    expect(isHttpDouyinUrl("https://sub.douyin.com/video/123")).toBe(true);
    expect(isHttpDouyinUrl("https://example.com/video/123")).toBe(false);
    expect(isHttpDouyinUrl("chrome://extensions")).toBe(false);
  });

  it("replaces the old authorization on the second action click", async () => {
    const store = new AuthorizedTabStore(new MemorySessionStorage());

    await store.save({ id: 101, windowId: 7, url: "https://www.douyin.com/" });
    const second = await store.save(
      { id: 202, windowId: 8, url: "https://www.douyin.com/video/456" },
      1_789_646_460_000,
    );

    expect(store.getMemory()).toEqual(second);
    await expect(store.readSession()).resolves.toEqual(second);
    expect(second?.tabId).toBe(202);
    expect(second?.windowId).toBe(8);
  });

  it("does not clear the new authorization when the old tab is removed", async () => {
    const store = new AuthorizedTabStore(new MemorySessionStorage());
    await store.save({ id: 101, windowId: 7, url: "https://www.douyin.com/video/old" });
    const current = await store.save({
      id: 202,
      windowId: 8,
      url: "https://www.douyin.com/video/current",
    });

    await expect(store.invalidateIfTabClosed(101)).resolves.toBe(false);
    expect(store.getMemory()).toEqual(current);
    await expect(store.readSession()).resolves.toEqual(current);
  });
});
