# backupbot

Scheduled backups for remote PostgreSQL and MySQL/MariaDB databases, designed to
run on a Synology NAS. Supabase, Railway, Neon, PlanetScale — anything reachable
over a connection string.

Managed backups from those providers are a per-database monthly charge. This is
one container on hardware you already own.

## How it works

One long-running container holds everything:

- **Scheduler** — a cron job per target, driven by the config database. Adding a
  target is the *only* step; nothing is registered in DSM's Task Scheduler, so
  there is no second place for schedules to drift out of sync.
- **Engine** — version-matched `pg_dump` / `mysqldump`, compression, retention.
- **API** — a small HTTP interface on loopback that the TUI and the CLI drive.

The TUI is a client. It can run on the NAS over SSH, or on your laptop through
a tunnel — the engine keeps working whether anything is watching or not.

State lives in SQLite at `/data`; dumps land in `/backups`.

### Version-matched dump clients

`pg_dump` refuses to dump from a server newer than itself. This is the single
most common reason homegrown backup scripts break, usually silently, months
after they were written, when the provider upgrades.

The image carries PostgreSQL clients 14–18 side by side. Every run asks the
server its version first and picks the matching binary:

```
server PostgreSQL 17; using pg_dump v17 from /usr/lib/postgresql/17/bin
```

### Verification

A backup you have never restored is a guess. Each target picks a `verify` level:

| Level | What it does | Cost |
|---|---|---|
| `none` | nothing | — |
| `archive` (default) | reads the archive's table of contents (Postgres) or checks the completion marker and counts `CREATE TABLE`s (MySQL) | milliseconds |
| `restore` | restores into a throwaway container and counts the tables that land | a few seconds to minutes |

A failed verification fails the run — the dump is deleted rather than kept as a
backup that looks fine and isn't.

`restore` needs the host Docker socket mounted **and** `BACKUPBOT_ALLOW_DOCKER=1`.
That grants the container root-equivalent control of the host, so it is opt-in
twice over, per target and per deployment.

### Nothing partial is ever kept

Dumps are written to `<name>.partial` and renamed only after verification
passes. An interrupted run leaves no file behind, and a run interrupted by a
container restart is marked failed on the next boot rather than sitting in
`running` forever. Retention only ever prunes after a *successful* run, so a
broken backup can never age out working ones.

## Install on the NAS

Requires DSM with Container Manager (x86_64 models).

The repo is private, so SSH into the NAS with agent forwarding (`ssh -A nas`)
and let your laptop's key do the authenticating — nothing to install on DSM.

```bash
git clone git@github.com:PuenteBits/backupbot.git /volume1/docker/backupbot/src
cd /volume1/docker/backupbot/src
cp docker/.env.example docker/.env   # set your shared folder paths and TZ
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml logs -f
```

### Updating a deployment

```bash
./redeploy.sh nas          # pull main on the NAS and rebuild
./redeploy.sh nas --force  # rebuild even with nothing new to pull
```

It refuses to pull over a dirty checkout, shows the incoming commits, rebuilds,
and waits for `/health` before reporting success. It needs `ssh -A` for the
private repo and `ssh -t` so `sudo` can prompt — both of which it sets itself,
so run it from a real terminal rather than a script.

Host paths live in `docker/.env` rather than the compose file, because shared
folder names differ per NAS — `/volume1/backups` on one, `/volume1/photos-backups`
on another. It is gitignored, so your paths survive a `git pull`.

The startup log prints the generated API token. Set `BACKUPBOT_TOKEN` in the
compose file to pin your own instead.

Point **Hyper Backup** at `/volume1/backups/databases` for offsite copies — it
already does encryption, versioning and B2/S3 targets better than this would.

### Reaching it from your laptop

The API binds to loopback on the NAS. Tunnel in rather than exposing a backup
control plane on your LAN:

```bash
ssh -L 7817:127.0.0.1:7817 nas
curl -H "Authorization: Bearer $TOKEN" 127.0.0.1:7817/api/targets
```

Two DSM-specific traps here:

- **DSM ships with `AllowTcpForwarding no`**, so the tunnel is refused with
  `administratively prohibited: open failed`. Set it to `yes` in
  `/etc/ssh/sshd_config` and `sudo synosystemctl restart sshd`. A DSM update can
  revert the file, so check it first if tunnelling stops working.
