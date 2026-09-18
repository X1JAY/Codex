import type { ResolverLogEntry, ResolverLogLevel } from "./types.js";

export class ResolverLogger {
  readonly entries: ResolverLogEntry[] = [];

  constructor(private readonly clock: () => Date = () => new Date()) {}

  info(phase: string, event: string, details?: Record<string, unknown>): void {
    this.write("info", phase, event, details);
  }

  warn(phase: string, event: string, details?: Record<string, unknown>): void {
    this.write("warn", phase, event, details);
  }

  error(phase: string, event: string, details?: Record<string, unknown>): void {
    this.write("error", phase, event, details);
  }

  private write(
    level: ResolverLogLevel,
    phase: string,
    event: string,
    details?: Record<string, unknown>
  ): void {
    const entry: ResolverLogEntry = {
      timestamp: this.clock().toISOString(),
      level,
      phase,
      event,
      ...(details ? { details } : {})
    };
    this.entries.push(entry);

    const suffix = details ? ` ${JSON.stringify(details)}` : "";
    const line = `[resolver][${level}][${phase}] ${event}${suffix}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
}
