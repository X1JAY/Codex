import {
  AuthorizedTabStore,
  isHttpDouyinUrl,
  isSameAuthorization,
  rawErrorMessage,
  safeAuthorization,
  safeTabUrl,
  type LastInvokedTab
} from "../services/actionAuthorization";

export interface ActionClickLogger {
  log(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

export interface ActionClickDependencies {
  store: AuthorizedTabStore;
  openSidePanel(tabId: number): Promise<void>;
  ensureContentScript?(tabId: number): Promise<unknown>;
  logger: ActionClickLogger;
  now?: () => number;
}

export type ActionClickResult =
  | {
      status: "started";
      authorization: LastInvokedTab;
      sidePanelTask: Promise<void>;
      persistenceTask: Promise<void>;
      contentScriptTask: Promise<void>;
    }
  | { status: "rejected"; reason: "missing-tab" | "invalid-url" };

export function handleToolbarActionClick(
  tab: Pick<chrome.tabs.Tab, "id" | "windowId" | "url">,
  dependencies: ActionClickDependencies,
): ActionClickResult {
  const { logger, store } = dependencies;
  logger.log("[action] onClicked fired");

  if (typeof tab.id !== "number" || typeof tab.windowId !== "number") {
    logger.error("[action] missing tab id or window id");
    return { status: "rejected", reason: "missing-tab" };
  }

  logger.log(`[action] tab id=${tab.id}`);
  logger.log(`[action] safe url=${safeTabUrl(tab.url)}`);

  if (!isHttpDouyinUrl(tab.url)) {
    logger.error("[action] rejected non-Douyin http/https tab");
    return { status: "rejected", reason: "invalid-url" };
  }
  logger.log("[action] tab validated");

  const authorization = store.saveInMemory(
    tab,
    dependencies.now?.() ?? Date.now(),
  );
  if (!authorization) {
    logger.error("[action] missing tab id or window id");
    return { status: "rejected", reason: "missing-tab" };
  }
  logger.log("[action] authorization saved in memory");

  // This call must remain before every await/storage operation so it executes
  // directly within chrome.action.onClicked's transient user gesture.
  logger.log("[action] calling sidePanel.open immediately");
  let sidePanelOpen: Promise<void>;
  try {
    sidePanelOpen = dependencies.openSidePanel(tab.id);
  } catch (error) {
    logger.error(`[action] side panel open failed rawError=${rawErrorMessage(error)}`);
    sidePanelOpen = Promise.resolve();
  }

  const sidePanelTask = sidePanelOpen
    .then(() => {
      logger.log("[action] side panel opened");
    })
    .catch((error: unknown) => {
      logger.error(`[action] side panel open failed rawError=${rawErrorMessage(error)}`);
    });

  const contentScriptTask = Promise.resolve()
    .then(() => dependencies.ensureContentScript?.(authorization.tabId))
    .then(() => {
      logger.log("[action] content script ready");
    })
    .catch((error: unknown) => {
      // Phase 4A retries this check before video discovery. Opening the panel
      // remains successful even when proactive injection is unavailable.
      logger.error(`[action] content script ensure failed rawError=${rawErrorMessage(error)}`);
    });

  logger.log("[action] persisting authorization to session");
  const persistenceTask = store
    .persistToSession(authorization)
    .then(() => store.readSession())
    .then((persisted) => {
      if (!isSameAuthorization(authorization, persisted)) {
        throw new Error("storage.session authorization verification mismatch");
      }
      logger.log(
        "[action] authorization persisted successfully",
        safeAuthorization(persisted),
      );
    })
    .catch((error: unknown) => {
      // Keep the synchronous in-memory authorization. Session storage is only
      // the recovery path after a future Service Worker restart.
      logger.error(`[action] session persistence failed rawError=${rawErrorMessage(error)}`);
    });

  return {
    status: "started",
    authorization,
    sidePanelTask,
    persistenceTask,
    contentScriptTask,
  };
}
