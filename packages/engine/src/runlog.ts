import type { FileSink } from "bun";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface LogLine {
  at: string;
  text: string;
}

/**
 * Backs a run's log with a file on disk while keeping a tail in memory, so the
 * TUI can attach to a run already in progress and still see recent context.
 */
export class RunLog {
  private readonly sink: FileSink;
  private readonly recent: LogLine[] = [];
  private readonly subscribers = new Set<(line: LogLine) => void>();

  constructor(
    readonly path: string,
    private readonly tailSize = 500,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.sink = Bun.file(path).writer();
  }

  write(text: string): void {
    const line: LogLine = { at: new Date().toISOString(), text };
    this.recent.push(line);
    if (this.recent.length > this.tailSize) this.recent.shift();
    this.sink.write(`${line.at} ${text}\n`);
    this.sink.flush();
    for (const fn of this.subscribers) {
      try {
        fn(line);
      } catch {
        /* a broken subscriber must not break the run */
      }
    }
  }

  tail(): LogLine[] {
    return [...this.recent];
  }

  subscribe(fn: (line: LogLine) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  async close(): Promise<void> {
    this.subscribers.clear();
    await this.sink.end();
  }
}
