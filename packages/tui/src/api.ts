import type { Artifact, Engine, Retention, Run, SafeTarget, VerifyMode } from "@backupbot/core";
import type { DsnWarning } from "@backupbot/core";

export interface TargetView extends SafeTarget {
  lastRun: Run | null;
  nextRunAt: string | null;
  running: number | null;
  artifactCount: number;
  totalBytes: number;
}

export interface Stats {
  targets: number;
  enabled: number;
  running: number;
  failures24h: number;
  artifacts: number;
  totalBytes: number;
}

export interface ConnectionCheck {
  ok: boolean;
  serverVersion?: string;
  client?: string;
  error?: string;
  warnings: DsnWarning[];
}

export interface TargetPayload {
  name: string;
  engine: Engine;
  dsn?: string;
  schedule: string;
  timezone: string;
  retention: Retention;
  verify: VerifyMode;
  enabled: boolean;
}

export interface LogLine {
  at: string;
  text: string;
}

export class ApiError extends Error {}

export class Api {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      });
    } catch (err) {
      throw new ApiError(`cannot reach the engine at ${this.baseUrl} — ${(err as Error).message}`);
    }
    if (!response.ok) {
      const detail = await response
        .json()
        .then((body) => (body as { error?: string }).error)
        .catch(() => response.statusText);
      throw new ApiError(
        response.status === 401 ? "unauthorized — the API token is wrong" : (detail ?? response.statusText),
      );
    }
    return (await response.json()) as T;
  }

  health = () => this.request<{ ok: boolean }>("/health");
  stats = () => this.request<Stats>("/api/stats");
  targets = () => this.request<TargetView[]>("/api/targets");
  target = (ref: string) => this.request<TargetView>(`/api/targets/${ref}`);

  createTarget = (payload: TargetPayload) =>
    this.request<TargetView>("/api/targets", { method: "POST", body: JSON.stringify(payload) });

  updateTarget = (ref: string, payload: Partial<TargetPayload>) =>
    this.request<TargetView>(`/api/targets/${ref}`, { method: "PATCH", body: JSON.stringify(payload) });

  deleteTarget = (ref: string) => this.request<{ ok: true }>(`/api/targets/${ref}`, { method: "DELETE" });

  testConnection = (dsn: string, engine?: Engine) =>
    this.request<ConnectionCheck>("/api/test-connection", {
      method: "POST",
      body: JSON.stringify({ dsn, engine }),
    });

  testTarget = (ref: string) => this.request<ConnectionCheck>(`/api/targets/${ref}/test`, { method: "POST" });

  startRun = (ref: string) => this.request<{ runId: number }>(`/api/targets/${ref}/run`, { method: "POST" });
  cancelRun = (id: number) => this.request<{ ok: true }>(`/api/runs/${id}/cancel`, { method: "POST" });
  run = (id: number) => this.request<Run>(`/api/runs/${id}`);
  runs = (ref?: string, limit = 50) =>
    this.request<Run[]>(`/api/runs?limit=${limit}${ref ? `&target=${ref}` : ""}`);
  artifacts = (ref?: string, limit = 100) =>
    this.request<Artifact[]>(`/api/artifacts?limit=${limit}${ref ? `&target=${ref}` : ""}`);
  restoreCommand = (id: number) => this.request<{ command: string }>(`/api/artifacts/${id}/restore-command`);

  /** Historical log of a run that has already finished. */
  runLog = (id: number) => this.request<{ live: false; lines: string[] }>(`/api/runs/${id}/log`);

  /**
   * Streams a live run's log. Resolves when the run ends, handing back the
   * final record from the server's `end` event.
   */
  async streamRunLog(
    id: number,
    onLine: (line: LogLine) => void,
    signal?: AbortSignal,
  ): Promise<Run | null> {
    const response = await fetch(`${this.baseUrl}/api/runs/${id}/log`, {
      headers: { Authorization: `Bearer ${this.token}`, accept: "text/event-stream" },
      signal,
    });
    if (!response.ok) throw new ApiError(`could not attach to run ${id}`);

    // A finished run answers with JSON rather than an event stream.
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      const body = (await response.json()) as { lines?: string[] };
      for (const text of body.lines ?? []) onLine({ at: "", text });
      return null;
    }

    const reader = response.body?.getReader();
    if (!reader) return null;
    const decoder = new TextDecoder();
    let buffer = "";
    let final: Run | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line.
        let split: number;
        while ((split = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const event = frame.match(/^event:\s*(.*)$/m)?.[1]?.trim();
          const data = frame.match(/^data:\s*(.*)$/m)?.[1];
          if (!data) continue;
          if (event === "line") onLine(JSON.parse(data) as LogLine);
          if (event === "end") final = JSON.parse(data) as Run;
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") throw err;
    } finally {
      reader.cancel().catch(() => {});
    }
    return final;
  }
}
