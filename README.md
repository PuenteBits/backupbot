# backupbot

**Nightly backups of your hosted databases, onto hardware you own.**

Point it at a Supabase, Railway, Neon, PlanetScale — or any PostgreSQL or
MySQL/MariaDB connection string — and it dumps them on a schedule, verifies
every dump, keeps a sensible history, and tells you when something breaks.

Managed backup add-ons are a per-database monthly charge, and the "just write a
cron script" version quietly stops working the month your provider upgrades
Postgres. This is one container on a machine you already run — a NAS, a home
server, a cheap VPS — that keeps working.

- **Version-matched dump clients.** `pg_dump` refuses to dump from a newer
  server, so the image ships PostgreSQL clients 14–18 and picks the right one at
  run time. Your provider's upgrade is a non-event.
- **Every dump is verified** before it counts as a backup. A dump that can't be
  read back is a failed run, not a file that looks fine until you need it.
- **Nothing partial is ever kept**, and retention only prunes after a success —
  so a broken backup can never age out your working ones.
- **Your connection strings are encrypted at rest** and never appear in `argv`,
  logs, the API, or the screen.
- **The dumps are ordinary `pg_dump` / `mysqldump` files.** No proprietary
  format, no lock-in: if you delete backupbot tomorrow, they still restore.
- **Terminal UI, CLI and HTTP API** over one engine. Run the UI on the server or
  from your laptop through a tunnel it opens and closes for you.

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

## Contents

