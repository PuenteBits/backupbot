import { unlink } from "node:fs/promises";
import type { Artifact, Retention, Store, Target } from "@backupbot/core";

export interface PruneResult {
  kept: number;
  deleted: Artifact[];
  freedBytes: number;
}

const dayKey = (iso: string) => iso.slice(0, 10);
const monthKey = (iso: string) => iso.slice(0, 7);

/** ISO-8601 week, so "weekly" means the same thing across year boundaries. */
function weekKey(iso: string): string {
  const d = new Date(iso);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNumber = (target.getUTCDay() + 6) % 7; // Monday = 0
  target.setUTCDate(target.getUTCDate() - dayNumber + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Grandfather-father-son. Each bucket independently nominates artifacts to
 * keep; an artifact survives if any bucket wants it. That means a single
 * daily backup can simultaneously be this week's and this month's keeper.
 */
export function selectForRetention(artifacts: Artifact[], policy: Retention): { keep: Set<number>; drop: Artifact[] } {
  const sorted = [...artifacts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const keep = new Set<number>();

  for (const artifact of sorted.slice(0, policy.keepLast)) keep.add(artifact.id);

  for (const [bucketFn, limit] of [
    [dayKey, policy.daily],
    [weekKey, policy.weekly],
    [monthKey, policy.monthly],
  ] as const) {
    const seen = new Set<string>();
    for (const artifact of sorted) {
      if (seen.size >= limit) break;
      const key = bucketFn(artifact.createdAt);
      if (seen.has(key)) continue; // an older artifact in a bucket we already filled
      seen.add(key);
      keep.add(artifact.id);
    }
  }

  // A policy of all zeros must still not wipe out the last good backup.
  const newest = sorted[0];
  if (keep.size === 0 && newest) keep.add(newest.id);

  return { keep, drop: sorted.filter((a) => !keep.has(a.id)) };
}

export async function pruneTarget(
  store: Store,
  target: Target,
  log: (line: string) => void = () => {},
): Promise<PruneResult> {
  const artifacts = store.listArtifacts({ targetId: target.id, limit: 10_000 });
  const { keep, drop } = selectForRetention(artifacts, target.retention);
  let freedBytes = 0;
  const deleted: Artifact[] = [];

  for (const artifact of drop) {
    try {
      await unlink(artifact.path);
    } catch (err) {
      // A file already gone by other means shouldn't block the row cleanup.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log(`retention: could not delete ${artifact.path}: ${(err as Error).message}`);
        continue;
      }
    }
    store.deleteArtifact(artifact.id);
    freedBytes += artifact.sizeBytes;
    deleted.push(artifact);
  }

  if (deleted.length) log(`retention: removed ${deleted.length} old artifact(s)`);
  return { kept: keep.size, deleted, freedBytes };
}
