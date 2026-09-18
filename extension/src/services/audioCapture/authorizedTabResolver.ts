import {
  AUTHORIZATION_REQUIRED_MESSAGE,
  AuthorizedTabStore,
  isAuthorizedCaptureTarget,
  rawErrorMessage,
  safeAuthorization,
  safeTabUrl,
  type AuthorizationTab,
  type LastInvokedTab
} from "../actionAuthorization";

export interface AuthorizedTabResolverLogger {
  log(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

export type AuthorizedTabResolutionResult =
  | {
      ok: true;
      authorization: LastInvokedTab;
      tab: AuthorizationTab;
    }
  | {
      ok: false;
      code: "TAB_UNAVAILABLE";
      message: string;
      cause?: unknown;
    };

const consoleLogger: AuthorizedTabResolverLogger = {
  log(message, details) {
    if (details === undefined) {
      console.debug(message);
    } else {
      console.debug(message, details);
    }
  },
  error(message, details) {
    if (details === undefined) {
      console.error(message);
    } else {
      console.error(message, details);
    }
  },
};

async function clearInvalidAuthorization(
  store: AuthorizedTabStore,
  logger: AuthorizedTabResolverLogger,
): Promise<void> {
  try {
    await store.clear();
  } catch (error) {
    logger.error(
      `[audio-capture] authorization clear failed rawError=${rawErrorMessage(error)}`,
    );
  }
}

export async function resolveAuthorizedCaptureTab(
  store: AuthorizedTabStore,
  getTab: (tabId: number) => Promise<AuthorizationTab>,
  logger: AuthorizedTabResolverLogger = consoleLogger,
): Promise<AuthorizedTabResolutionResult> {
  logger.log("[audio-capture] resolving authorized tab");

  let resolution;
  try {
    resolution = await store.inspectAndResolve();
  } catch (error) {
    logger.error(
      `[audio-capture] session authorization read failed rawError=${rawErrorMessage(error)}`,
    );
    return {
      ok: false,
      code: "TAB_UNAVAILABLE",
      message: AUTHORIZATION_REQUIRED_MESSAGE,
      cause: error,
    };
  }

  logger.log(
    "[audio-capture] memory authorization=",
    safeAuthorization(resolution.memoryAuthorization),
  );
  logger.log(
    "[audio-capture] session authorization=",
    safeAuthorization(resolution.sessionAuthorization),
  );

  const authorization = resolution.authorization;
  if (!authorization) {
    return {
      ok: false,
      code: "TAB_UNAVAILABLE",
      message: AUTHORIZATION_REQUIRED_MESSAGE,
    };
  }

  logger.log(`[audio-capture] authorized tab id=${authorization.tabId}`);

  let tab: AuthorizationTab;
  try {
    tab = await getTab(authorization.tabId);
    logger.log("[audio-capture] tabs.get success");
  } catch (error) {
    logger.error(
      `[audio-capture] tabs.get failed rawError=${rawErrorMessage(error)}`,
    );
    await clearInvalidAuthorization(store, logger);
    return {
      ok: false,
      code: "TAB_UNAVAILABLE",
      message: AUTHORIZATION_REQUIRED_MESSAGE,
      cause: error,
    };
  }

  logger.log(`[audio-capture] tab active=${tab.active === true}`);
  logger.log(`[audio-capture] tab safe url=${safeTabUrl(tab.url)}`);

  if (!isAuthorizedCaptureTarget(authorization, tab)) {
    await clearInvalidAuthorization(store, logger);
    return {
      ok: false,
      code: "TAB_UNAVAILABLE",
      message:
        "最近一次通过工具栏授权的标签页已失效，或当前页面不是可捕获的抖音页面。请回到抖音页面，点击 Chrome 工具栏中的『视频文案助手』图标后重试。",
    };
  }

  logger.log("[audio-capture] authorization valid");
  return { ok: true, authorization, tab };
}