- **Forward to `127.0.0.1`, not `localhost`.** The NAS resolves `localhost` to
  `::1` first, and the engine binds IPv4 loopback only — the connection is
  accepted locally and then reset.

Without forwarding, run the TUI on the NAS instead:

```bash
sudo docker exec -it backupbot bun run /app/packages/tui/src/index.tsx
```

## The TUI

```bash
./run.sh nas                                # from a laptop, over a tunnel
./run.sh --local                              # against an engine on this machine
sudo docker exec -it backupbot bun run /app/packages/tui/src/index.tsx  # on the NAS
```

`./run.sh <ssh-host>` is the laptop path. It installs dependencies if the
checkout is fresh, opens an SSH forward on an ephemeral local port, reads the
API token off the NAS, runs the TUI, and closes the tunnel when the TUI exits —
including on ctrl-c, a crash, or `kill -9`. Nothing is left listening and no
token is written to your machine. The host is whatever you type after `ssh`, so
an `~/.ssh/config` alias works.

The same launcher is available as `bun run tui:remote <ssh-host>`, with one
caveat: `bun run <script-name>` spawns a child, so a `kill -9` on *that* wrapper
leaves the tunnel behind. `./run.sh` execs the launcher directly and does not.

Override `BACKUPBOT_REMOTE_DB` if the engine's data directory is not the
documented `/volume1/docker/backupbot/data`, or set `BACKUPBOT_TOKEN` to skip
reading it from the NAS.

It reads `BACKUPBOT_URL` / `BACKUPBOT_TOKEN`, falls back to
`~/.config/backupbot/tui.json`, and finally reads the token straight out of the
engine's database when it runs alongside the daemon — so on the NAS it needs no
setup at all.

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ backupbot  scheduled database backups     2/2 enabled · 14 backups · 1.2 GB  │
╰──────────────────────────────────────────────────────────────────────────────╯
╭─ targets (2) ────────────────────────────────────────────────────────────────╮
│   NAME              ENGINE   SCHEDULE      LAST RUN     NEXT        SIZE     │
│ ▸ ● Shop production postgres 0 3 * * *     2h ago       in 22h      840 MB   │
│   ✕ Analytics       mysql    0 */6 * * *   12m ago      in 5h       380 MB   │
╰──────────────────────────────────────────────────────────────────────────────╯
╭─ details ────────────────────────────────────────────────────────────────────╮
│ connection  postgres://postgres:****@aws-0-eu-west-1.pooler.supabase.com…    │
│ schedule    0 3 * * *  in Europe/Madrid                                      │
│ retention   keep 7 · 7 daily · 4 weekly · 6 monthly   verify archive         │
╰──────────────────────────────────────────────────────────────────────────────╯
 ↑↓ move  ⏎ history  r run  a add  e edit  t test  space enable  d delete  q quit
```

| Screen | Keys |
|---|---|
| Targets | `↑↓`/`jk` move · `⏎` history · `r` run now · `a` add · `e` edit · `t` test connection · `space` enable/disable · `d` delete · `n` channels · `q` quit |
| Add/edit | `tab` next field · `←→` change option · `^p` cycle schedule presets · `^g` provider connection guide · `^t` test connection · `^s` save · `esc` cancel |
| History | `tab` switch pane · `↑↓` move · `⏎` open log / show restore command · `r` run now · `esc` back |
| Live run | `esc` back · `c` cancel the run |
| Channels | `↑↓` move · `a` add · `e` edit · `t` send a test message · `space` enable/disable · `d` delete · `esc` back |

`r` streams the running backup's log live over server-sent events, so you watch
`pg_dump` work through your tables in real time and see the verification verdict
as it lands. Editing a target leaves the connection field blank on purpose —
the API only ever hands back a masked DSN, so blank means "keep the stored one".

## Adding a target

```bash
sudo docker exec backupbot bun run /app/packages/cli/src/index.ts \
  add --name "Shop production" \
      --dsn 'postgres://postgres.abcdefgh:PASSWORD@aws-0-eu-west-1.pooler.supabase.com:5432/postgres' \
      --schedule '0 3 * * *' --tz Europe/Madrid \
      --retention 7,7,4,6
