import type { ReactNode } from "react";
import { formatBytes } from "@backupbot/core";
import type { Stats } from "../api";
import { theme } from "../theme";

export function Header({ title, stats, connected }: { title: string; stats: Stats | null; connected: boolean }) {
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={theme.border}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="row"
      justifyContent="space-between"
    >
      <text>
        <span fg={theme.accent}>backupbot</span>
        <span fg={theme.muted}>{`  ${title}`}</span>
      </text>
      <text>
        {stats ? (
          <span fg={theme.muted}>
            {`${stats.enabled}/${stats.targets} enabled · ${stats.artifacts} backups · ${formatBytes(stats.totalBytes)}`}
          </span>
        ) : (
          <span fg={theme.muted}>connecting…</span>
        )}
        {stats && stats.running > 0 ? <span fg={theme.running}>{`  ◐ ${stats.running} running`}</span> : null}
        {stats && stats.failures24h > 0 ? (
          <span fg={theme.error}>{`  ✕ ${stats.failures24h} failed today`}</span>
        ) : null}
        {!connected ? <span fg={theme.error}> offline</span> : null}
      </text>
    </box>
  );
}

export interface Hint {
  key: string;
  label: string;
}

export function KeyHints({ hints, message }: { hints: Hint[]; message?: { text: string; tone: "info" | "error" } }) {
  return (
    <box paddingLeft={1} paddingRight={1} flexDirection="row" justifyContent="space-between">
      <text>
        {hints.map((hint, i) => (
          <span key={hint.key}>
            <span fg={theme.accent}>{i === 0 ? hint.key : `  ${hint.key}`}</span>
            <span fg={theme.muted}>{` ${hint.label}`}</span>
          </span>
        ))}
      </text>
      {message ? (
        <text>
          <span fg={message.tone === "error" ? theme.error : theme.muted}>{message.text}</span>
        </text>
      ) : null}
    </box>
  );
}

/**
 * Fixed-width columns so rows line up without a real table widget. A truncated
 * value still ends in a space — otherwise it runs straight into the next column.
 */
export function cell(value: string, width: number): string {
  if (value.length <= width) return value.padEnd(width);
  if (width <= 2) return value.slice(0, width);
  return `${value.slice(0, width - 2)}… `;
}

export function Panel({
  title,
  children,
  grow,
  focused,
}: {
  title: string;
  children: ReactNode;
  grow?: boolean;
  focused?: boolean;
}) {
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={focused ? theme.borderFocus : theme.border}
      title={` ${title} `}
      titleColor={focused ? theme.accent : theme.muted}
      flexGrow={grow ? 1 : 0}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      overflow="hidden"
    >
      {children}
    </box>
  );
}

export type FieldKind = "text" | "choice" | "toggle";

export interface FieldSpec<K extends string> {
  key: K;
  label: string;
  kind: FieldKind;
  hint?: string;
  choices?: readonly string[];
  placeholder?: string;
}

/** One labelled row of a form: a text input, a cycled choice, or a yes/no. */
export function Field<K extends string>({
  spec,
  value,
  focused,
  onInput,
}: {
  spec: FieldSpec<K>;
  value: string | boolean;
  focused: boolean;
  onInput: (value: string) => void;
}) {
  return (
    <box flexDirection="row" height={1}>
      <text>
        <span fg={focused ? theme.accent : theme.muted}>{focused ? "▸ " : "  "}</span>
        <span fg={focused ? theme.text : theme.muted}>{spec.label.padEnd(11)}</span>
      </text>
      {spec.kind === "text" ? (
        <input
          value={value as string}
          placeholder={spec.placeholder}
          focused={focused}
          onInput={onInput}
          flexGrow={1}
          maxWidth={70}
          backgroundColor={focused ? theme.selected : undefined}
          textColor={theme.text}
        />
      ) : (
        <text>
          <span fg={theme.text}>{spec.kind === "toggle" ? (value ? "yes" : "no") : String(value)}</span>
          <span fg={theme.muted}>{focused ? "   ←→ to change" : ""}</span>
        </text>
      )}
      <text>
        <span fg={theme.muted}>{focused && spec.hint ? `  ${spec.hint}` : ""}</span>
      </text>
    </box>
  );
}

export function Empty({ text }: { text: string }) {
  return (
    <text>
      <span fg={theme.muted}>{text}</span>
    </text>
  );
}
