export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatRelative(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "never";
  const diff = now.getTime() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "ago" : "from now";
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return diff >= 0 ? "just now" : "in a moment";
  if (mins < 60) return `${mins}m ${suffix}`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ${suffix}`;
  return `${Math.round(hours / 24)}d ${suffix}`;
}
