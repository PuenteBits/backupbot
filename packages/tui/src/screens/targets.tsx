import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { formatBytes, formatRelative } from "@backupbot/core";
import type { TargetView } from "../api";
import { cell, Empty, Panel, type Hint } from "../components/ui";
import { statusColor, statusGlyph, theme } from "../theme";

export const TARGET_HINTS: Hint[] = [
  { key: "↑↓", label: "move" },
  { key: "⏎", label: "history" },
  { key: "r", label: "run" },
  { key: "a", label: "add" },
  { key: "e", label: "edit" },
  { key: "t", label: "test" },
  { key: "space", label: "enable" },
  { key: "d", label: "delete" },
  { key: "n", label: "channels" },
  { key: "q", label: "quit" },
];

export interface TargetsScreenProps {
  targets: TargetView[];
  selected: number;
  /** Receives an updater so repeated presses compose instead of coalescing. */
  onMove: (update: (current: number) => number) => void;
  onOpen: (target: TargetView) => void;
  onRun: (target: TargetView) => void;
  onAdd: () => void;
  onEdit: (target: TargetView) => void;
  onTest: (target: TargetView) => void;
  onToggle: (target: TargetView) => void;
  onDelete: (target: TargetView) => void;
  onChannels: () => void;
  onQuit: () => void;
}

const W = { status: 2, name: 24, engine: 10, schedule: 26, last: 16, next: 15 };

export function TargetsScreen(props: TargetsScreenProps) {
  const { targets, selected } = props;
  const [confirmDelete, setConfirmDelete] = useState<TargetView | null>(null);
  const current = targets[selected];

  useKeyboard((event) => {
    if (confirmDelete) {
      // While the confirmation is up, only y/n reach the app.
      if (event.name === "y") {
        props.onDelete(confirmDelete);
        setConfirmDelete(null);
      } else if (event.name === "n" || event.name === "escape") {
        setConfirmDelete(null);
      }
      return;
    }
    switch (event.name) {
      case "up":
      case "k":
        return props.onMove((index) => index - 1);
      case "down":
      case "j":
        return props.onMove((index) => index + 1);
      case "home":
        return props.onMove(() => 0);
      case "end":
        return props.onMove(() => targets.length - 1);
      case "return":
        return current && props.onOpen(current);
      case "r":
        return current && props.onRun(current);
      case "a":
        return props.onAdd();
      case "e":
        return current && props.onEdit(current);
      case "t":
        return current && props.onTest(current);
      case "space":
        return current && props.onToggle(current);
      case "d":
        return current && setConfirmDelete(current);
      case "n":
        return props.onChannels();
      case "q":
        return props.onQuit();
    }
  });

  if (confirmDelete) {
    return (
      <Panel title="delete target" grow focused>
        <text>{""}</text>
        <text>
          <span fg={theme.text}>{`Delete "${confirmDelete.name}"?`}</span>
        </text>
        <text>{""}</text>
        <text>
          <span fg={theme.muted}>
            {`Its ${confirmDelete.artifactCount} stored backup file(s) (${formatBytes(confirmDelete.totalBytes)}) stay on disk.`}
          </span>
        </text>
        <text>
          <span fg={theme.muted}>Only the schedule and history are removed.</span>
        </text>
        <text>{""}</text>
        <text>
          <span fg={theme.error}>y</span>
          <span fg={theme.muted}> delete    </span>
          <span fg={theme.accent}>n</span>
          <span fg={theme.muted}> keep</span>
        </text>
      </Panel>
    );
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <Panel title={`targets (${targets.length})`} grow focused>
        <text>
          <span fg={theme.muted}>
            {`  ${cell("NAME", W.name)}${cell("ENGINE", W.engine)}${cell("SCHEDULE", W.schedule)}${cell("LAST RUN", W.last)}${cell("NEXT", W.next)}SIZE`}
          </span>
        </text>
        {targets.length === 0 ? (
          <Empty text="No targets yet. Press a to add your first database." />
        ) : (
          targets.map((target, index) => <TargetRow key={target.id} target={target} active={index === selected} />)
        )}
      </Panel>
      {current ? <TargetDetail target={current} /> : null}
    </box>
  );
}

function TargetRow({ target, active }: { target: TargetView; active: boolean }) {
  const status = target.running !== null ? "running" : (target.lastRun?.status ?? "never");
  const last = target.running !== null ? "running now" : formatRelative(target.lastRun?.startedAt);
  const next = target.enabled ? formatRelative(target.nextRunAt) : "disabled";

  return (
    <box backgroundColor={active ? theme.selected : undefined} flexDirection="row">
      <text>
        <span fg={active ? theme.accent : theme.muted}>{active ? "▸ " : "  "}</span>
        <span fg={statusColor(status)}>{`${statusGlyph(status)} `}</span>
        <span fg={target.enabled ? theme.text : theme.muted}>{cell(target.name, W.name - 2)}</span>
        <span fg={theme.muted}>{cell(target.engine, W.engine)}</span>
        <span fg={theme.muted}>{cell(target.schedule, W.schedule)}</span>
        <span fg={statusColor(status)}>{cell(last, W.last)}</span>
        <span fg={theme.muted}>{cell(next, W.next)}</span>
        <span fg={theme.muted}>{formatBytes(target.totalBytes)}</span>
      </text>
    </box>
  );
}

function TargetDetail({ target }: { target: TargetView }) {
  const { retention } = target;
  const failure = target.lastRun?.status === "failed" ? target.lastRun.error : null;
  return (
    <Panel title="details">
      <text>
        <span fg={theme.muted}>connection  </span>
        <span fg={theme.text}>{target.dsnMasked}</span>
      </text>
      <text>
        <span fg={theme.muted}>schedule    </span>
        <span fg={theme.text}>{`${target.schedule}`}</span>
        <span fg={theme.muted}>{`  in `}</span>
        <span fg={theme.text}>{target.timezone}</span>
      </text>
      <text>
        <span fg={theme.muted}>retention   </span>
        <span fg={theme.text}>
          {`keep ${retention.keepLast} · ${retention.daily} daily · ${retention.weekly} weekly · ${retention.monthly} monthly`}
        </span>
        <span fg={theme.muted}>{`   verify `}</span>
        <span fg={theme.text}>{target.verify}</span>
        <span fg={theme.muted}>{`   backups `}</span>
        <span fg={theme.text}>{`${target.artifactCount}`}</span>
      </text>
      {failure ? (
        <text>
          <span fg={theme.muted}>last error  </span>
          <span fg={theme.error}>{cell(failure.replace(/\s+/g, " "), 100)}</span>
        </text>
      ) : null}
    </Panel>
  );
}
