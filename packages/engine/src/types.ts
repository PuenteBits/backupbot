import type { ParsedDsn, Target, VerifyMode } from "@backupbot/core";

export type Redactor = (text: string) => string;

export interface JobContext {
  target: Target;
  dsn: ParsedDsn;
  /** Absolute path the adapter must write its artifact to. */
  outPath: string;
  log: (line: string) => void;
  redact: Redactor;
  signal: AbortSignal;
}

export interface DumpResult {
  /** Recorded on the artifact, and what tells `restore` how to read it back. */
  format: string;
  /** Free-form details worth surfacing in the UI, e.g. server version. */
  notes?: Record<string, string>;
}

export interface VerifyReport {
  mode: VerifyMode;
  ok: boolean;
  detail: string;
  /** Objects/tables the verifier could actually see inside the archive. */
  objectCount?: number;
}

export interface ConnectionCheck {
  ok: boolean;
  serverVersion?: string;
  serverMajor?: number;
  error?: string;
  /** Which client binary would be used for this server. */
  client?: string;
}

export interface Adapter {
  engine: Target["engine"];
  /** Suffix appended to the artifact filename, including the leading dot. */
  extension(): Promise<string>;
  testConnection(dsn: ParsedDsn, redact: Redactor): Promise<ConnectionCheck>;
  dump(ctx: JobContext): Promise<DumpResult>;
  verifyArchive(ctx: JobContext): Promise<VerifyReport>;
  /** Restores into a throwaway container and counts what landed. */
  verifyRestore(ctx: JobContext): Promise<VerifyReport>;
  /** Command a human can run to restore this artifact themselves. */
  restoreHint(artifactPath: string): string;
}
