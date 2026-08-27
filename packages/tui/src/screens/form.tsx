import { useMemo, useState } from "react";
import { useKeyboard } from "@opentui/react";
import {
  guideForDsn,
  nextRunAt,
  PROVIDER_GUIDES,
  retentionSchema,
  SCHEDULE_PRESETS,
  VERIFY_MODES,
  type Engine,
  type ProviderGuide,
  type VerifyMode,
} from "@backupbot/core";
import type { ConnectionCheck, TargetPayload, TargetView } from "../api";
import { Panel, type Hint } from "../components/ui";
import { theme } from "../theme";

export const FORM_HINTS: Hint[] = [
  { key: "tab", label: "next field" },
  { key: "←→", label: "change option" },
  { key: "^p", label: "schedule preset" },
  { key: "^g", label: "connection guide" },
  { key: "^t", label: "test connection" },
  { key: "^s", label: "save" },
  { key: "esc", label: "cancel" },
];

type FieldKind = "text" | "choice" | "toggle";

interface FieldSpec {
  key: keyof FormState;
  label: string;
  kind: FieldKind;
  hint?: string;
  choices?: readonly string[];
  placeholder?: string;
}

export interface FormState {
  name: string;
  dsn: string;
  schedule: string;
  timezone: string;
  verify: string;
  retention: string;
  enabled: boolean;
}

export function initialFormState(target?: TargetView): FormState {
  return {
    name: target?.name ?? "",
    dsn: "",
    schedule: target?.schedule ?? "0 3 * * *",
    timezone: target?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    verify: target?.verify ?? "archive",
    retention: target
      ? `${target.retention.keepLast},${target.retention.daily},${target.retention.weekly},${target.retention.monthly}`
      : "7,7,4,6",
    enabled: target?.enabled ?? true,
  };
}

