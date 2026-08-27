import type { Redactor } from "./types";

export interface ExecOptions {
  env?: Record<string, string>;
  cwd?: string;
  signal?: AbortSignal;
  /** Receives redacted stderr/stdout lines as they arrive. */
  onLine?: (line: string) => void;
  redact?: Redactor;
  /** Fed to the process' stdin. */
  stdin?: ReadableStream | Blob | null;
  captureStdout?: boolean;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

const identity: Redactor = (s) => s;

/**
 * Runs a command, streaming redacted output to `onLine`. stderr is always
 * captured because dump tools report everything interesting there.
 */
export async function exec(cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const scrub = opts.redact ?? identity;
  const proc = Bun.spawn(cmd, {
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    cwd: opts.cwd,
    stdin: opts.stdin ?? "ignore",
    stdout: opts.captureStdout === false ? "ignore" : "pipe",
    stderr: "pipe",
    signal: opts.signal,
  });

  const [stdout, stderr] = await Promise.all([
    opts.captureStdout === false ? Promise.resolve("") : drain(proc.stdout, scrub),
    drain(proc.stderr, scrub, opts.onLine),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

/** Like `exec`, but throws with the tool's own stderr as the message. */
export async function execOrThrow(cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const result = await exec(cmd, opts);
  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim() || "no output").split("\n").slice(-6).join("\n");
    throw new Error(`${cmd[0]} exited with code ${result.code}: ${detail}`);
  }
  return result;
}

async function drain(
  stream: ReadableStream<Uint8Array> | number | undefined | null,
  scrub: Redactor,
  onLine?: (line: string) => void,
): Promise<string> {
  if (!stream || typeof stream === "number") return "";
  const decoder = new TextDecoder();
  let buffer = "";
  let all = "";
  for await (const chunk of stream as ReadableStream<Uint8Array>) {
    const text = scrub(decoder.decode(chunk, { stream: true }));
    all += text;
    if (!onLine) continue;
    buffer += text;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      onLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  if (onLine && buffer.trim()) onLine(buffer);
  return all;
}

export async function which(bin: string): Promise<string | null> {
  const result = await exec(["/usr/bin/env", "which", bin]);
  const path = result.stdout.trim();
  return result.code === 0 && path ? path : null;
}