- [Quickstart](#quickstart)
- [Is this for you?](#is-this-for-you)
- [What it does to your database](#what-it-does-to-your-database)
- [Install it properly](#install-it-properly)
- [Adding a target](#adding-a-target)
- [The TUI](#the-tui)
- [Retention](#retention)
- [Restoring](#restoring)
- [Notifications](#notifications)
- [Getting the dumps offsite](#getting-the-dumps-offsite)
- [Configuration reference](#configuration-reference)
- [CLI](#cli)
- [API](#api)
- [Security](#security)
- [Operating it](#operating-it)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [On a Synology NAS](#on-a-synology-nas)
- [Under the hood](#under-the-hood)
- [Development](#development)
- [License](#license)

## Quickstart

You need a Linux machine with Docker, and a connection string. Nothing else —
no Bun, no Postgres client, no Node on the host.

```bash
git clone https://github.com/PuenteBits/backupbot.git
cd backupbot

cp docker/.env.example docker/.env
$EDITOR docker/.env                  # set the two host paths, and your timezone

docker compose -f docker/docker-compose.yml up -d --build
```

The first build takes a few minutes — it installs five PostgreSQL client
versions. Then make the CLI reachable and add your first database:

```bash
alias backupbot='docker exec -it backupbot bun run /app/packages/cli/src/index.ts'

backupbot test --dsn 'postgres://user:PASSWORD@host:5432/db'   # check it first
backupbot add --name "My app" \
  --dsn 'postgres://user:PASSWORD@host:5432/db' \
  --schedule '0 3 * * *' --tz Europe/Madrid \
  --retention 7,7,4,6

backupbot run my-app                 # don't wait until 3am to find out
```

That's the whole setup. The scheduler picks the target up immediately — there's
nothing to register in cron, systemd, or your NAS's task scheduler, so there's
no second place for your schedules to drift out of sync.

```
starting manual backup of "My app" (postgres)
server PostgreSQL 17; using pg_dump v17 from /usr/lib/postgresql/17/bin
dump finished: 47180381 bytes in 38s
verifying (archive)
verify passed: table of contents readable: 412 objects, 31 tables with data
stored /backups/my-app/2026-09/my-app-20260904T193102Z.dump
backup complete
```

Add `BACKUPBOT_DISCORD_WEBHOOK` to `docker/.env` and you'll hear about every run
without opening anything. Then [point restic or Hyper Backup at the dumps
directory](#getting-the-dumps-offsite), because a backup that only exists on the
machine that made it is not a backup.

## Is this for you?

**A good fit if:**

- You have a handful of databases on a hosted provider and the managed backup
  add-on costs more than you want to pay per database, per month.
- You already own a machine that's powered on overnight.
- You want the backups as plain files you can restore with stock tools, on any
  machine, without this program.
- You've been burned by a backup script that had been silently failing for
  months, and you want something that verifies its own work and shouts.

**Not a fit if:**

| You need | Situation |
|---|---|
| MongoDB, Redis, ClickHouse, SQLite | PostgreSQL and MySQL/MariaDB only. Mongo is on the list; the rest aren't. |
| Point-in-time recovery | These are logical dumps on a schedule. You recover to the last good dump, not to 14:32 last Tuesday. If you need PITR, buy your provider's add-on — this doesn't replace it. |
| Per-table or schema-level backups | Whole database only, for now. |
| Built-in upload to S3/B2/Backblaze | Deliberately absent. `restic`, `rclone`, `borg` and Hyper Backup already do encryption, versioning and remote targets better than this would — [pair it with one](#getting-the-dumps-offsite). |
| Multiple users, roles, an audit log | One host, one operator, one bearer token. |
| A web UI | A terminal UI, a CLI and an HTTP API. No browser. |
| Backups of a database only reachable from inside a private network | The machine running backupbot has to be able to connect to the database. |

It is a few thousand lines of TypeScript that you can read in an afternoon, and
that is on purpose — it's the kind of tool you should be able to audit before
trusting it with every one of your database passwords.

## What it does to your database

Worth knowing before you point it at production:

- It connects **like any other client** and runs `pg_dump` / `mysqldump`. It
  never writes to your database, changes schemas, or holds locks beyond what
  those tools normally take.
- A dump **reads your entire database**, so it costs I/O on the source and, on
  hosted providers, **egress you may be billed for**. Schedule it for a quiet
  hour; that's what `--tz` is for.
- On big databases the dump takes as long as it takes. Runs stream to disk and
  can be cancelled; a second run of the same target is refused while one is in
  progress rather than piling up.
- If a run is interrupted — container restart, power cut — the partial file is
  deleted and the run is marked failed. You never end up with a truncated dump
  sitting in the backup directory looking legitimate.

### Verification

A backup you've never restored is a guess. Each target picks a level:

| Level | What it does | Cost |
|---|---|---|
| `none` | nothing | — |
| `archive` (default) | reads the archive's table of contents (Postgres) or checks the completion marker and counts `CREATE TABLE`s (MySQL) | milliseconds |
| `restore` | restores into a throwaway container and counts the tables that land | seconds to minutes |

A failed verification **fails the run** and deletes the dump, rather than
keeping a backup that looks fine and isn't.

`restore` needs the host Docker socket mounted **and** `BACKUPBOT_ALLOW_DOCKER=1`.
That grants the container root-equivalent control of the host, so it's opt-in
twice over — per target and per deployment. `archive` is the sensible default
and catches truncated and corrupt dumps on its own.

## Install it properly

### What you need

- A Linux host with **Docker 20.10+ and Compose v2** — amd64 or arm64. A NAS, a
  mini PC, a VPS, a Raspberry Pi 4/5, an old laptop.
- **~2 GB of disk for the image** (five PostgreSQL client versions aren't
  small), plus room for the dumps.
- **Outbound access** to the databases. Nothing needs to be open inbound.

### 1. Get the source

There's no published image — you build it where it runs, which also means you
can read exactly what you're about to trust.

```bash
git clone https://github.com/PuenteBits/backupbot.git /srv/backupbot/src
cd /srv/backupbot/src
```

### 2. Choose where things live

```bash
cp docker/.env.example docker/.env
```

The example ships with Synology paths — edit them for your host. `docker/.env`
is gitignored, so whatever you put there survives a `git pull`:

```ini
# Where the dumps land. This is the directory to point your offsite tool at.
BACKUPBOT_BACKUPS_PATH=/srv/backupbot/backups

# SQLite state, the encryption key and run logs. Small, but irreplaceable.
BACKUPBOT_DATA_PATH=/srv/backupbot/data

# The container clock. Every target carries its own schedule timezone, so this
# only affects log timestamps.
BACKUPBOT_TZ=Europe/Madrid

# Optional — report every result to Discord without opening the TUI.
# BACKUPBOT_DISCORD_WEBHOOK=https://discord.com/api/webhooks/123456789/abcdef
# BACKUPBOT_NOTIFY_EVENTS=success,failed
```

Host paths live here rather than in the compose file because they differ on
every machine, and a compose file everyone edits locally is a compose file that
conflicts on every pull.

### 3. Start it

```bash
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml logs -f
```

The startup log prints everything you need:

```
backupbot engine listening on http://0.0.0.0:7817
  data     /data
  backups  /backups
  token    Xk9c2LmQ7vRt4pWnZ...
  schedule my-app: 0 3 * * * (Europe/Madrid) → next 2026-09-05T01:00:00.000Z
```

Keep that token — it's the API bearer token. Set `BACKUPBOT_TOKEN` in the
compose file to pin your own instead of using the generated one.

The engine binds all interfaces *inside* the container, but compose publishes
the port only to the host's loopback (`127.0.0.1:7817:7817`). A backup control
plane holds every one of your database passwords; keep it off the LAN and reach
it over SSH.

### 4. Make the CLI convenient

```bash
alias backupbot='docker exec -it backupbot bun run /app/packages/cli/src/index.ts'
```

Put it in your `~/.bashrc` on the host and every `backupbot …` example here
works verbatim. On hosts where the Docker socket is root-only — Synology among
them — the alias needs a `sudo`.

### 5. Check on it later

```bash
backupbot ls        # targets, last run, next run
backupbot runs      # recent history across every target
backupbot artifacts # what's actually stored
```

### Running it without Docker

Supported, but then you own the dependencies: Bun 1.x,
`postgresql-client-<version>` for every server major you back up,
`mariadb-client`, and `zstd`.

```bash
bun install
BACKUPBOT_DATA_DIR=/srv/backupbot/data \
BACKUPBOT_BACKUPS_DIR=/srv/backupbot/backups \
bun run packages/cli/src/index.ts serve
```

As a systemd unit:

```ini
# /etc/systemd/system/backupbot.service
[Unit]
Description=backupbot
After=network-online.target

[Service]
WorkingDirectory=/srv/backupbot/src
Environment=BACKUPBOT_DATA_DIR=/srv/backupbot/data
Environment=BACKUPBOT_BACKUPS_DIR=/srv/backupbot/backups
ExecStart=/usr/local/bin/bun run packages/cli/src/index.ts serve
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

The container is the supported path, though. Version-matched dump clients are
half the point of this thing, and on a bare host you're back to installing them
yourself every time a provider upgrades.

### Updating

```bash
git pull && docker compose -f docker/docker-compose.yml up -d --build
```

Your targets, history and encryption key live in the data directory, not in the
image, so rebuilding loses nothing.

## Adding a target

```bash
backupbot add --name "Shop production" \
  --dsn 'postgres://postgres.abcdefgh:PASSWORD@aws-0-eu-west-1.pooler.supabase.com:5432/postgres' \
  --schedule '0 3 * * *' --tz Europe/Madrid \
  --retention 7,7,4,6
```

Percent-encode anything exotic in the password: `@` → `%40`, `:` → `%3A`,
`/` → `%2F`. Or skip the flags entirely and press `a` in the TUI.

**The connection string is the part people get wrong.** Every provider hands out
several, and only some of them can serve a dump — and picking the wrong one
usually fails later, on a schedule, at 3am, rather than when you paste it. So
`backupbot test` and `add` flag the unusable choices immediately, and the same
guides are built into the TUI: press **`^g`** in the add/edit form to read them
next to the field.

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

`DATABASE_URL` — without the `_PUBLIC_` — points at `*.railway.internal`, which
only resolves inside Railway's own network; nothing outside it can connect. The
public proxy port is assigned per service and changes if you re-provision the
database, and dumps pulled through it count toward Railway's billed egress.

### Anywhere else

Anything with a connection string works, including a database on your own LAN:

```bash
backupbot add --name "Home Postgres" --dsn 'postgres://user:pw@192.168.1.50:5432/app'
backupbot add --name "Legacy MySQL"  --dsn 'mysql://user:pw@db.example.com:3306/shop'
```

| Engine | TLS default for a remote host | Override |
|---|---|---|
| Postgres | `sslmode=require` — encrypted, certificate not verified | `?sslmode=verify-full` etc. in the DSN |
| MySQL | `ssl-mode=REQUIRED` — same trade | `?ssl-mode=…` — `DISABLED`, `PREFERRED`, `REQUIRED`, `VERIFY_CA`, `VERIFY_IDENTITY`, plus `&ssl-ca=/path/to/ca.pem` for the verifying modes |

Managed MySQL behind a proxy (Railway, PlanetScale) terminates TLS with a
self-signed certificate, and the MariaDB client has verified certificates by
default since 11.4 — so a bare connection string fails with
`TLS/SSL error: self-signed certificate in certificate chain`. Hence the
default. Hosts on localhost get `prefer` / `PREFERRED` instead.

### Schedules

Standard 5-field cron, evaluated in the target's own timezone — so `0 3 * * *`
means 3am where *you* are, not UTC, and it follows daylight saving.

```
0 3 * * *      every night at 3am
0 */6 * * *    every six hours
30 2 * * 0     Sundays at 02:30
0 2 * * 1-5    weekdays at 2am
```

Press `^p` in the TUI's add form to cycle presets. A schedule that comes due
while the machine is off is skipped, not run late — so pick an hour the machine
is reliably awake.

## The TUI

```bash
./run.sh myserver                                             # from your laptop, over a tunnel
./run.sh --local                                              # against an engine on this machine
docker exec -it backupbot bun run /app/packages/tui/src/index.tsx   # on the server itself
```

`./run.sh <ssh-host>` is the laptop path, and it cleans up after itself:
it installs dependencies if the checkout is fresh, opens an SSH forward on an
ephemeral local port, reads the API token off the server, runs the TUI, and
closes the tunnel when the TUI exits — including on ctrl-c, a crash, or
`kill -9`. Nothing is left listening and no token is written to your machine.
The host is whatever you type after `ssh`, so an `~/.ssh/config` alias works.

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

## Retention

Grandfather-father-son, the scheme every backup tool converges on. Four
independent buckets; a backup survives if *any* bucket still wants it, so one
dump can be today's daily and this month's monthly at the same time.

```
--retention keepLast,daily,weekly,monthly
--retention 7,7,4,6     # a week of dailies, a month of weeklies, six months of monthlies
```

| Policy | Keeps roughly |
|---|---|
| `7,7,4,6` (default) | 7 recent + a week of days + a month of weeks + six months — ~20 files |
| `3,0,0,0` | just the last three dumps |
| `14,14,8,12` | a fortnight of dailies and a year of monthlies |
| `0,0,0,0` | the newest one, always — an all-zero policy still never leaves you with nothing |

Weeks are ISO-8601, so "weekly" means the same thing across a year boundary.
Pruning runs only after a **successful** backup — or on demand with
`backupbot prune <target>` — so a run of failures can never age out the good
files you still have. This is the code that deletes things, so it's the part
covered hardest by unit tests.

## Restoring

```bash
backupbot artifacts shop-production     # list what's stored
backupbot restore 42                    # print the exact restore command
```

It prints rather than executes. A restore overwrites a live database, and that
should be a decision you make deliberately, with the command in front of you:

```
# /backups/shop-production/2026-09/shop-production-20260904T020000Z.dump  (840 MB, sha256 9f2c1a…)
# set TARGET_DSN to the database you want to restore INTO — this overwrites it.
pg_restore --clean --if-exists --no-owner --no-privileges -d "$TARGET_DSN" "/backups/…"
```

MySQL artifacts are zstd-compressed SQL, so theirs is
`zstd -dc <file> | mysql -h HOST -P PORT -u USER -p DATABASE`.

**You are not locked in.** These are stock `pg_dump` custom-format archives and
`mysqldump` SQL. Copy one to your laptop and restore it with the tools you
already have; backupbot doesn't need to exist for the files to be useful. That's
also the honest way to test your backups: restore last night's into a scratch
database and look at it.

## Notifications

A backup system that fails silently is worse than none, because you think you're
covered. Every finished run — scheduled, manual or over the API — is reported to
any channel that subscribed to it. Discord is the only provider so far.

The quickest route is an environment variable, so a deployment reports without
anyone opening the TUI. In `docker/.env`:

```
BACKUPBOT_DISCORD_WEBHOOK=https://discord.com/api/webhooks/123456789/…
BACKUPBOT_NOTIFY_EVENTS=success,failed      # or "failed", or "all"
```

Get the URL from Discord: Server Settings → Integrations → Webhooks → New
Webhook → Copy Webhook URL.

`n` in the TUI opens the same list — add, edit, enable, delete, and `^t` posts a
test message to a webhook before you save it. Channels added there or through
the CLI can be scoped to particular targets and events:

```bash
backupbot channel add --kind discord --url https://discord.com/api/webhooks/…
backupbot channel add --kind discord --url … --events failed --targets shop-production
backupbot channel test 1                    # posts a "this works" message
backupbot channels                          # includes the env-configured one
```

A success posts a green embed with the size, duration and artifact name; a
failure posts a red one carrying the error. Delivery is retried three times —
timeouts, 5xx and Discord's own 429 rate limit, whose `retry_after` is
honoured — and a 4xx gives up at once, because a deleted webhook won't recover.
**A notification can never fail a backup**: the outcome is recorded on the
channel and written into the run log, and that's all. `backupbot channels` shows
the last delivery, so a silent channel can be explained.

Want Slack, email or a plain webhook? It's one file in
`packages/engine/src/notify/` and one line in `PROVIDERS` — `ChannelProvider` is
the seam, and PRs are welcome.

## Getting the dumps offsite

backupbot deliberately stops at "the dumps exist, verified, on this machine".
The last hop is a solved problem, and `restic`, `rclone`, `borg` and Synology
Hyper Backup all do encryption, versioning and remote targets better than this
would. Point one of them at your backups directory:

```bash
# restic to S3, nightly, an hour after the last backup window
restic -r s3:s3.amazonaws.com/my-bucket backup /srv/backupbot/backups

# or rclone to anything it supports
rclone sync /srv/backupbot/backups b2:my-bucket/db-backups
```

On a Synology, point **Hyper Backup** at the folder and let it handle the B2 or
S3 leg.

Two things worth copying that aren't dumps: `master.key` from the data directory
(see [Security](#security)), and, if you want history and schedules to survive a
dead machine, `backupbot.sqlite` alongside it.

## Configuration reference

### The engine

Set these in the compose file's `environment:` block.

| Variable | Default | Purpose |
|---|---|---|
| `BACKUPBOT_DATA_DIR` | `/data` in the image, `./data` otherwise | SQLite, master key, run logs |
| `BACKUPBOT_BACKUPS_DIR` | `/backups` in the image, `./backups` otherwise | Where dumps are written |
| `BACKUPBOT_DB_FILE` | `<data>/backupbot.sqlite` | Override the database path alone |
| `BACKUPBOT_KEY_FILE` | `<data>/master.key` | Override the key path alone |
| `BACKUPBOT_LOGS_DIR` | `<data>/logs` | Override the log directory alone |
| `BACKUPBOT_KEY` | — | 64 hex characters. Wins over the key file, so an orchestrator can inject the secret and leave the data directory disposable |
| `BACKUPBOT_HOST` | `127.0.0.1` (`0.0.0.0` in the image) | API bind address |
| `BACKUPBOT_PORT` | `7817` | API port |
| `BACKUPBOT_TOKEN` | generated once, stored in `settings` | Pin the API bearer token |
| `BACKUPBOT_ALLOW_DOCKER` | unset | `1` enables `verify=restore`. Requires the Docker socket mounted |
| `BACKUPBOT_DISCORD_WEBHOOK` | — | An always-on notification channel that lives in the environment, not the database |
| `BACKUPBOT_NOTIFY_EVENTS` | `success,failed` | What that channel subscribes to: `success`, `failed`, `cancelled`, or `all` |
| `TZ` | `Europe/Madrid` via compose | Container clock. Schedules use each target's own timezone, so this only affects log timestamps |

### The compose file

Read from `docker/.env` at `docker compose` time, not by the engine.

| Variable | Default | Purpose |
|---|---|---|
| `BACKUPBOT_DATA_PATH` | `/volume1/docker/backupbot/data` | Host path mounted at `/data` |
| `BACKUPBOT_BACKUPS_PATH` | `/volume1/backups/databases` | Host path mounted at `/backups` |
| `BACKUPBOT_TZ` | `Europe/Madrid` | Passed through as `TZ` |

### Your laptop

| Variable | Default | Purpose |
|---|---|---|
| `BACKUPBOT_URL` | `http://127.0.0.1:7817` | Engine the TUI talks to |
| `BACKUPBOT_TOKEN` | — | Skips reading the token off the server |
| `BACKUPBOT_SSH_HOST` | — | Default host for `./run.sh` and `./redeploy.sh` |
| `BACKUPBOT_REMOTE_PORT` | `7817` | Port the engine listens on remotely |
| `BACKUPBOT_REMOTE_DB` | `/volume1/docker/backupbot/data/backupbot.sqlite` | Where the launcher reads the token from — **set this** if your data directory is elsewhere |
| `BACKUPBOT_REMOTE_SRC` | `/volume1/docker/backupbot/src` | Checkout `redeploy.sh` pulls into |
| `BACKUPBOT_BRANCH` | `main` | Branch `redeploy.sh` deploys |

The TUI resolves its token in order: `BACKUPBOT_TOKEN`, then
`~/.config/backupbot/tui.json`, then the engine's own database — that last one is
why the TUI needs no setup at all when it runs beside the daemon.

## CLI

Run it inside the container (`docker exec backupbot bun run /app/packages/cli/src/index.ts …`,
or the alias above), or locally with `bun run packages/cli/src/index.ts …`. The
CLI talks to the store and engine **in-process**, not over the API — so it works
even when the daemon is down, and needs no token.

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

`<ref>` is a target id or slug. `--json` gives machine-readable output for `ls`
and `channels`. `rm` deletes the target, not the dumps it already made.

| add/edit flag | Meaning |
|---|---|
| `--name` | Display name |
| `--slug` | Directory name (defaults to a slug of `--name`) |
| `--dsn` | Connection string; the engine is inferred from the scheme |
| `--schedule` | Cron expression, default `0 3 * * *` |
| `--tz` | IANA timezone for the schedule, default `UTC` |
| `--verify` | `none` \| `archive` \| `restore`, default `archive` |
| `--retention` | `keepLast,daily,weekly,monthly` — e.g. `7,7,4,6` |
| `--disabled` | Add the target without scheduling it |

| channel flag | Meaning |
|---|---|
| `--kind` | `discord` (the only provider so far) |
| `--url` | The webhook URL |
| `--name` | Display name, default `discord` |
| `--events` | `success,failed,cancelled` or `all` — default `success,failed` |
| `--targets` | Only notify for these target slugs — default every target |

## API

Everything the TUI does, over HTTP — so you can script it, or build your own
front end. All routes need `Authorization: Bearer <token>` except `/health`,
which is what the container's `HEALTHCHECK` polls.

```
GET    /health                          { ok, version } — unauthenticated
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
GET    /api/schedule                    every scheduled job and its next fire time
GET    /api/stats                       targets, enabled, running, failures24h, artifacts, totalBytes
GET    /api/channels                    notification channels, webhook masked
POST   /api/channels                    add
PATCH  /api/channels/:id
DELETE /api/channels/:id
POST   /api/channels/:id/test           post a test message
POST   /api/channels/test               test a webhook that isn't saved yet
```

Targets are addressed by id or slug. A DSN goes in as plaintext and never comes
back out — responses carry `dsnMasked` instead, which is why a `PATCH` with no
`dsn` field keeps the stored one.

```bash
TOKEN=$(docker exec backupbot bun run /app/packages/cli/src/index.ts token)
curl -sH "Authorization: Bearer $TOKEN" 127.0.0.1:7817/api/stats
# {"targets":2,"enabled":2,"running":0,"failures24h":0,"artifacts":14,"totalBytes":1288490188}
```

That's the endpoint to point a monitor at — alert on `failures24h`, or on the
age of the newest artifact.

### Reaching it from another machine

The API is on loopback. Tunnel in rather than exposing a backup control plane on
your LAN:

```bash
ssh -L 7817:127.0.0.1:7817 myserver
curl -H "Authorization: Bearer $TOKEN" 127.0.0.1:7817/api/targets
```

Two traps worth knowing:

- Some servers ship with **`AllowTcpForwarding no`** (Synology DSM does), and the
  tunnel is refused with `administratively prohibited: open failed`. Set it to
  `yes` in `/etc/ssh/sshd_config` and restart sshd.
- **Forward to `127.0.0.1`, not `localhost`.** Many hosts resolve `localhost` to
  `::1` first, and the engine binds IPv4 loopback only — the connection is
  accepted locally and then reset.

`./run.sh <ssh-host>` does all of this for you and tears the tunnel down again.

## Security

You are handing this program every one of your database passwords, so here is
exactly what it does with them:

- **Encrypted at rest.** Connection strings are sealed with AES-256-GCM. The key
  is generated on first run at `<data>/master.key` (mode 0600), or injected via
  `BACKUPBOT_KEY`.
- **Never in `argv`.** Postgres uses libpq keyword/value connection strings with
  `PGPASSWORD`; MySQL uses a 0600 defaults file deleted when the process exits.
  Nothing shows up in `ps`.
- **Never in a log.** Every stream captured from a dump tool is scrubbed of the
  password before it reaches a log file, the API or your terminal — `pg_dump`
  echoes connection details into its own error output. The redactor is built
  *before* the DSN is parsed, so even a malformed connection string can't leak
  on the way to its error message. The TUI test suite asserts that no password
  ever appears in a rendered frame.
- **Never handed back.** The API only ever returns a masked DSN.
- **Webhook URLs get the same treatment** — encrypted at rest, masked
  everywhere, including in the error messages notifications carry.
- **The API binds to `127.0.0.1`** unless told otherwise, and the bearer token is
  compared in constant time.
- **`verify=restore` is the only feature that needs the host Docker socket**, and
  it's inert unless the socket is mounted *and* `BACKUPBOT_ALLOW_DOCKER=1`.

Two things to be clear about:

- **The dumps themselves are not encrypted.** They sit in a `0700` root-owned
  directory and rely on your host's permissions. Encrypt them in whatever tool
  ships them offsite — `restic` and Hyper Backup both do this well.
- **Back up `master.key`.** Without it the stored connection strings are
  unrecoverable. It's 64 hex characters — a password manager entry is enough.
  The blast radius is small, though: it encrypts the DSNs, not the dumps, so
  losing it costs you the saved connection strings, not your backups.

## Operating it

**Is it still working?** Turn on notifications, and point a monitor at
`/api/stats` — alert on `failures24h`, or on the age of the newest artifact.
`backupbot ls` shows last and next run for every target at a glance.

**Logs.** `docker compose -f docker/docker-compose.yml logs -f` for the daemon.
Every run also has a full transcript at `<data>/logs/<slug>/run-<id>.log`, served
by the API and readable in the TUI's history screen.

**Restarts.** `restart: unless-stopped`, so it comes back with the host. A run
in flight when the daemon stops is marked failed on the next boot — nothing sits
in `running` forever. Shutdown is graceful: SIGTERM cancels active runs and
waits up to 15s for them to unwind.

**Moving to a new machine.** Stop the container, copy the data and backups
directories verbatim, point `docker/.env` at the new paths, `up -d --build`.
Targets, schedules, history and the key all live in the data directory; nothing
is stored anywhere else.

**Rotating the API token.** Set `BACKUPBOT_TOKEN` in the compose file and
restart; it takes precedence over the generated one.

**Uninstalling.** `docker compose … down`, delete the checkout. Your dumps are
plain files and stay exactly where they are.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Server is PostgreSQL 18 but the newest available client is 17` | Your provider upgraded past the image's newest client. Add the version to `PG_VERSIONS` in `docker/Dockerfile` and rebuild. |
| `Port 6543 is Supabase's transaction pooler` | Use the session pooler on 5432. The run fails immediately, by design. |
| `*.railway.internal only resolves inside Railway's network` | Use `DATABASE_PUBLIC_URL` / `MYSQL_PUBLIC_URL`. |
| `TLS/SSL error: self-signed certificate in certificate chain` | A MySQL host behind a proxy certificate. The default `ssl-mode=REQUIRED` handles it — if you asked for `VERIFY_CA`, supply `&ssl-ca=…`. |
| `connection string is not a valid URL` | Percent-encode `@ : / ? #` in the password. |
| `dump produced an empty file` | The dump tool exited 0 with no output — usually the user lacks read permission on the source. Check the run log. |
| A run is stuck in `running` | The daemon died mid-run. It's reaped and marked failed on the next start. |
| `a backup of "x" is already running` | One run per target at a time, by design. Cancel it in the TUI (`c`) or via `POST /api/runs/:id/cancel`. |
| `restore verification requires BACKUPBOT_ALLOW_DOCKER=1` | The target asks for `verify=restore`. Either mount the socket and set the flag, or drop it back to `archive`. |
| `administratively prohibited: open failed` on `ssh -L` | `AllowTcpForwarding no` in the server's `sshd_config`. |
| Tunnel connects, then the connection resets | You forwarded to `localhost`, which resolved to `::1`. Use `127.0.0.1`. |
| `No API token found` from the TUI | Set `BACKUPBOT_TOKEN`, or use `./run.sh <host>`, which reads it off the server for you. |
| Backups stopped and nobody noticed | Set up [notifications](#notifications). This is the failure mode the whole project exists to prevent. |

## FAQ

**Will this lock my tables or slow down production?**
It runs `pg_dump` / `mysqldump` as an ordinary client. Those take the locks they
normally take and read the whole database, so schedule it for a quiet hour.
Nothing is ever written back.

**What happens when my provider upgrades Postgres?**
Nothing. The image carries clients 14–18 and asks the server its version on
every run. If a provider ever jumps past the newest bundled client, the run
fails loudly with the exact package to add — never with a truncated dump.

**Does it work on a Raspberry Pi?**
Yes — the image builds for arm64 as well as amd64.

**Can I back up a database on my own network?**
Yes, any reachable host. Local connections skip the "certificate not verified"
TLS default and use `prefer` / `PREFERRED`.

**What if the machine is off when a backup is due?**
That window is skipped, not run late. Pick an hour the machine is reliably on.

**How many databases can it handle?**
Backups run one at a time per target, and several targets can run concurrently.
The practical limits are your disk and the source databases' patience, not this
program.

**Does it deduplicate or do incremental backups?**
No — every run is a full dump. Deduplication is what `restic` and `borg` are
for, and they'll do it on the way offsite.

**Can I test that my backups actually restore?**
Set `--verify restore` on a target and it restores every dump into a throwaway
container and counts the tables. Or do it by hand: `backupbot restore <id>`
prints the command, point it at a scratch database. Do this at least once.

**Is my data sent anywhere?**
No. It connects to your databases and, if you configure it, posts run results to
your own Discord webhook. There's no telemetry, no phone-home, no account.

## On a Synology NAS

This is the deployment it was written for, and DSM has enough quirks to deserve
its own section. You need DSM with **Container Manager** (x86_64 models).

```bash
git clone https://github.com/PuenteBits/backupbot.git /volume1/docker/backupbot/src
cd /volume1/docker/backupbot/src
cp docker/.env.example docker/.env   # the defaults are already Synology-shaped
sudo docker compose -f docker/docker-compose.yml up -d --build
sudo docker compose -f docker/docker-compose.yml logs -f
```

Three things DSM does differently:

- **The Docker socket is root-only**, so every `docker` command needs `sudo`.
  That also rules out unattended docker over SSH, since `sudo` wants a password.
- **`docker` is not on the non-interactive PATH** — it lives under the
  ContainerManager package at `/usr/local/bin/docker`. Scripts have to resolve it
  rather than assume it.
- **`AllowTcpForwarding` is off**, which breaks `ssh -L` until you turn it on in
  `/etc/ssh/sshd_config` and `sudo synosystemctl restart sshd`. A DSM update can
  revert the file, so check it first if tunnelling suddenly stops working.

Point **Hyper Backup** at your backups folder for the offsite leg.

### redeploy.sh

If you deploy from a laptop, `./redeploy.sh <ssh-host>` handles the DSM
awkwardness: it refuses to pull over a dirty checkout, shows you the incoming
commits, rebuilds, and waits for `/health` before reporting success. It sets
`ssh -A` (so a private fork can authenticate with your forwarded agent) and
`ssh -t` (so `sudo` can prompt) itself, so run it from a real terminal rather
than a script.

```bash
./redeploy.sh nas          # pull main on the server and rebuild
./redeploy.sh nas --force  # rebuild even with nothing new to pull
```

On a plain Linux host, the ordinary two lines are enough:

```bash
git pull && docker compose -f docker/docker-compose.yml up -d --build
```

## Under the hood

Skip this unless you're curious or planning to change something.

### Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Bun 1.x** | One binary runs TypeScript directly — no build step, no bundler, no `dist/`. Ships `bun:sqlite` and a fast `spawn`, which is most of what this program does. |
| Language | **TypeScript** (strict, `noUncheckedIndexedAccess`) | Type-checked with `tsc --noEmit`; nothing is transpiled ahead of time. |
| HTTP | **Hono 4** on `Bun.serve` | Small, typed router with first-class SSE for the live run log. |
| State | **SQLite** via `bun:sqlite`, WAL mode | One file, no server. WAL lets the CLI read history while the daemon is mid-backup. Migrations are append-only, tracked in `PRAGMA user_version`. |
| Scheduling | **croner 9** | Cron expressions with real IANA timezone support and overlap protection. |
| Validation | **zod 3** | One schema per record, shared by the CLI, the API and the TUI. |
| Terminal UI | **OpenTUI + React 19** | The TUI is a React app rendered to the terminal, tested with OpenTUI's test renderer. |
| Crypto | `node:crypto` — AES-256-GCM | Connection strings and webhook URLs are encrypted at rest under one master key. |
| Dump tools | `postgresql-client` 14–18, `mariadb-client`, `zstd` | Installed in the image from the PGDG apt repo; the engine picks per run. |
| Container | `oven/bun:1-debian` | Debian because PGDG publishes there; amd64 and arm64 both build. |
| Packaging | Bun workspaces, 4 packages | `core`, `engine`, `cli`, `tui`. |

No ORM, no build step, no runtime dependencies beyond zod, croner, Hono and
OpenTUI/React — ~5,500 lines of TypeScript, plus a thousand more of tests.

### Architecture

```
  your laptop                     the host — NAS, VPS, spare box
  ───────────                     ──────────────────────────────────────────────

  ┌─────────┐    ssh -L 7817      ┌──────────────────────────────────────────┐
  │   TUI   │───────────────────▶ │ container: backupbot                     │
  └─────────┘    bearer token     │                                          │
                                  │   ┌─────────┐  reload   ┌─────────────┐  │
  ┌─────────┐    docker exec      │   │   API   │──────────▶│  Scheduler  │  │
  │   CLI   │───────────────────▶ │   │  (Hono) │           │  (croner)   │  │
  └─────────┘    in-process       │   └────┬────┘           └──────┬──────┘  │
                                  │        │ run · SSE log         │ cron    │
                                  │        └───────────┬───────────┘         │
                                  │                    ▼                     │
                                  │              ┌───────────┐               │
                                  │              │  Runner   │               │
                                  │              └─────┬─────┘               │
                                  │     ┌────────┬─────┴────┬─────────┐      │
                                  │     ▼        ▼          ▼         ▼      │
                                  │  Adapter   Verify   Retention  Notifier  │
                                  │  pg/mysql  archive/    GFS      Discord  │
                                  │     │      restore      │         │      │
                                  └─────┼───────────────────┼─────────┼──────┘
                                        │                   │         │
                   pg_dump / mysqldump  │            prunes │         │ webhook
                             over TLS   ▼                   ▼         ▼
                                   your databases        /backups   Discord
                                   Supabase · Railway    dump files
                                   Neon · PlanetScale
                                                          /data
                                                          SQLite · key · logs
```

| Package | Contents |
|---|---|
| `@backupbot/core` | Schemas (`schema.ts`), the SQLite store and migrations (`db.ts`, `store.ts`), encryption (`crypto.ts`), DSN parsing and the warnings that catch bad connection strings (`dsn.ts`), provider guides (`providers.ts`), log redaction (`redact.ts`), path resolution (`paths.ts`). No I/O beyond the database. |
| `@backupbot/engine` | The daemon: `runner.ts` (one backup, start to finish), `scheduler.ts`, `api.ts` (Hono), `adapters/` (postgres, mysql), `tools.ts` (client discovery and version matching), `verify-restore.ts`, `retention.ts`, `notify/` (channel providers), `runlog.ts`, `exec.ts` (redacted subprocess plumbing). |
| `@backupbot/cli` | `backupbot` — one file, `node:util.parseArgs`, talks to `core`/`engine` in-process rather than over the API. |
| `@backupbot/tui` | The React/OpenTUI client: `app.tsx` plus one file per screen, `api.ts` (HTTP client), `remote.ts` (the self-closing SSH tunnel launcher). Talks to the engine over the API only. |

The dependency direction is strict: `core` knows nothing about the engine, the
engine knows nothing about the TUI, and the TUI reaches the engine over HTTP
only — which is why the same TUI works locally and over a tunnel.

### Anatomy of a run

Whether it's triggered by cron, `backupbot run`, or `POST /api/targets/:ref/run`,
every backup goes through `Runner.run`:

1. **Claim the target.** One run per target at a time; a second attempt is
   refused with `TargetBusyError` rather than queued.
2. **Open a run row and a log file.** The API can hand back a `runId` and start
   streaming before the dump begins.
3. **Build a redactor** from the DSN and its password — seeded *before* parsing,
   so even a failure on a malformed DSN can't leak the password into a log.
4. **Inspect the DSN.** Known-bad choices (Supabase's transaction pooler,
   Railway's internal host) fail here, in the first second, rather than at 3am.
5. **Pick the client.** Ask the server its version, choose the matching binary.
6. **Dump** to `<artifact>.partial`, streaming redacted tool output to the log.
   Postgres uses `--format=custom` (already compressed); MySQL pipes through
   `zstd -3`, or `gzip` if zstd is missing.
7. **Verify** at the target's level. A failure throws, which deletes the partial.
8. **Rename** to the final path, hash it (sha256), record the artifact row.
9. **Prune** per the retention policy — only ever after a success.
10. **Finish the run** and **notify** every subscribed channel. Notification
    failures are recorded on the channel and in the run log; they can never fail
    a backup.

### On disk

```
<data>
  backupbot.sqlite          targets · runs · artifacts · channels · settings (WAL)
  master.key                0600 — AES-256-GCM key for DSNs and webhook URLs
  logs/<slug>/run-<id>.log  full redacted transcript of every run

<backups>
  <slug>/<YYYY-MM>/<slug>-20260904T020000Z.dump      Postgres, pg_dump custom format
  <slug>/<YYYY-MM>/<slug>-20260904T020000Z.sql.zst   MySQL, zstd-compressed SQL
```

Both directories are created mode `0700` and the container runs as root, so
dumps are root-only on the host.

### Data model

| Table | Holds |
|---|---|
| `targets` | name, slug, engine, **`dsn_enc`** (encrypted), cron expression + timezone, retention JSON, verify mode, enabled |
| `runs` | status (`running`/`success`/`failed`/`cancelled`), trigger (`schedule`/`manual`/`api`), timings, bytes, error, log path |
| `artifacts` | path, size, sha256, format — one row per stored dump, cascade-deleted with its run or target |
| `channels` | notification channels; **`config_enc`** (encrypted — a webhook URL is a credential), event and target filters, last delivery result |
| `settings` | key/value; currently the generated API token |

Migrations are append-only strings in `packages/core/src/db.ts`: add to the end,
never edit an existing one. `PRAGMA user_version` counts how many have run.

## Development

```bash
bun install
bun test          # unit tests plus TUI tests driven against a real engine
bun run typecheck # tsc --noEmit
bun run engine    # the daemon
bun run tui       # the terminal client
bun run cli ls    # the CLI
```

State goes to `./data` and `./backups` in the repo when the env vars are unset;
both are gitignored.

The TUI tests use OpenTUI's test renderer: they mount the real app against a
real engine and a real MySQL server, press keys, and assert on captured frames —
including that no password ever appears in a rendered frame. The retention tests
are the other place to be careful, for the obvious reason.

Local runs need `pg_dump` / `mysqldump` on PATH; client discovery finds
Homebrew's `postgresql@<n>` formulae as well as Debian's layout. The container is
the supported path for everything else.

Good first contributions: another notification provider (Slack, plain webhook,
email — `ChannelProvider` is the seam), another database engine (`Adapter` is
the seam), or per-target schema include/exclude filters.

## Status

Working end to end and running nightly in production: core, engine, scheduler,
API, CLI, TUI and Docker image. Backups, verification, retention, restore
commands and Discord notifications all work over the TUI, the CLI and the API.

On the list: more notification providers, MongoDB support, per-target schema
filters, and reporting runs that a container restart interrupted.

Bug reports and pull requests welcome.

## License

MIT — see [LICENSE](LICENSE). Use it, fork it, run it for your own backups.
