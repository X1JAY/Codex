import { describe, expect, it, vi } from "vitest";
import {
  AuthorizedTabStore,
  type SessionStorageLike
} from "../actionAuthorization";
import { resolveAuthorizedCaptureTab } from "./authorizedTabResolver";

class SharedSessionStorage implements SessionStorageLike {
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

const silentLogger = {
  log: () => undefined,
  error: () => undefined
};

describe("authorized tab resolver", () => {
  it("uses in-memory authorization without waiting for storage.session", async () => {
    const storage: SessionStorageLike = {
      get: async () => {
        throw new Error("session should not be read");
      },
      set: async () => undefined,
      remove: async () => undefined
    };
    const store = new AuthorizedTabStore(storage);
    store.saveInMemory(
      { id: 101, windowId: 7, url: "https://www.douyin.com/video/123" },
      1_789_646_400_000
    );

    const result = await resolveAuthorizedCaptureTab(
      store,
      async (tabId) => ({
        id: tabId,
        windowId: 7,
        active: true,
        url: "https://www.douyin.com/video/123"
      }),
      silentLogger
    );

    expect(result.ok).toBe(true);
  });

  it("restores authorization from storage.session when Service Worker memory is empty", async () => {
    const storage = new SharedSessionStorage();
    const originalWorkerStore = new AuthorizedTabStore(storage);
    await originalWorkerStore.save(
      { id: 101, windowId: 7, url: "https://www.douyin.com/video/123" },
      1_789_646_400_000
    );

    const restartedWorkerStore = new AuthorizedTabStore(storage);
    expect(restartedWorkerStore.getMemory()).toBeUndefined();

    const result = await resolveAuthorizedCaptureTab(
      restartedWorkerStore,
      async (tabId) => ({
        id: tabId,
        windowId: 7,
        active: true,
        url: "https://www.douyin.com/video/123"
      }),
      silentLogger
    );

    expect(result.ok).toBe(true);
    expect(restartedWorkerStore.getMemory()?.tabId).toBe(101);
  });

  it("returns TAB_UNAVAILABLE when both memory and session are empty", async () => {
    const store = new AuthorizedTabStore(new SharedSessionStorage());
    const getTab = vi.fn();

    const result = await resolveAuthorizedCaptureTab(store, getTab, silentLogger);

    expect(result).toMatchObject({ ok: false, code: "TAB_UNAVAILABLE" });
    expect(getTab).not.toHaveBeenCalled();
  });

  it("invalidates authorization when the saved tab has been closed", async () => {
    const store = new AuthorizedTabStore(new SharedSessionStorage());
    await store.save(
      { id: 101, windowId: 7, url: "https://www.douyin.com/" },
      1_789_646_400_000
    );

    const result = await resolveAuthorizedCaptureTab(
      store,
      async () => {
        throw new Error("No tab with id: 101");
      },
      silentLogger
    );

    expect(result).toMatchObject({ ok: false, code: "TAB_UNAVAILABLE" });
    expect(store.getMemory()).toBeUndefined();
    await expect(store.readSession()).resolves.toBeUndefined();
  });

  it("invalidates authorization after the tab navigates away from Douyin", async () => {
    const store = new AuthorizedTabStore(new SharedSessionStorage());
    await store.save(
      { id: 101, windowId: 7, url: "https://www.douyin.com/" },
      1_789_646_400_000
    );

    const result = await resolveAuthorizedCaptureTab(
      store,
      async () => ({
        id: 101,
        windowId: 7,
        active: true,
        url: "https://example.com/"
      }),
      silentLogger
    );

    expect(result).toMatchObject({ ok: false, code: "TAB_UNAVAILABLE" });
    expect(store.getMemory()).toBeUndefined();
    await expect(store.readSession()).resolves.toBeUndefined();
  });
});