```

Percent-encode anything exotic in the password: `@` → `%40`, `:` → `%3A`,
`/` → `%2F`.

Every provider hands out several connection strings and only some of them can
serve a dump. Picking the wrong one usually fails later, on a schedule, rather
than when you paste it — so the steps below are also built into the TUI: press
**`^g`** in the add/edit form to read them next to the field, and `^g` again to
cycle providers or close.

### Supabase

1. Open your project and click **Connect** in the top bar (or Project Settings →
   Database).
2. Choose the **Session pooler** tab — not Transaction pooler, not Direct
   connection.
3. Copy the URI. The host ends in `.pooler.supabase.com` and the port is `5432`.
4. Replace `[YOUR-PASSWORD]` with the database password (Settings → Database →
   Reset database password if you never saved it — it is *not* your Supabase
   account password).
5. Percent-encode any `@ : / ? #` in the password.

```
postgresql://postgres.abcdefghijklmnop:PASSWORD@aws-0-eu-west-1.pooler.supabase.com:5432/postgres
```

- `…pooler.supabase.com:5432` ✅ — session pooler, IPv4, works with `pg_dump`
- `…pooler.supabase.com:6543` ❌ — transaction pooler, cannot serve `pg_dump`
- `db.<ref>.supabase.co:5432` ⚠️ — direct, IPv6-only without the paid IPv4 add-on

### Railway

1. Open the project and click the **Postgres** (or MySQL) service — not the app
   service.
2. Go to the **Variables** tab.
3. Copy **`DATABASE_PUBLIC_URL`**. For MySQL the variable is `MYSQL_PUBLIC_URL`.
4. Check the host ends in `.proxy.rlwy.net` with a high random port.
5. Percent-encode any `@ : / ? #` in the password.

```
postgresql://postgres:PASSWORD@ballast.proxy.rlwy.net:41234/railway
```

Railway's MySQL terminates TLS with a self-signed certificate, and the MariaDB
client verifies certificates by default — so a bare connection string fails with
`TLS/SSL error: self-signed certificate in certificate chain`. Remote MySQL
therefore defaults to `ssl-mode=REQUIRED`: encrypted, certificate not verified,
the same trade the Postgres side makes with `sslmode=require`. Override per
target with `?ssl-mode=…` (`DISABLED`, `PREFERRED`, `REQUIRED`, `VERIFY_CA`,
`VERIFY_IDENTITY`), adding `&ssl-ca=/path/to/ca.pem` for the verifying modes.

`DATABASE_URL` — without the `_PUBLIC_` — points at `*.railway.internal`, which
only resolves inside Railway's own network; nothing on your NAS can reach it.
The public proxy port is assigned per service and changes if you re-provision
the database, and dumps pulled through it count toward Railway's billed egress.

`backupbot test` and `add` flag the unusable choices for both providers before
you find out at 3am.

## Retention

Grandfather-father-son. Four independent buckets; a backup survives if any
bucket still wants it, so one dump can be today's daily *and* this month's
monthly.

```
--retention keepLast,daily,weekly,monthly
--retention 7,7,4,6     # a week of dailies, a month of weeklies, six months of monthlies
```

An all-zero policy still keeps the newest backup. Pruning is exercised by unit
tests, because this is the code that deletes things.

## Restoring

```bash
backupbot artifacts shop-production     # list what's stored
backupbot restore 42                    # print the exact restore command
```

It prints rather than executes: a restore overwrites a live database, and that
should be a decision you make with the command in front of you.

## Notifications

Every finished run — scheduled, manual or over the API — is reported to any
channel that subscribed to it. Discord is the only provider so far.

The quickest route is an environment variable, so a deployment reports without
anyone opening the TUI. In `docker/.env`:

```
BACKUPBOT_DISCORD_WEBHOOK=https://discord.com/api/webhooks/123456789/…
BACKUPBOT_NOTIFY_EVENTS=success,failed      # or "failed", or "all"
```

Get the URL from Discord: Server Settings → Integrations → Webhooks → New
Webhook → Copy Webhook URL.

`n` in the TUI opens the same list — add, edit, enable, delete, and `^t` posts a
test message to a webhook before you save it. A channel that comes from the
environment is listed there too, marked as belonging to `docker/.env` rather
than editable in place.

Channels added through the CLI or TUI are used as well, and can be scoped to
particular targets and events:

