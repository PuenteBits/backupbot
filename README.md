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
ssh -L 7817:localhost:7817 nas
curl -H "Authorization: Bearer $TOKEN" localhost:7817/api/targets
```

## The TUI

```bash
bun run tui                                   # from a checkout
docker exec -it backupbot bun run /app/packages/tui/src/index.tsx   # on the NAS
```

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
| Targets | `↑↓`/`jk` move · `⏎` history · `r` run now · `a` add · `e` edit · `t` test connection · `space` enable/disable · `d` delete · `q` quit |
| Add/edit | `tab` next field · `←→` change option · `^p` cycle schedule presets · `^t` test connection · `^s` save · `esc` cancel |
| History | `tab` switch pane · `↑↓` move · `⏎` open log / show restore command · `r` run now · `esc` back |
| Live run | `esc` back · `c` cancel the run |

`r` streams the running backup's log live over server-sent events, so you watch
`pg_dump` work through your tables in real time and see the verification verdict
as it lands. Editing a target leaves the connection field blank on purpose —
the API only ever hands back a masked DSN, so blank means "keep the stored one".

## Adding a target

```bash
docker exec backupbot bun run /app/packages/cli/src/index.ts \
  add --name "Shop production" \
      --dsn 'postgres://postgres.abcdefgh:PASSWORD@aws-0-eu-west-1.pooler.supabase.com:5432/postgres' \
      --schedule '0 3 * * *' --tz Europe/Madrid \
      --retention 7,7,4,6
```

Percent-encode anything exotic in the password: `@` → `%40`, `:` → `%3A`,
`/` → `%2F`.

### Supabase

Use the **session pooler** connection string from Project Settings → Database:

- `…pooler.supabase.com:5432` ✅ — IPv4, works with `pg_dump`
- `…pooler.supabase.com:6543` ❌ — transaction pooler, cannot serve `pg_dump`
- `db.<ref>.supabase.co:5432` ⚠️ — direct, IPv6-only without the paid IPv4 add-on

`backupbot test` and `add` flag all three cases before you find out at 3am.

### Railway

Use the public `DATABASE_URL` from the service's Variables tab (the
`*.proxy.rlwy.net` host). The internal `*.railway.internal` host only resolves
inside Railway's network.

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

## CLI

Run inside the container (`docker exec backupbot bun run /app/packages/cli/src/index.ts …`)
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

Possible next steps: notification channels (the `Notifier` interface is in place
with a no-op default), per-target schema include/exclude filters, and MongoDB
support.
