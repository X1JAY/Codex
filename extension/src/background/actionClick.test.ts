import { describe, expect, it } from "vitest";
import {
  AuthorizedTabStore,
  type SessionStorageLike
} from "../services/actionAuthorization";
import {
  handleToolbarActionClick,
  type ActionClickLogger
} from "./actionClick";

class TrackedSessionStorage implements SessionStorageLike {
  private values: Record<string, unknown> = {};

  constructor(
    private readonly events: string[],
    private readonly failSet = false,
  ) {}

  async get(_keys: string): Promise<Record<string, unknown>> {
    this.events.push("storage:get");
    return this.values;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.events.push("storage:set");
    if (this.failSet) {
      throw new Error("storage write failed");
    }
    this.values = { ...this.values, ...items };
  }

  async remove(keys: string): Promise<void> {
    this.events.push("storage:remove");
    const next = { ...this.values };
    delete next[keys];
    this.values = next;
  }
}

function trackedLogger(events: string[]): ActionClickLogger {
  return {
    log(message) {
      events.push(message);
    },
    error(message) {
      events.push(message);
    }
  };
}

describe("toolbar action click", () => {
  it("saves memory and calls sidePanel.open before starting asynchronous storage", async () => {
    const events: string[] = [];
    const store = new AuthorizedTabStore(new TrackedSessionStorage(events));

    const result = handleToolbarActionClick(
      { id: 101, windowId: 7, url: "https://www.douyin.com/video/123?token=hidden" },
      {
        store,
        logger: trackedLogger(events),
        now: () => 1_789_646_400_000,
        openSidePanel: async (tabId) => {
          events.push(`sidePanel:open:${tabId}`);
        }
      }
    );

    expect(result.status).toBe("started");
    if (result.status !== "started") throw new Error("expected action flow to start");
    await Promise.all([result.sidePanelTask, result.persistenceTask]);
    expect(store.getMemory()).toEqual({
      tabId: 101,
      windowId: 7,
      url: "https://www.douyin.com/video/123?token=hidden",
      invokedAt: 1_789_646_400_000
    });
    await expect(store.readSession()).resolves.toEqual(store.getMemory());
    expect(events).toContain("[action] authorization saved in memory");
    expect(events).toContain("[action] authorization persisted successfully");
    expect(events.indexOf("[action] authorization saved in memory"))
      .toBeLessThan(events.indexOf("sidePanel:open:101"));
    expect(events.indexOf("sidePanel:open:101"))
      .toBeLessThan(events.indexOf("storage:set"));
  });

  it("replaces the first authorization after a second toolbar click", async () => {
    const events: string[] = [];
    const store = new AuthorizedTabStore(new TrackedSessionStorage(events));
    const dependencies = {
      store,
      logger: trackedLogger(events),
      openSidePanel: async (_tabId: number) => undefined
    };

    const first = handleToolbarActionClick(
      { id: 101, windowId: 7, url: "https://www.douyin.com/" },
      { ...dependencies, now: () => 1_789_646_400_000 }
    );
    if (first.status !== "started") throw new Error("expected first action flow to start");
    await Promise.all([first.sidePanelTask, first.persistenceTask]);

    const second = handleToolbarActionClick(
      { id: 202, windowId: 8, url: "https://www.douyin.com/video/456" },
      { ...dependencies, now: () => 1_789_646_460_000 }
    );
    if (second.status !== "started") throw new Error("expected second action flow to start");
    await Promise.all([second.sidePanelTask, second.persistenceTask]);

    expect(store.getMemory()?.tabId).toBe(202);
    expect((await store.readSession())?.tabId).toBe(202);
  });

  it("does not save authorization or open the panel for a non-Douyin URL", async () => {
    const events: string[] = [];
    const store = new AuthorizedTabStore(new TrackedSessionStorage(events));

    const result = handleToolbarActionClick(
      { id: 101, windowId: 7, url: "https://example.com/" },
      {
        store,
        logger: trackedLogger(events),
        openSidePanel: async () => {
          events.push("sidePanel:open");
        }
      }
    );

    expect(result).toEqual({ status: "rejected", reason: "invalid-url" });
    expect(store.getMemory()).toBeUndefined();
    expect(events).not.toContain("storage:set");
    expect(events).not.toContain("sidePanel:open");
  });

  it("opens the Side Panel even when session persistence fails", async () => {
    const events: string[] = [];
    const store = new AuthorizedTabStore(new TrackedSessionStorage(events, true));

    const result = handleToolbarActionClick(
      { id: 101, windowId: 7, url: "https://www.douyin.com/" },
      {
        store,
        logger: trackedLogger(events),
        openSidePanel: async () => {
          events.push("sidePanel:open");
        }
      }
    );

    if (result.status !== "started") throw new Error("expected action flow to start");
    await Promise.all([result.sidePanelTask, result.persistenceTask]);
    expect(events).toContain("sidePanel:open");
    expect(events.some((event) => event.startsWith("[action] session persistence failed"))).toBe(true);
    expect(store.getMemory()?.tabId).toBe(101);
  });

  it("keeps authorization when opening the Side Panel fails", async () => {
    const events: string[] = [];
    const store = new AuthorizedTabStore(new TrackedSessionStorage(events));

    const result = handleToolbarActionClick(
      { id: 101, windowId: 7, url: "https://www.douyin.com/" },
      {
        store,
        logger: trackedLogger(events),
        openSidePanel: () => Promise.reject(new Error("user gesture unavailable"))
      }
    );

    if (result.status !== "started") throw new Error("expected action flow to start");
    await Promise.all([result.sidePanelTask, result.persistenceTask]);
    expect(events.some((event) => event.startsWith("[action] side panel open failed"))).toBe(true);
    expect(store.getMemory()?.tabId).toBe(101);
    expect((await store.readSession())?.tabId).toBe(101);
  });

  it("starts content-script ensure only after the user-gesture sidePanel.open call", async () => {
    const events: string[] = [];
    const store = new AuthorizedTabStore(new TrackedSessionStorage(events));

    const result = handleToolbarActionClick(
      { id: 303, windowId: 9, url: "https://www.douyin.com/video/303" },
      {
        store,
        logger: trackedLogger(events),
        openSidePanel: async (tabId) => { events.push(`sidePanel:open:${tabId}`); },
        ensureContentScript: async (tabId) => { events.push(`content:ensure:${tabId}`); },
      },
    );

    if (result.status !== "started") throw new Error("expected action flow to start");
    await Promise.all([result.sidePanelTask, result.persistenceTask, result.contentScriptTask]);
    expect(events.indexOf("sidePanel:open:303")).toBeLessThan(events.indexOf("content:ensure:303"));
  });
});