```bash
backupbot channel add --kind discord --url https://discord.com/api/webhooks/…
backupbot channel add --kind discord --url … --events failed --targets shop-production
backupbot channel test 1                    # posts a "this works" message
backupbot channels                          # includes the env-configured one
```

A success posts a green embed with the size, duration and artifact name; a
failure posts a red one carrying the error. Delivery is retried three times —
timeouts, 5xx and Discord's own 429 rate limit, whose `retry_after` is
honoured — and a 4xx gives up at once, because a deleted webhook will not
recover. **A notification can never fail a backup**: the outcome is recorded on
the channel and written into the run log, and that is all. `backupbot channels`
shows the last delivery, so a silent channel can be explained.

## CLI

Run inside the container (`sudo docker exec backupbot bun run /app/packages/cli/src/index.ts …`)
— on DSM the docker socket is root-only, so the `sudo` is not optional
or locally with `bun run packages/cli/src/index.ts …`.

```
serve                          run the engine daemon (scheduler + API)
token                          print the API token
ls                             list targets
add --name N --dsn URL [...]   add a target
edit <ref> [--dsn URL ...]     change a target
rm <ref>                       delete a target
test <ref|--dsn URL>           check connectivity and client versions
run <ref>                      back up now, streaming the log
runs [<ref>] [--limit N]       recent run history
artifacts [<ref>]              stored backups
restore <artifactId>           print the command to restore an artifact
prune <ref>                    apply the retention policy now
channels                       list notification channels
channel add|edit|rm|test       manage notification channels
```

## API

All routes need `Authorization: Bearer <token>` except `/health`.

```
GET    /health
GET    /api/targets                     list with last run, next run, totals
POST   /api/targets                     add (reloads the scheduler)
GET    /api/targets/:ref
PATCH  /api/targets/:ref
DELETE /api/targets/:ref
POST   /api/targets/:ref/test           connection check + DSN warnings
POST   /api/targets/:ref/run            trigger now → { runId }
POST   /api/test-connection             check a DSN that isn't saved yet
GET    /api/runs?target=&limit=
GET    /api/runs/:id
GET    /api/runs/:id/log                SSE live log, or the file if finished
POST   /api/runs/:id/cancel
GET    /api/artifacts?target=
GET    /api/artifacts/:id/restore-command
GET    /api/schedule
GET    /api/stats
GET    /api/channels                    notification channels, webhook masked
POST   /api/channels                    add
PATCH  /api/channels/:id
DELETE /api/channels/:id
POST   /api/channels/:id/test           post a test message
POST   /api/channels/test               test a webhook that isn't saved yet
```

## Security

- Connection strings are encrypted at rest with AES-256-GCM. The key is
  generated on first run at `/data/master.key` (mode 0600), or injected via
  `BACKUPBOT_KEY`. **Back this key up** — without it the stored DSNs are
  unrecoverable.
- Passwords never appear in `argv`. Postgres uses libpq keyword/value
  connection strings with `PGPASSWORD`; MySQL uses a 0600 defaults file that is
  deleted when the process exits.
- Every stream captured from a dump tool is scrubbed of the password before it
  reaches a log, the API or the terminal — `pg_dump` echoes connection details
  into its own error output.
- Webhook URLs are encrypted at rest under the same key as the DSNs, and the
  token is masked everywhere they leave the process — API, CLI and TUI.
- Notifications carry the run's error message, which is scrubbed of the
  password before it is stored or sent.
- The API binds to `127.0.0.1` unless told otherwise.

Dumps themselves are stored unencrypted, relying on NAS volume permissions.

## Development

```bash
bun install
bun test          # unit tests plus TUI tests driven against a real engine
bun run typecheck
bun run engine    # the daemon
bun run tui       # the terminal client
```

The TUI tests use OpenTUI's test renderer: they mount the real app against a
real engine and a real MySQL server, press keys, and assert on captured frames —
including that no password ever appears in a rendered frame.

Local runs need `pg_dump` / `mysqldump` on PATH; the container is the supported
path for everything else.

## Status

Working end to end: core, engine, scheduler, API, CLI, TUI, Docker image.

Notifications work over the TUI, the CLI, the API and `BACKUPBOT_DISCORD_WEBHOOK`.

Possible next steps: more providers (Slack, plain webhook, email — the
`ChannelProvider` interface is the seam), reporting runs that a container
restart interrupted, per-target schema include/exclude filters, and MongoDB
support.
