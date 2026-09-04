import { useCallback, useEffect, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { Artifact, Run } from "@backupbot/core";
import { Api, ApiError, type ChannelView, type ConnectionCheck, type LogLine, type Stats, type TargetView } from "./api";
import { Header, KeyHints, Panel, type Hint } from "./components/ui";
import {
  CHANNEL_FORM_HINTS,
  CHANNEL_HINTS,
  ChannelForm,
  ChannelsScreen,
  initialChannelState,
  parseWebhook,
  toChannelPayload,
  type ChannelFormState,
} from "./screens/channels";
import { FORM_HINTS, initialFormState, TargetForm, toPayload, type FormState } from "./screens/form";
import { HISTORY_HINTS, HistoryScreen } from "./screens/history";
import { RUN_HINTS, RunScreen } from "./screens/run";
import { TARGET_HINTS, TargetsScreen } from "./screens/targets";
import { theme } from "./theme";

type Screen =
  | { name: "targets" }
  | { name: "history"; slug: string }
  | { name: "form"; slug?: string }
  | { name: "run"; slug: string; runId: number }
  | { name: "restore"; command: string }
  | { name: "channels" }
  | { name: "channelForm"; id?: number };

interface Message {
  text: string;
  tone: "info" | "error";
}

const POLL_MS = 3000;

const clamp = (index: number, length: number) => Math.max(0, Math.min(length - 1, index));

export function App({ api, onQuit }: { api: Api; onQuit: () => void }) {
  const [screen, setScreen] = useState<Screen>({ name: "targets" });
  const [targets, setTargets] = useState<TargetView[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [selected, setSelected] = useState(0);
  const [connected, setConnected] = useState(true);
  const [message, setMessage] = useState<Message | undefined>();

  const [form, setForm] = useState<FormState>(initialFormState());
  const [check, setCheck] = useState<ConnectionCheck | null>(null);
  const [testing, setTesting] = useState(false);

  const [channels, setChannels] = useState<ChannelView[]>([]);
  const [channelSelected, setChannelSelected] = useState(0);
  const [channelForm, setChannelForm] = useState<ChannelFormState>(initialChannelState());
  const [channelTesting, setChannelTesting] = useState(false);

  const [runs, setRuns] = useState<Run[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const streamAbort = useRef<AbortController | null>(null);

  const notify = useCallback((text: string, tone: Message["tone"] = "info") => setMessage({ text, tone }), []);
  const fail = useCallback(
    (err: unknown) => {
      const error = err as Error;
      notify(error instanceof ApiError ? error.message : `${error.message}`, "error");
    },
    [notify],
  );

  const refresh = useCallback(async () => {
    try {
      const [nextTargets, nextStats] = await Promise.all([api.targets(), api.stats()]);
      setTargets(nextTargets);
      setStats(nextStats);
      setConnected(true);
    } catch (err) {
      setConnected(false);
      fail(err);
    }
  }, [api, fail]);

  const loadHistory = useCallback(
    async (slug: string) => {
      try {
        const [nextRuns, nextArtifacts] = await Promise.all([api.runs(slug, 50), api.artifacts(slug, 100)]);
        setRuns(nextRuns);
        setArtifacts(nextArtifacts);
      } catch (err) {
        fail(err);
      }
    },
    [api, fail],
  );

  const loadChannels = useCallback(async () => {
    try {
      setChannels(await api.channels());
    } catch (err) {
      fail(err);
    }
  }, [api, fail]);

  /** Posts a test message to a webhook that has not been saved yet. */
  const probeConfig = useCallback(
    (webhookUrl: string) => {
      // parseWebhook throws on a malformed URL — surface that as a rejection so
      // the caller has one error path, not two.
      try {
        return api.testChannelConfig(parseWebhook(webhookUrl));
      } catch (err) {
        return Promise.reject(err);
      }
    },
    [api],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll only on the screens that show live state; the run view has its own stream.
  useEffect(() => {
    if (screen.name !== "targets" && screen.name !== "history" && screen.name !== "channels") return;
    const slug = screen.name === "history" ? screen.slug : null;
    const channelsVisible = screen.name === "channels";
    const timer = setInterval(() => {
      void refresh();
      if (slug) void loadHistory(slug);
      // Keeps "last delivery" honest while a scheduled run reports in.
      if (channelsVisible) void loadChannels();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [screen, refresh, loadHistory, loadChannels]);

  const attachToRun = useCallback(
    async (slug: string, runId: number) => {
      streamAbort.current?.abort();
      const abort = new AbortController();
      streamAbort.current = abort;
      setLines([]);
      setRun(null);
      setScreen({ name: "run", slug, runId });
      try {
        const final = await api.streamRunLog(runId, (line) => setLines((prev) => [...prev, line]), abort.signal);
        setRun(final ?? (await api.run(runId)));
        void refresh();
      } catch (err) {
        if (!abort.signal.aborted) fail(err);
      }
    },
    [api, fail, refresh],
  );

  const startRun = useCallback(
    async (target: TargetView) => {
      try {
        const { runId } = await api.startRun(target.slug);
        await attachToRun(target.slug, runId);
      } catch (err) {
        fail(err);
      }
    },
    [api, attachToRun, fail],
  );

  // Ctrl+C always exits, whatever screen is up and whatever has focus.
  useKeyboard((event) => {
    if (event.ctrl && event.name === "c") onQuit();
  });

  const current = targets[selected];
  const hints = HINTS[screen.name];

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor="#0b0b0e">
      <Header title={TITLES[screen.name]} stats={stats} connected={connected} />

      {screen.name === "targets" ? (
        <TargetsScreen
          targets={targets}
          selected={Math.min(selected, Math.max(0, targets.length - 1))}
          onMove={(update) => setSelected((current) => clamp(update(current), targets.length))}
          onOpen={(target) => {
            setScreen({ name: "history", slug: target.slug });
            void loadHistory(target.slug);
          }}
          onRun={(target) => void startRun(target)}
          onAdd={() => {
            setForm(initialFormState());
            setCheck(null);
            setScreen({ name: "form" });
          }}
          onEdit={(target) => {
            setForm(initialFormState(target));
            setCheck(null);
            setScreen({ name: "form", slug: target.slug });
          }}
          onTest={(target) => {
            setTesting(true);
            api
              .testTarget(target.slug)
              .then((result) => {
                notify(
                  result.ok ? `${target.name}: connected, server ${result.serverVersion}` : `${target.name}: ${result.error}`,
                  result.ok ? "info" : "error",
                );
              })
              .catch(fail)
              .finally(() => setTesting(false));
          }}
          onToggle={(target) => {
            api
              .updateTarget(target.slug, { enabled: !target.enabled })
              .then(() => {
                notify(`${target.name} ${target.enabled ? "disabled" : "enabled"}`);
                return refresh();
              })
              .catch(fail);
          }}
          onDelete={(target) => {
            api
              .deleteTarget(target.slug)
              .then(() => {
                notify(`removed ${target.name}`);
                return refresh();
              })
              .catch(fail);
          }}
          onChannels={() => {
            setScreen({ name: "channels" });
            void loadChannels();
          }}
          onQuit={onQuit}
        />
      ) : null}

      {screen.name === "form" ? (
        <TargetForm
          target={screen.slug ? targets.find((t) => t.slug === screen.slug) : undefined}
          state={form}
          onChange={setForm}
          check={check}
          testing={testing}
          onTest={(dsn) => {
            if (!dsn) return notify("type a connection string first", "error");
            setTesting(true);
            api
              .testConnection(dsn)
              .then(setCheck)
              .catch(fail)
              .finally(() => setTesting(false));
          }}
          onCancel={() => setScreen({ name: "targets" })}
          onSave={() => {
            let payload;
            try {
              payload = toPayload(form, Boolean(screen.slug));
            } catch (err) {
              return fail(err);
            }
            const saving = screen.slug
              ? api.updateTarget(screen.slug, payload)
              : api.createTarget(payload as Parameters<typeof api.createTarget>[0]);
            saving
              .then(async (saved) => {
                notify(`saved ${saved.name} — next run ${saved.nextRunAt ?? "never"}`);
                setScreen({ name: "targets" });
                await refresh();
              })
              .catch(fail);
          }}
        />
      ) : null}

      {screen.name === "history" && current ? (
        <HistoryScreen
          target={targets.find((t) => t.slug === screen.slug) ?? current}
          runs={runs}
          artifacts={artifacts}
          onBack={() => setScreen({ name: "targets" })}
          onOpenRun={(selectedRun) => {
            if (selectedRun.status === "running") return void attachToRun(screen.slug, selectedRun.id);
            api
              .runLog(selectedRun.id)
              .then((body) => {
                setLines(body.lines.map((text) => ({ at: "", text })));
                setRun(selectedRun);
                setScreen({ name: "run", slug: screen.slug, runId: selectedRun.id });
              })
              .catch(fail);
          }}
          onRestoreCommand={(artifact) => {
            api
              .restoreCommand(artifact.id)
              .then(({ command }) => setScreen({ name: "restore", command }))
              .catch(fail);
          }}
          onRun={() => {
            const target = targets.find((t) => t.slug === screen.slug);
            if (target) void startRun(target);
          }}
        />
      ) : null}

      {screen.name === "run" ? (
        <RunScreen
          targetName={targets.find((t) => t.slug === screen.slug)?.name ?? screen.slug}
          runId={screen.runId}
          lines={lines}
          run={run}
          live={run === null}
          onBack={() => {
            streamAbort.current?.abort();
            setScreen({ name: "targets" });
            void refresh();
          }}
          onCancel={() => {
            api.cancelRun(screen.runId).then(() => notify("cancellation requested")).catch(fail);
          }}
        />
      ) : null}

      {screen.name === "channels" ? (
        <ChannelsScreen
          channels={channels}
          selected={Math.min(channelSelected, Math.max(0, channels.length - 1))}
          onMove={(update) => setChannelSelected((current) => clamp(update(current), channels.length))}
          onAdd={() => {
            setChannelForm(initialChannelState());
            setScreen({ name: "channelForm" });
          }}
          onEdit={(channel) => {
            setChannelForm(initialChannelState(channel));
            setScreen({ name: "channelForm", id: channel.id });
          }}
          onTest={(channel) => {
            setChannelTesting(true);
            api
              .testChannel(channel.id)
              .then(() => notify(`sent a test message to ${channel.name}`))
              .catch(fail)
              .finally(() => {
                setChannelTesting(false);
                void loadChannels();
              });
          }}
          onToggle={(channel) => {
            api
              .updateChannel(channel.id, { enabled: !channel.enabled })
              .then(() => {
                notify(`${channel.name} ${channel.enabled ? "disabled" : "enabled"}`);
                return loadChannels();
              })
              .catch(fail);
          }}
          onDelete={(channel) => {
            api
              .deleteChannel(channel.id)
              .then(() => {
                notify(`removed ${channel.name}`);
                return loadChannels();
              })
              .catch(fail);
          }}
          onReadOnly={() => notify("this channel comes from BACKUPBOT_DISCORD_WEBHOOK — change it in docker/.env", "error")}
          onBack={() => setScreen({ name: "targets" })}
          onQuit={onQuit}
        />
      ) : null}

      {screen.name === "channelForm" ? (
        <ChannelForm
          channel={screen.id === undefined ? undefined : channels.find((c) => c.id === screen.id)}
          state={channelForm}
          onChange={setChannelForm}
          testing={channelTesting}
          onTest={() => {
            const typed = channelForm.webhookUrl.trim();
            if (!typed && screen.id === undefined) return notify("type a webhook URL first", "error");
            setChannelTesting(true);
            const probe = typed ? probeConfig(typed) : api.testChannel(screen.id!);
            probe
              .then(() => notify("test message sent — check the channel"))
              .catch(fail)
              .finally(() => setChannelTesting(false));
          }}
          onCancel={() => setScreen({ name: "channels" })}
          onSave={() => {
            let payload;
            try {
              payload = toChannelPayload(channelForm, screen.id !== undefined);
            } catch (err) {
              return fail(err);
            }
            const saving =
              screen.id === undefined
                ? api.createChannel(payload as Parameters<typeof api.createChannel>[0])
                : api.updateChannel(screen.id, payload);
            saving
              .then(async (saved) => {
                notify(`saved ${saved.name} — reporting ${saved.events.map((e) => e.replace("run.", "")).join(", ")}`);
                setScreen({ name: "channels" });
                await loadChannels();
              })
              .catch(fail);
          }}
        />
      ) : null}

      {screen.name === "restore" ? (
        <RestoreScreen command={screen.command} onBack={() => setScreen({ name: "targets" })} />
      ) : null}

      <KeyHints hints={hints} message={message} />
    </box>
  );
}

function RestoreScreen({ command, onBack }: { command: string; onBack: () => void }) {
  useKeyboard((event) => {
    if (event.name === "escape" || event.name === "q") onBack();
  });
  return (
    <Panel title="restore" grow focused>
      <text>{""}</text>
      <text>
        <span fg={theme.warn}>This overwrites the database you point it at. Read it before you run it.</span>
      </text>
      <text>{""}</text>
      <text>
        <span fg={theme.text}>{command}</span>
      </text>
      <text>{""}</text>
      <text>
        <span fg={theme.muted}>
          The path is inside the engine container — run it there, or use the same file from the NAS share.
        </span>
      </text>
    </Panel>
  );
}

const TITLES: Record<Screen["name"], string> = {
  targets: "scheduled database backups",
  form: "target configuration",
  history: "run history",
  run: "live run",
  restore: "restore command",
  channels: "notification channels",
  channelForm: "channel configuration",
};

const HINTS: Record<Screen["name"], Hint[]> = {
  targets: TARGET_HINTS,
  form: FORM_HINTS,
  history: HISTORY_HINTS,
  run: RUN_HINTS,
  restore: [{ key: "esc", label: "back" }],
  channels: CHANNEL_HINTS,
  channelForm: CHANNEL_FORM_HINTS,
};
