import { resolveDouyinShareLink } from "./resolver.js";
import { writeReport } from "./report.js";

interface CliOptions {
  url?: string;
  output?: string;
  headed: boolean;
  timeoutMs: number;
  browserPath?: string;
}

function usage(): string {
  return `Douyin Content Resolver experiment

Usage:
  npm run resolver -- --url "https://v.douyin.com/..." [options]

Options:
  --url <url>              Douyin share URL to inspect
  --output <path>          Write the JSON report to this path
  --headed                 Show the normal Chrome/Edge window while resolving
  --timeout <milliseconds> Navigation and page timeout (default: 20000)
  --browser-path <path>    Explicit chrome.exe or msedge.exe path
  --help                   Show this help
`;
}

function readOptions(argv: string[]): CliOptions | "help" {
  const options: CliOptions = { headed: false, timeoutMs: 20_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return "help";
    if (argument === "--headed") {
      options.headed = true;
      continue;
    }
    const value = argv[index + 1];
    if (argument === "--url" && value) options.url = value;
    else if (argument === "--output" && value) options.output = value;
    else if (argument === "--browser-path" && value) options.browserPath = value;
    else if (argument === "--timeout" && value) {
      const timeoutMs = Number(value);
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error("--timeout 必须是至少 1000 毫秒的数字。");
      options.timeoutMs = timeoutMs;
    } else if (argument.startsWith("--")) {
      throw new Error(`未知或缺少参数：${argument}`);
    }
    if (argument !== "--headed") index += 1;
  }
  return options;
}

async function main(): Promise<void> {
  let options: CliOptions | "help";
  try {
    options = readOptions(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (options === "help") {
    console.log(usage());
    return;
  }
  if (!options.url) {
    console.error("缺少 --url。\n");
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const report = await resolveDouyinShareLink(options.url, options);
  console.log("\n=== Douyin Content Resolver report ===");
  console.log(JSON.stringify({
    status: report.status,
    finalUrl: report.navigation.finalUrl,
    videoId: report.video.videoId,
    author: report.video.author,
    titleOrDescription: report.video.titleOrDescription,
    visibleTextLength: report.video.visibleText.length,
    subtitles: report.subtitles,
    audio: {
      exists: report.audio.exists,
      usableInPage: report.audio.usableInPage,
      sourceCount: report.audio.sourceCount,
      sourceKinds: report.audio.sourceKinds
    },
    warnings: report.warnings,
    errors: report.errors
  }, null, 2));

  if (options.output) {
    const path = await writeReport(report, options.output);
    console.log(`\nJSON report written to: ${path}`);
  }
  if (report.status === "error") process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
