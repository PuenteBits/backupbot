import { describe, expect, test } from "bun:test";
import { retentionSchema, type Artifact } from "@backupbot/core";
import { selectForRetention } from "./retention";

let nextId = 1;
const at = (iso: string): Artifact => ({
  id: nextId++,
  runId: 0,
  targetId: 1,
  path: `/backups/x/${iso}.dump`,
  sizeBytes: 100,
  sha256: "x",
  format: "pg_custom",
  createdAt: iso,
});

/** One backup a day at 03:00 UTC, `days` of them, ending on 2026-08-26. */
function dailySeries(days: number): Artifact[] {
  const end = Date.UTC(2026, 7, 26, 3, 0, 0);
  return Array.from({ length: days }, (_, i) => at(new Date(end - i * 86_400_000).toISOString()));
}

describe("selectForRetention", () => {
  test("keeps the newest N regardless of bucketing", () => {
    const artifacts = dailySeries(30);
    const policy = retentionSchema.parse({ keepLast: 5, daily: 0, weekly: 0, monthly: 0 });
    const { keep, drop } = selectForRetention(artifacts, policy);
    expect(keep.size).toBe(5);
    expect(drop.length).toBe(25);
    // The five survivors are the five most recent.
    for (const a of artifacts.slice(0, 5)) expect(keep.has(a.id)).toBe(true);
  });

  test("daily bucket keeps one per day, newest first", () => {
    const artifacts = dailySeries(30);
    const policy = retentionSchema.parse({ keepLast: 0, daily: 7, weekly: 0, monthly: 0 });
    const { keep } = selectForRetention(artifacts, policy);
    expect(keep.size).toBe(7);
  });

  test("with several backups a day, the daily bucket keeps the newest of each day", () => {
    const artifacts = [
      at("2026-08-26T21:00:00.000Z"),
      at("2026-08-26T09:00:00.000Z"),
      at("2026-08-26T03:00:00.000Z"),
      at("2026-08-25T21:00:00.000Z"),
      at("2026-08-25T03:00:00.000Z"),
    ];
    const policy = retentionSchema.parse({ keepLast: 0, daily: 2, weekly: 0, monthly: 0 });
    const { keep, drop } = selectForRetention(artifacts, policy);
    expect(keep.has(artifacts[0]!.id)).toBe(true); // newest of the 26th
    expect(keep.has(artifacts[3]!.id)).toBe(true); // newest of the 25th
    expect(drop.map((a) => a.id).sort()).toEqual([artifacts[1]!.id, artifacts[2]!.id, artifacts[4]!.id].sort());
  });

  test("buckets overlap rather than sum: a year of dailies collapses to the policy size", () => {
    const artifacts = dailySeries(365);
    const policy = retentionSchema.parse({ keepLast: 7, daily: 7, weekly: 4, monthly: 6 });
    const { keep, drop } = selectForRetention(artifacts, policy);
    // keepLast and daily nominate the same 7, so the union is well under 24.
    expect(keep.size).toBeGreaterThanOrEqual(13);
    expect(keep.size).toBeLessThanOrEqual(17);
    expect(keep.size + drop.length).toBe(365);
  });

  test("an all-zero policy still keeps the newest backup", () => {
    const artifacts = dailySeries(5);
    const policy = retentionSchema.parse({ keepLast: 0, daily: 0, weekly: 0, monthly: 0 });
    const { keep, drop } = selectForRetention(artifacts, policy);
    expect(keep.size).toBe(1);
    expect(keep.has(artifacts[0]!.id)).toBe(true);
    expect(drop.length).toBe(4);
  });

  test("nothing is dropped when there is nothing to drop", () => {
    const { keep, drop } = selectForRetention([], retentionSchema.parse({}));
    expect(keep.size).toBe(0);
    expect(drop).toEqual([]);
  });

  test("weekly bucket spans a year boundary without collapsing", () => {
    const artifacts = [
      at("2027-01-04T03:00:00.000Z"), // ISO week 2027-W01
      at("2026-12-28T03:00:00.000Z"), // ISO week 2026-W53
      at("2026-12-21T03:00:00.000Z"), // ISO week 2026-W52
    ];
    const policy = retentionSchema.parse({ keepLast: 0, daily: 0, weekly: 3, monthly: 0 });
    expect(selectForRetention(artifacts, policy).keep.size).toBe(3);
  });
});
