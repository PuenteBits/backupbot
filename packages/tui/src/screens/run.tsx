import { useKeyboard } from "@opentui/react";
import { formatBytes, formatDuration, type Run } from "@backupbot/core";
import type { LogLine } from "../api";
import { Panel, type Hint } from "../components/ui";
import { statusColor, theme } from "../theme";

export const RUN_HINTS: Hint[] = [
  { key: "esc", label: "back" },
  { key: "c", label: "cancel run" },
  { key: "↑↓", label: "scroll" },
];

export interface RunScreenProps {
  targetName: string;
  runId: number;
  lines: LogLine[];
  run: Run | null;
  live: boolean;
  onBack: () => void;
  onCancel: () => void;
}

export function RunScreen(props: RunScreenProps) {
  useKeyboard((event) => {
    if (event.name === "escape" || event.name === "q") return props.onBack();
    if (event.name === "c" && props.live) return props.onCancel();
  });

  const status = props.live ? "running" : (props.run?.status ?? "running");

  return (
    <box flexDirection="column" flexGrow={1}>
      <Panel title={`run ${props.runId} · ${props.targetName}`} grow focused>
        <scrollbox
          stickyScroll
          stickyStart="bottom"
          scrollY
          flexGrow={1}
          contentOptions={{ flexDirection: "column" }}
          focused
        >
          {props.lines.map((line, index) => (
            <text key={index}>
              <span fg={lineColor(line.text)}>{line.text}</span>
            </text>
          ))}
        </scrollbox>
      </Panel>
      <Panel title="result">
        <text>
          <span fg={statusColor(status)}>{`${status.toUpperCase()}  `}</span>
          {props.run ? (
            <span fg={theme.muted}>
              {`${formatBytes(props.run.bytes)} in ${formatDuration(props.run.durationMs)}`}
            </span>
          ) : (
            <span fg={theme.muted}>streaming live — press c to cancel</span>
          )}
        </text>
        {props.run?.error ? (
          <text>
            <span fg={theme.error}>{props.run.error}</span>
          </text>
        ) : null}
      </Panel>
    </box>
  );
}

/** Colour the handful of lines that carry a verdict; leave tool output plain. */
function lineColor(text: string): string {
  if (/^FAILED:|verify FAILED|^error:/.test(text)) return theme.error;
  if (/^verify passed|^backup complete/.test(text)) return theme.success;
  if (/^warn:|^error:/.test(text)) return theme.warn;
  if (/^(starting|verifying|stored|dump finished|retention:)/.test(text)) return theme.accent;
  return theme.muted;
}
