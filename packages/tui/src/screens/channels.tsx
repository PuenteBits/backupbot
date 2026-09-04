import { useMemo, useState } from "react";
import { useKeyboard } from "@opentui/react";
import {
  discordConfigSchema,
  formatRelative,
  validationMessage,
  type ChannelInput,
  type NotifyEventKind,
} from "@backupbot/core";
import type { ChannelView } from "../api";
import { cell, Empty, Field, Panel, type FieldSpec, type Hint } from "../components/ui";
import { theme } from "../theme";

export const CHANNEL_HINTS: Hint[] = [
  { key: "↑↓", label: "move" },
  { key: "a", label: "add" },
  { key: "e", label: "edit" },
  { key: "t", label: "test" },
  { key: "space", label: "enable" },
  { key: "d", label: "delete" },
  { key: "esc", label: "targets" },
  { key: "q", label: "quit" },
];

export const CHANNEL_FORM_HINTS: Hint[] = [
  { key: "tab", label: "next field" },
  { key: "←→", label: "change option" },
  { key: "^t", label: "send a test message" },
  { key: "^s", label: "save" },
  { key: "esc", label: "cancel" },
];

const W = { name: 20, kind: 10, events: 26, targets: 22, state: 10 };

/** `run.failed` reads as noise in a table; the prefix is the same on every row. */
const shortEvents = (events: NotifyEventKind[]) => events.map((event) => event.replace("run.", "")).join(", ");

export interface ChannelsScreenProps {
  channels: ChannelView[];
  selected: number;
  onMove: (update: (current: number) => number) => void;
  onAdd: () => void;
  onEdit: (channel: ChannelView) => void;
  onTest: (channel: ChannelView) => void;
  onToggle: (channel: ChannelView) => void;
  onDelete: (channel: ChannelView) => void;
  /** Env-configured channels have no row to change — say so rather than failing. */
  onReadOnly: (channel: ChannelView) => void;
  onBack: () => void;
  onQuit: () => void;
}

