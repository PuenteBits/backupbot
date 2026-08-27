import { Cron } from "croner";

export function validateSchedule(expression: string, timezone = "UTC"): void {
  try {
    new Cron(expression, { timezone, paused: true });
  } catch (err) {
    throw new Error(`invalid cron expression "${expression}": ${(err as Error).message}`);
  }
}

export function nextRunAt(expression: string, timezone = "UTC", from = new Date()): Date | null {
  try {
    return new Cron(expression, { timezone, paused: true }).nextRun(from);
  } catch {
    return null;
  }
}

/** A few presets so the TUI never forces anyone to remember cron syntax. */
export const SCHEDULE_PRESETS = [
  { label: "Every 6 hours", expression: "0 */6 * * *" },
  { label: "Daily at 03:00", expression: "0 3 * * *" },
  { label: "Daily at 03:00 and 15:00", expression: "0 3,15 * * *" },
  { label: "Weekly, Sunday 03:00", expression: "0 3 * * 0" },
  { label: "Monthly, 1st at 03:00", expression: "0 3 1 * *" },
] as const;
