import type { RunStatus } from "@backupbot/core";

export const theme = {
  accent: "#7dd3fc",
  accentDim: "#0ea5e9",
  text: "#e4e4e7",
  muted: "#8b8b94",
  border: "#3f3f46",
  borderFocus: "#7dd3fc",
  success: "#4ade80",
  warn: "#fbbf24",
  error: "#f87171",
  running: "#c4b5fd",
  panel: "#18181b",
  selected: "#1e3a4c",
} as const;

export const statusColor = (status: RunStatus | "never" | undefined): string => {
  switch (status) {
    case "success":
      return theme.success;
    case "failed":
      return theme.error;
    case "running":
      return theme.running;
    case "cancelled":
      return theme.warn;
    default:
      return theme.muted;
  }
};

export const statusGlyph = (status: RunStatus | "never" | undefined): string => {
  switch (status) {
    case "success":
      return "●";
    case "failed":
      return "✕";
    case "running":
      return "◐";
    case "cancelled":
      return "○";
    default:
      return "·";
  }
};