export function ChannelsScreen(props: ChannelsScreenProps) {
  const { channels, selected } = props;
  const [confirmDelete, setConfirmDelete] = useState<ChannelView | null>(null);
  const current = channels[selected];

  useKeyboard((event) => {
    if (confirmDelete) {
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
      case "a":
        return props.onAdd();
      case "e":
        if (!current) return;
        return current.readOnly ? props.onReadOnly(current) : props.onEdit(current);
      case "t":
        return current && props.onTest(current);
      case "space":
        if (!current) return;
        return current.readOnly ? props.onReadOnly(current) : props.onToggle(current);
      case "d":
        if (!current) return;
        return current.readOnly ? props.onReadOnly(current) : setConfirmDelete(current);
      case "escape":
        return props.onBack();
      case "q":
        return props.onQuit();
    }
  });

  if (confirmDelete) {
    return (
      <Panel title="delete channel" grow focused>
        <text>{""}</text>
        <text>
          <span fg={theme.text}>{`Delete "${confirmDelete.name}"?`}</span>
        </text>
        <text>{""}</text>
        <text>
          <span fg={theme.muted}>Backups keep running; they just stop being reported here.</span>
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
      <Panel title={`channels (${channels.length})`} grow focused>
        <text>
          <span fg={theme.muted}>
            {`  ${cell("NAME", W.name)}${cell("KIND", W.kind)}${cell("EVENTS", W.events)}${cell("TARGETS", W.targets)}${cell("STATE", W.state)}LAST DELIVERY`}
          </span>
        </text>
        {channels.length === 0 ? (
          <Empty text="No channels yet. Press a to report backups to a Discord webhook." />
        ) : (
          channels.map((channel, index) => (
            <ChannelRow key={`${channel.id}-${channel.name}`} channel={channel} active={index === selected} />
          ))
        )}
      </Panel>
      {current ? <ChannelDetail channel={current} /> : null}
    </box>
  );
}

function ChannelRow({ channel, active }: { channel: ChannelView; active: boolean }) {
  const failing = Boolean(channel.lastError);
  const last = failing ? "failing" : channel.lastSentAt ? formatRelative(channel.lastSentAt) : "never sent";
  return (
    <box backgroundColor={active ? theme.selected : undefined} flexDirection="row">
      <text>
        <span fg={active ? theme.accent : theme.muted}>{active ? "▸ " : "  "}</span>
        <span fg={channel.enabled ? theme.text : theme.muted}>{cell(channel.name, W.name)}</span>
        <span fg={theme.muted}>{cell(channel.kind, W.kind)}</span>
        <span fg={theme.muted}>{cell(shortEvents(channel.events), W.events)}</span>
        <span fg={theme.muted}>{cell(channel.targets?.join(", ") ?? "all targets", W.targets)}</span>
        <span fg={channel.enabled ? theme.success : theme.muted}>
          {cell(channel.enabled ? "enabled" : "disabled", W.state)}
        </span>
        <span fg={failing ? theme.error : theme.muted}>{last}</span>
      </text>
    </box>
  );
}

function ChannelDetail({ channel }: { channel: ChannelView }) {
  return (
    <Panel title="details">
      <text>
        <span fg={theme.muted}>webhook     </span>
        <span fg={theme.text}>{channel.config.kind === "discord" ? channel.config.webhookUrl : channel.kind}</span>
      </text>
      {channel.readOnly ? (
        <text>
          <span fg={theme.muted}>source      </span>
          <span fg={theme.warn}>BACKUPBOT_DISCORD_WEBHOOK — change it in docker/.env and restart the engine</span>
        </text>
      ) : null}
      {channel.lastError ? (
        <text>
          <span fg={theme.muted}>last error  </span>
          <span fg={theme.error}>{cell(channel.lastError.replace(/\s+/g, " "), 100)}</span>
        </text>
      ) : (
        <text>
          <span fg={theme.muted}>last error  </span>
          <span fg={theme.muted}>none</span>
        </text>
      )}
    </Panel>
  );
}

// ---- the add/edit form ----------------------------------------------------

export interface ChannelFormState {
  name: string;
  webhookUrl: string;
  onSuccess: boolean;
  onFailed: boolean;
  onCancelled: boolean;
  targets: string;
  enabled: boolean;
}

export function initialChannelState(channel?: ChannelView): ChannelFormState {
  return {
    name: channel?.name ?? "discord",
    webhookUrl: "",
    onSuccess: channel ? channel.events.includes("run.success") : true,
    onFailed: channel ? channel.events.includes("run.failed") : true,
    onCancelled: channel ? channel.events.includes("run.cancelled") : false,
    targets: channel?.targets?.join(", ") ?? "",
    enabled: channel?.enabled ?? true,
  };
}

/** Turns the form into an API payload, or throws with a message worth showing. */
export function toChannelPayload(state: ChannelFormState, editing: boolean): Partial<ChannelInput> {
  if (!state.name.trim()) throw new Error("name is required");

  const events: NotifyEventKind[] = [];
  if (state.onSuccess) events.push("run.success");
  if (state.onFailed) events.push("run.failed");
  if (state.onCancelled) events.push("run.cancelled");
  if (!events.length) throw new Error("pick at least one event to report");

  const targets = state.targets
    .split(",")
    .map((slug) => slug.trim())
    .filter(Boolean);

  const payload: Partial<ChannelInput> = {
    name: state.name.trim(),
    events,
    targets: targets.length ? targets : null,
    enabled: state.enabled,
  };

  // Editing without retyping the webhook keeps the stored one — the API only
  // ever hands back a masked version, so an empty field means "unchanged".
  if (!editing && !state.webhookUrl.trim()) throw new Error("webhook URL is required");
  if (state.webhookUrl.trim()) payload.config = parseWebhook(state.webhookUrl.trim());
  return payload;
}

export function parseWebhook(webhookUrl: string) {
  const parsed = discordConfigSchema.safeParse({ kind: "discord", webhookUrl });
  if (!parsed.success) throw new Error(validationMessage(parsed.error) ?? "invalid webhook URL");
  return parsed.data;
}

export interface ChannelFormProps {
  channel?: ChannelView;
  state: ChannelFormState;
  onChange: (state: ChannelFormState) => void;
  onSave: () => void;
  onCancel: () => void;
  onTest: () => void;
  testing: boolean;
}

export function ChannelForm(props: ChannelFormProps) {
  const { state, onChange, channel } = props;
  const editing = Boolean(channel);
  const [focus, setFocus] = useState(0);

  const fields: FieldSpec<keyof ChannelFormState>[] = useMemo(
    () => [
      { key: "name", label: "Name", kind: "text", hint: "how this channel is listed here" },
      {
        key: "webhookUrl",
        label: "Webhook",
        kind: "text",
        placeholder: editing
          ? `${channel!.config.kind === "discord" ? channel!.config.webhookUrl : ""}  (leave blank to keep)`
          : "https://discord.com/api/webhooks/<id>/<token>",
        hint: "Server Settings → Integrations → Webhooks → Copy Webhook URL",
      },
      { key: "onSuccess", label: "On success", kind: "toggle", hint: "a green report for every backup that works" },
      { key: "onFailed", label: "On failure", kind: "toggle", hint: "the one you actually need" },
      { key: "onCancelled", label: "On cancel", kind: "toggle", hint: "someone stopped a run, or the engine restarted" },
      { key: "targets", label: "Targets", kind: "text", hint: "comma-separated slugs — blank reports every target" },
      { key: "enabled", label: "Enabled", kind: "toggle", hint: "a disabled channel keeps its settings but never posts" },
    ],
    [editing, channel],
  );

  const set = (key: keyof ChannelFormState, value: string | boolean) => onChange({ ...state, [key]: value });

  useKeyboard((event) => {
    const field = fields[focus]!;
    if (event.name === "escape") return props.onCancel();
    if (event.ctrl && event.name === "s") return props.onSave();
    if (event.ctrl && event.name === "t") return props.onTest();
    if (event.name === "tab") {
      const step = event.shift ? fields.length - 1 : 1;
      return setFocus((index) => (index + step) % fields.length);
    }
    if (field.kind === "toggle" && ["left", "right", "space"].includes(event.name)) {
      return set(field.key, !state[field.key]);
    }
  });

  return (
    <box flexDirection="column" flexGrow={1}>
      <Panel title={editing ? `edit ${channel!.name}` : "add channel"} grow focused>
        {fields.map((field, index) => (
          <Field
            key={field.key}
            spec={field}
            value={state[field.key]}
            focused={index === focus}
            onInput={(value) => set(field.key, value)}
          />
        ))}
      </Panel>
      <Panel title="delivery">
        {props.testing ? (
          <text>
            <span fg={theme.running}>sending…</span>
          </text>
        ) : (
          <box flexDirection="column">
            <text>
              <span fg={theme.muted}>
                Press ^t to post a test message. It goes to the webhook typed above, or to the saved one if you left
                the field blank.
              </span>
            </text>
            <text>
              <span fg={theme.muted}>Reports land here for every scheduled, manual and API-triggered run.</span>
            </text>
          </box>
        )}
      </Panel>
    </box>
  );
}