/** Turns the form into an API payload, or throws with a message worth showing. */
export function toPayload(state: FormState, editing: boolean): Partial<TargetPayload> {
  if (!state.name.trim()) throw new Error("name is required");
  if (!editing && !state.dsn.trim()) throw new Error("connection string is required");
  if (!nextRunAt(state.schedule, state.timezone)) {
    throw new Error(`"${state.schedule}" is not a valid cron expression for ${state.timezone}`);
  }
  const parts = state.retention.split(",").map((n) => Number(n.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error("retention must be four whole numbers: keepLast,daily,weekly,monthly");
  }
  const [keepLast, daily, weekly, monthly] = parts;

  const payload: Partial<TargetPayload> = {
    name: state.name.trim(),
    schedule: state.schedule.trim(),
    timezone: state.timezone.trim(),
    verify: state.verify as VerifyMode,
    retention: retentionSchema.parse({ keepLast, daily, weekly, monthly }),
    enabled: state.enabled,
  };
  // Editing without retyping the DSN keeps the stored one — the API only ever
  // hands back a masked version, so an empty field means "unchanged".
  if (state.dsn.trim()) {
    payload.dsn = state.dsn.trim();
    payload.engine = engineOf(state.dsn.trim());
  }
  return payload;
}

function engineOf(dsn: string): Engine {
  return /^(mysql|mariadb):/.test(dsn) ? "mysql" : "postgres";
}

export interface TargetFormProps {
  target?: TargetView;
  state: FormState;
  onChange: (state: FormState) => void;
  onSave: () => void;
  onCancel: () => void;
  onTest: (dsn: string) => void;
  check: ConnectionCheck | null;
  testing: boolean;
}

export function TargetForm(props: TargetFormProps) {
  const { state, onChange, target } = props;
  const editing = Boolean(target);
  const [focus, setFocus] = useState(0);
  const [presetIndex, setPresetIndex] = useState(0);
  // -1 is closed; otherwise an index into PROVIDER_GUIDES.
  const [guideIndex, setGuideIndex] = useState(-1);

  const fields: FieldSpec[] = useMemo(
    () => [
      { key: "name", label: "Name", kind: "text", hint: "shown in the list; also becomes the folder name" },
      {
        key: "dsn",
        label: "Connection",
        kind: "text",
        placeholder: editing ? `${target!.dsnMasked}  (leave blank to keep)` : "postgres://user:pass@host:5432/db",
        hint: "percent-encode @ : / in the password",
      },
      { key: "schedule", label: "Schedule", kind: "text", hint: "cron expression — ^p cycles presets" },
      { key: "timezone", label: "Timezone", kind: "text", hint: "IANA name, e.g. Europe/Madrid" },
      { key: "verify", label: "Verify", kind: "choice", choices: VERIFY_MODES, hint: verifyHint(state.verify) },
      { key: "retention", label: "Retention", kind: "text", hint: "keepLast,daily,weekly,monthly" },
      { key: "enabled", label: "Enabled", kind: "toggle", hint: "disabled targets keep their history but never run" },
    ],
    [editing, target, state.verify],
  );

  const set = (key: keyof FormState, value: string | boolean) => onChange({ ...state, [key]: value });

  useKeyboard((event) => {
    const field = fields[focus]!;

    if (event.name === "escape") return props.onCancel();
    if (event.ctrl && event.name === "s") return props.onSave();
    if (event.ctrl && event.name === "g") {
      // Opens on whichever provider the half-typed DSN looks like, then cycles
      // through the rest and closes — so one key both reveals and dismisses it.
      return setGuideIndex((current) => {
        if (current >= 0) return current + 1 >= PROVIDER_GUIDES.length ? -1 : current + 1;
        // Editing leaves the field blank, so fall back to the masked DSN —
        // the host survives masking, and the host is all the detection needs.
        const detected = guideForDsn(state.dsn || target?.dsnMasked || "");
        return detected ? PROVIDER_GUIDES.indexOf(detected) : 0;
      });
    }
    if (event.ctrl && event.name === "t") {
      // The result belongs in the space the guide is occupying.
      setGuideIndex(-1);
      return props.onTest(state.dsn.trim());
    }
    if (event.ctrl && event.name === "p") {
      const preset = SCHEDULE_PRESETS[presetIndex % SCHEDULE_PRESETS.length]!;
      setPresetIndex((index) => index + 1);
      return set("schedule", preset.expression);
    }
    if (event.name === "tab") {
      // Functional update: two quick presses must advance two fields, not one.
      const step = event.shift ? fields.length - 1 : 1;
      return setFocus((index) => (index + step) % fields.length);
    }

    // Arrow keys only steer non-text fields; inside a text input they move the cursor.
    if (field.kind === "choice" && (event.name === "left" || event.name === "right")) {
      const choices = field.choices!;
      const at = Math.max(0, choices.indexOf(String(state[field.key])));
      const step = event.name === "right" ? 1 : choices.length - 1;
      return set(field.key, choices[(at + step) % choices.length]!);
    }
    if (field.kind === "toggle" && ["left", "right", "space"].includes(event.name)) {
      return set(field.key, !state[field.key]);
    }
  });

  const preview = nextRunAt(state.schedule, state.timezone);

  return (
    <box flexDirection="column" flexGrow={1}>
      <Panel title={editing ? `edit ${target!.slug}` : "add target"} grow focused>
        {fields.map((field, index) => (
          <Field
            key={field.key}
            spec={field}
            value={state[field.key]}
            focused={index === focus}
            onInput={(value) => set(field.key, value)}
          />
        ))}
        <text>{""}</text>
        <text>
          <span fg={theme.muted}>next run    </span>
          <span fg={preview ? theme.text : theme.error}>
            {preview ? preview.toISOString().replace("T", " ").slice(0, 19) + " UTC" : "invalid cron expression"}
          </span>
        </text>
      </Panel>
      {guideIndex >= 0 ? (
        <GuidePanel guide={PROVIDER_GUIDES[guideIndex]!} />
      ) : (
        <ConnectionPanel check={props.check} testing={props.testing} />
      )}
    </box>
  );
}

function Field({
  spec,
  value,
  focused,
  onInput,
}: {
  spec: FieldSpec;
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

function verifyHint(mode: string): string {
  switch (mode) {
    case "none":
      return "no checking — fastest, least trustworthy";
    case "restore":
      return "restores into a throwaway container (needs BACKUPBOT_ALLOW_DOCKER=1)";
    default:
      return "reads the archive index to prove it is complete";
  }
}

/**
 * A marker in its own column so that a line long enough to wrap — which these
 * are on a narrow terminal — indents under its text instead of restarting at
 * the left edge, where it would read as a new bullet.
 */
function GuideLine({
  marker,
  markerColor,
  textColor,
  text,
}: {
  marker: string;
  markerColor: string;
  textColor: string;
  text: string;
}) {
  return (
    <box flexDirection="row">
      <text width={3} flexShrink={0}>
        <span fg={markerColor}>{marker}</span>
      </text>
      <text flexGrow={1}>
        <span fg={textColor}>{text}</span>
      </text>
    </box>
  );
}

/**
 * Provider-specific instructions, shown where the connection result goes. The
 * hard part of adding a target is knowing which of a provider's several
 * connection strings can serve a dump, and that answer is not in the form.
 */
function GuidePanel({ guide }: { guide: ProviderGuide }) {
  return (
    <Panel title={`${guide.name.toLowerCase()} — where to find the connection string`}>
      {guide.steps.map((step, i) => (
        <GuideLine key={`step-${i}`} marker={`${i + 1}.`} markerColor={theme.accent} textColor={theme.text} text={step} />
      ))}
      <text>{""}</text>
      {guide.pitfalls.map((pitfall, i) => (
        <GuideLine key={`pitfall-${i}`} marker="!" markerColor={theme.warn} textColor={theme.muted} text={pitfall} />
      ))}
      <text>{""}</text>
      <text>
        <span fg={theme.muted}>{"example  "}</span>
        <span fg={theme.text}>{guide.example}</span>
      </text>
      <text>
        <span fg={theme.muted}>{"^g again for the next provider, or to close"}</span>
      </text>
    </Panel>
  );
}

function ConnectionPanel({ check, testing }: { check: ConnectionCheck | null; testing: boolean }) {
  return (
    <Panel title="connection">
      {testing ? (
        <text>
          <span fg={theme.running}>testing…</span>
        </text>
      ) : !check ? (
        <text>
          <span fg={theme.muted}>Press ^t to test the connection string before saving.</span>
        </text>
      ) : (
        <box flexDirection="column">
          <text>
            <span fg={check.ok ? theme.success : theme.error}>{check.ok ? "● connected" : "✕ failed"}</span>
            <span fg={theme.text}>
              {check.ok ? `  server ${check.serverVersion}  ·  ${check.client}` : `  ${check.error ?? ""}`}
            </span>
          </text>
          {check.warnings.map((warning, i) => (
            <text key={i}>
              <span fg={warning.level === "error" ? theme.error : theme.warn}>{`${warning.level}: `}</span>
              <span fg={theme.muted}>{warning.message}</span>
            </text>
          ))}
        </box>
      )}
    </Panel>
  );
}
