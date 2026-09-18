import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page, type Request, type Response } from "playwright-core";
import { ResolverLogger } from "./logging.js";
import { redactLogText, redactUrl } from "./url.js";
import type { RedirectHop } from "./types.js";

export interface BrowserOptions {
  headed: boolean;
  timeoutMs: number;
  browserPath?: string;
}

export interface NavigationResult {
  finalUrl: string;
  responseStatus?: number;
  redirectChain: RedirectHop[];
}

function commonBrowserPaths(): Array<{ kind: "chrome" | "edge"; path: string }> {
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  return [
    ...(localAppData
      ? [{ kind: "chrome" as const, path: join(localAppData, "Google", "Chrome", "Application", "chrome.exe") }]
      : []),
    ...(programFiles
      ? [{ kind: "chrome" as const, path: join(programFiles, "Google", "Chrome", "Application", "chrome.exe") }]
      : []),
    ...(programFilesX86
      ? [{ kind: "chrome" as const, path: join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe") }]
      : []),
    ...(programFiles
      ? [{ kind: "edge" as const, path: join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe") }]
      : []),
    ...(programFilesX86
      ? [{ kind: "edge" as const, path: join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe") }]
      : []),
    ...(localAppData
      ? [{ kind: "edge" as const, path: join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe") }]
      : [])
  ];
}

export function findBrowserExecutable(explicitPath?: string): { kind: "chrome" | "edge" | "custom"; path: string } | undefined {
  const requested = explicitPath || process.env.DOUYIN_BROWSER_PATH || process.env.CHROME_PATH || process.env.EDGE_PATH;
  if (requested) return existsSync(requested) ? { kind: "custom", path: requested } : undefined;
  return commonBrowserPaths().find((candidate) => existsSync(candidate.path));
}

function redirectChainFromResponse(response: Response | null): RedirectHop[] {
  if (!response) return [];
  const hops: RedirectHop[] = [];
  let request: Request | null = response.request();
  while (request) {
    hops.unshift({ url: redactUrl(request.url()), method: request.method() });
    request = request.redirectedFrom();
  }
  const last = hops[hops.length - 1];
  if (last) last.status = response.status();
  return hops;
}

export async function launchNormalBrowser(
  options: BrowserOptions,
  logger: ResolverLogger
): Promise<{ browser: Browser; kind: "chrome" | "edge" | "custom"; executablePath: string }> {
  const executable = findBrowserExecutable(options.browserPath);
  if (!executable) {
    throw new Error(
      "没有找到本机 Chrome/Edge。请使用 --browser-path 指定 chrome.exe 或 msedge.exe，或设置 DOUYIN_BROWSER_PATH。"
    );
  }
  logger.info("browser", "launch", {
    kind: executable.kind,
    executablePath: executable.path,
    headless: !options.headed
  });
  const browser = await chromium.launch({ executablePath: executable.path, headless: !options.headed });
  return { browser, kind: executable.kind, executablePath: executable.path };
}

export async function navigateNormally(
  page: Page,
  inputUrl: string,
  options: BrowserOptions,
  logger: ResolverLogger
): Promise<NavigationResult> {
  page.setDefaultTimeout(options.timeoutMs);
  page.on("console", (message) => {
    logger.info("page", "console", { type: message.type(), text: redactLogText(message.text()).slice(0, 500) });
  });
  page.on("pageerror", (error) => {
    logger.warn("page", "page-error", { message: error.message.slice(0, 500) });
  });

  logger.info("navigation", "goto", { url: redactUrl(inputUrl), waitUntil: "domcontentloaded" });
  const response = await page.goto(inputUrl, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
  const redirectChain = redirectChainFromResponse(response);

  try {
    await page.waitForLoadState("networkidle", { timeout: Math.min(options.timeoutMs, 3000) });
    logger.info("navigation", "network-idle");
  } catch {
    logger.warn("navigation", "network-idle-timeout", { note: "页面仍可能可读，继续采集当前 DOM。" });
  }

  await page.waitForTimeout(1000);
  const finalUrl = page.url();
  logger.info("navigation", "page-ready", {
    finalUrl: redactUrl(finalUrl),
    responseStatus: response?.status(),
    redirectCount: Math.max(0, redirectChain.length - 1)
  });
  return { finalUrl, responseStatus: response?.status(), redirectChain };
}
