import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { formatBytes, formatDuration, formatRelative, type Artifact, type Run } from "@backupbot/core";
import type { TargetView } from "../api";
import { cell, Empty, Panel, type Hint } from "../components/ui";
import { statusColor, statusGlyph, theme } from "../theme";

export const HISTORY_HINTS: Hint[] = [
  { key: "tab", label: "switch pane" },
  { key: "↑↓", label: "move" },
  { key: "⏎", label: "log / restore command" },
  { key: "r", label: "run now" },
  { key: "esc", label: "back" },
];

export interface HistoryScreenProps {
  target: TargetView;
  runs: Run[];
  artifacts: Artifact[];
  onBack: () => void;
  onOpenRun: (run: Run) => void;
  onRestoreCommand: (artifact: Artifact) => void;
  onRun: () => void;
}

export function HistoryScreen(props: HistoryScreenProps) {
  const [pane, setPane] = useState<"runs" | "artifacts">("runs");
  const [runIndex, setRunIndex] = useState(0);
  const [artifactIndex, setArtifactIndex] = useState(0);

  const list = pane === "runs" ? props.runs : props.artifacts;
  const index = pane === "runs" ? runIndex : artifactIndex;
  const setIndex = pane === "runs" ? setRunIndex : setArtifactIndex;

  useKeyboard((event) => {
    switch (event.name) {
      case "escape":
      case "q":
        return props.onBack();
      case "tab":
        return setPane(pane === "runs" ? "artifacts" : "runs");
      case "up":
      case "k":
        return setIndex((current) => Math.max(0, current - 1));
      case "down":
      case "j":
        return setIndex((current) => Math.min(list.length - 1, current + 1));
      case "r":
        return props.onRun();
      case "return": {
        if (pane === "runs" && props.runs[runIndex]) return props.onOpenRun(props.runs[runIndex]!);
        if (pane === "artifacts" && props.artifacts[artifactIndex]) {
          return props.onRestoreCommand(props.artifacts[artifactIndex]!);
        }
      }
    }
  });

  return (
    <box flexDirection="column" flexGrow={1}>
      <Panel title={`runs · ${props.target.name}`} grow focused={pane === "runs"}>
        <text>
          <span fg={theme.muted}>
            {`  ${cell("WHEN", 16)}${cell("TRIGGER", 10)}${cell("STATUS", 11)}${cell("TOOK", 9)}${cell("SIZE", 10)}DETAIL`}
          </span>
        </text>
        {props.runs.length === 0 ? (
          <Empty text="No runs yet. Press r to back up now." />
        ) : (
          props.runs.slice(0, 12).map((run, i) => (
            <box key={run.id} backgroundColor={pane === "runs" && i === runIndex ? theme.selected : undefined}>
              <text>
                <span fg={statusColor(run.status)}>{`${pane === "runs" && i === runIndex ? "▸" : " "} `}</span>
                <span fg={theme.text}>{cell(formatRelative(run.startedAt), 16)}</span>
                <span fg={theme.muted}>{cell(run.trigger, 10)}</span>
                <span fg={statusColor(run.status)}>{cell(`${statusGlyph(run.status)} ${run.status}`, 11)}</span>
                <span fg={theme.muted}>{cell(formatDuration(run.durationMs), 9)}</span>
                <span fg={theme.muted}>{cell(formatBytes(run.bytes), 10)}</span>
                <span fg={run.error ? theme.error : theme.muted}>
                  {cell((run.error ?? "").replace(/\s+/g, " "), 46)}
                </span>
              </text>
            </box>
          ))
        )}
      </Panel>
      <Panel title={`stored backups (${props.artifacts.length})`} focused={pane === "artifacts"}>
        {props.artifacts.length === 0 ? (
          <Empty text="Nothing stored yet." />
        ) : (
          props.artifacts.slice(0, 8).map((artifact, i) => (
            <box
              key={artifact.id}
              backgroundColor={pane === "artifacts" && i === artifactIndex ? theme.selected : undefined}
            >
              <text>
                <span fg={theme.accent}>{`${pane === "artifacts" && i === artifactIndex ? "▸" : " "} `}</span>
                <span fg={theme.text}>{cell(formatRelative(artifact.createdAt), 16)}</span>
                <span fg={theme.muted}>{cell(formatBytes(artifact.sizeBytes), 10)}</span>
                <span fg={theme.muted}>{cell(artifact.sha256.slice(0, 12), 14)}</span>
                <span fg={theme.muted}>{artifact.path}</span>
              </text>
            </box>
          ))
        )}
      </Panel>
    </box>
  );
}
