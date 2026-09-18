export const LAST_INVOKED_TAB_STORAGE_KEY = "lastInvokedTab";

export const AUTHORIZATION_REQUIRED_MESSAGE =
  "尚未获得当前抖音标签页的捕获权限。请回到抖音页面，点击 Chrome 工具栏中的『视频文案助手』图标，然后再开始录制。";

export interface LastInvokedTab {
  tabId: number;
  windowId: number;
  url: string;
  invokedAt: number;
}

export interface AuthorizationResolution {
  memoryAuthorization?: LastInvokedTab;
  sessionAuthorization?: LastInvokedTab;
  authorization?: LastInvokedTab;
  source?: "memory" | "session";
}

export type AuthorizationTab = Pick<
  chrome.tabs.Tab,
  "id" | "windowId" | "url" | "active"
>;

export interface SessionStorageLike {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string): Promise<void>;
}

function isLastInvokedTab(value: unknown): value is LastInvokedTab {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<LastInvokedTab>;
  return (
    typeof candidate.tabId === "number" &&
    typeof candidate.windowId === "number" &&
    typeof candidate.url === "string" &&
    typeof candidate.invokedAt === "number"
  );
}

export function rawErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) {
      return message;
    }
  }
  return String(error);
}

export function isHttpDouyinUrl(url?: string): boolean {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();
    return hostname === "douyin.com" || hostname.endsWith(".douyin.com");
  } catch {
    return false;
  }
}

export function safeTabUrl(url?: string): string {
  if (!url) {
    return "<unavailable>";
  }

  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

export function safeAuthorization(
  authorization: LastInvokedTab | undefined,
): Record<string, unknown> | "<none>" {
  if (!authorization) {
    return "<none>";
  }

  return {
    tabId: authorization.tabId,
    windowId: authorization.windowId,
    url: safeTabUrl(authorization.url),
    invokedAt: authorization.invokedAt,
  };
}

export function isSameAuthorization(
  left: LastInvokedTab | undefined,
  right: LastInvokedTab | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left.tabId === right.tabId &&
      left.windowId === right.windowId &&
      left.url === right.url &&
      left.invokedAt === right.invokedAt,
  );
}

export function isAuthorizedCaptureTarget(
  invocation: LastInvokedTab | undefined,
  tab: AuthorizationTab | undefined,
): boolean {
  return Boolean(
    invocation &&
      tab &&
      typeof tab.id === "number" &&
      typeof tab.windowId === "number" &&
      tab.id === invocation.tabId &&
      tab.windowId === invocation.windowId &&
      tab.active === true &&
      isHttpDouyinUrl(tab.url),
  );
}

export class AuthorizedTabStore {
  private current?: LastInvokedTab;

  public constructor(private readonly storage: SessionStorageLike) {}

  public saveInMemory(
    tab: Pick<chrome.tabs.Tab, "id" | "windowId" | "url">,
    invokedAt = Date.now(),
  ): LastInvokedTab | undefined {
    if (typeof tab.id !== "number" || typeof tab.windowId !== "number") {
      return undefined;
    }

    const snapshot: LastInvokedTab = {
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url ?? "",
      invokedAt,
    };

    this.current = snapshot;
    return snapshot;
  }

  public getMemory(): LastInvokedTab | undefined {
    return this.current;
  }

  public restoreMemory(authorization: LastInvokedTab): void {
    this.current = authorization;
  }

  public clearMemory(): void {
    this.current = undefined;
  }

  public async persistToSession(authorization: LastInvokedTab): Promise<void> {
    await this.storage.set({
      [LAST_INVOKED_TAB_STORAGE_KEY]: authorization,
    });
  }

  public async readSession(): Promise<LastInvokedTab | undefined> {
    const values = await this.storage.get(LAST_INVOKED_TAB_STORAGE_KEY);
    const value = values[LAST_INVOKED_TAB_STORAGE_KEY];
    return isLastInvokedTab(value) ? value : undefined;
  }

  public async inspectAndResolve(): Promise<AuthorizationResolution> {
    const memoryAuthorization = this.current;
    if (memoryAuthorization) {
      return {
        memoryAuthorization,
        authorization: memoryAuthorization,
        source: "memory",
      };
    }

    const sessionAuthorization = await this.readSession();
    if (sessionAuthorization) {
      this.restoreMemory(sessionAuthorization);
    }

    return {
      ...(sessionAuthorization ? { sessionAuthorization } : {}),
      ...(sessionAuthorization ? { authorization: sessionAuthorization } : {}),
      ...(sessionAuthorization ? { source: "session" as const } : {}),
    };
  }

  public async save(
    tab: Pick<chrome.tabs.Tab, "id" | "windowId" | "url">,
    invokedAt = Date.now(),
  ): Promise<LastInvokedTab | undefined> {
    const authorization = this.saveInMemory(tab, invokedAt);
    if (!authorization) {
      return undefined;
    }

    try {
      await this.persistToSession(authorization);
      return authorization;
    } catch (error) {
      if (this.current === authorization) {
        this.clearMemory();
      }
      throw error;
    }
  }

  public async clear(): Promise<void> {
    this.clearMemory();
    await this.storage.remove(LAST_INVOKED_TAB_STORAGE_KEY);
  }

  public async invalidateIfTabClosed(tabId: number): Promise<boolean> {
    const { authorization: current } = await this.inspectAndResolve();
    if (!current || current.tabId !== tabId) {
      return false;
    }

    await this.clear();
    return true;
  }
}

export const authorizedTabStore = new AuthorizedTabStore({
  get: (keys) =>
    chrome.storage.session.get(keys) as Promise<Record<string, unknown>>,
  set: (items) => chrome.storage.session.set(items),
  remove: (keys) => chrome.storage.session.remove(keys),
});
