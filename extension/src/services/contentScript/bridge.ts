import { isHttpDouyinUrl, safeTabUrl } from "../actionAuthorization";
import { CONTENT_SCRIPT_PING, CONTENT_SCRIPT_PONG } from "../../shared/constants";
import type { ContentScriptPongResponse } from "../../shared/types";

export const CONTENT_SCRIPT_BUNDLE = "content.js";

export interface ContentScriptTargetTab {
  id?: number;
  url?: string;
  active?: boolean;
}

export interface ContentScriptBridgePlatform {
  getTab(tabId: number): Promise<ContentScriptTargetTab>;
  sendMessage(tabId: number, message: { type: typeof CONTENT_SCRIPT_PING }): Promise<unknown>;
  executeScript(tabId: number, file: string): Promise<void>;
}

export interface ContentScriptReadyResult {
  tab: ContentScriptTargetTab & { id: number; url: string; active: true };
  pong: ContentScriptPongResponse;
  injected: boolean;
}

export class ContentScriptUnavailableError extends Error {
  public readonly code = "CONTENT_SCRIPT_UNAVAILABLE" as const;

  public constructor(
    message: string,
    public readonly rawMessage?: string,
  ) {
    super(message);
    this.name = "ContentScriptUnavailableError";
  }
}

function rawErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export function isMissingContentScriptReceiver(error: unknown): boolean {
  const message = rawErrorMessage(error).toLowerCase();
  return message.includes("receiving end does not exist") ||
    message.includes("could not establish connection");
}

export const chromeContentScriptBridgePlatform: ContentScriptBridgePlatform = {
  getTab: (tabId) => chrome.tabs.get(tabId),
  sendMessage: (tabId, message) => new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response: unknown) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(response);
    });
  }),
  executeScript: async (tabId, file) => {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [file],
    });
  },
};

export async function pingContentScript(
  tabId: number,
  platform: ContentScriptBridgePlatform = chromeContentScriptBridgePlatform,
): Promise<ContentScriptPongResponse> {
  const response = await platform.sendMessage(tabId, { type: CONTENT_SCRIPT_PING });
  if (!response || typeof response !== "object") {
    throw new ContentScriptUnavailableError(
      "页面脚本没有返回 PONG。",
      "CONTENT_SCRIPT_PING returned an empty response.",
    );
  }
  const pong = response as Partial<ContentScriptPongResponse>;
  if (pong.ok !== true || pong.type !== CONTENT_SCRIPT_PONG || typeof pong.href !== "string") {
    throw new ContentScriptUnavailableError(
      "页面脚本返回了无效的 PONG。",
      "CONTENT_SCRIPT_PONG response schema mismatch.",
    );
  }
  return pong as ContentScriptPongResponse;
}

const ensureTasks = new Map<number, Promise<ContentScriptReadyResult>>();

async function ensureContentScriptInternal(
  tabId: number,
  platform: ContentScriptBridgePlatform,
): Promise<ContentScriptReadyResult> {
  let tab: ContentScriptTargetTab;
  try {
    tab = await platform.getTab(tabId);
  } catch (error) {
    throw new ContentScriptUnavailableError(
      "已授权的抖音标签页不存在。",
      rawErrorMessage(error),
    );
  }

  console.debug(`[phase4a] targetTabId=${tabId}`);
  console.debug(`[phase4a] targetTabUrl=${safeTabUrl(tab.url)}`);
  console.debug(`[phase4a] targetTabActive=${tab.active === true}`);

  if (tab.id !== tabId || !isHttpDouyinUrl(tab.url) || tab.active !== true) {
    throw new ContentScriptUnavailableError(
      "目标标签页不是当前已授权的抖音页面，已拒绝注入页面脚本。",
      `tabId=${String(tab.id)}, active=${String(tab.active)}, url=${safeTabUrl(tab.url)}`,
    );
  }

  try {
    const pong = await pingContentScript(tabId, platform);
    return {
      tab: tab as ContentScriptReadyResult["tab"],
      pong,
      injected: false,
    };
  } catch (error) {
    if (!isMissingContentScriptReceiver(error)) {
      if (error instanceof ContentScriptUnavailableError) throw error;
      throw new ContentScriptUnavailableError(
        "无法确认抖音页面脚本状态。",
        rawErrorMessage(error),
      );
    }
  }

  console.debug(`[phase4a] injectingContentScript tabId=${tabId} file=${CONTENT_SCRIPT_BUNDLE}`);
  try {
    await platform.executeScript(tabId, CONTENT_SCRIPT_BUNDLE);
  } catch (error) {
    throw new ContentScriptUnavailableError(
      "无法向已授权的抖音页面注入页面脚本。",
      rawErrorMessage(error),
    );
  }

  try {
    const pong = await pingContentScript(tabId, platform);
    return {
      tab: tab as ContentScriptReadyResult["tab"],
      pong,
      injected: true,
    };
  } catch (error) {
    throw new ContentScriptUnavailableError(
      "页面脚本注入后仍无法建立通信。",
      rawErrorMessage(error),
    );
  }
}

export function ensureContentScript(
  tabId: number,
  platform: ContentScriptBridgePlatform = chromeContentScriptBridgePlatform,
): Promise<ContentScriptReadyResult> {
  const existing = ensureTasks.get(tabId);
  if (existing) return existing;
  const task = ensureContentScriptInternal(tabId, platform).finally(() => {
    if (ensureTasks.get(tabId) === task) ensureTasks.delete(tabId);
  });
  ensureTasks.set(tabId, task);
  return task;
}

