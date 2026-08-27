# syntax=docker/dockerfile:1
FROM oven/bun:1-debian

# pg_dump refuses to dump from a server newer than itself, so every major
# version we might meet is installed side by side under /usr/lib/postgresql/<n>.
ARG PG_VERSIONS="14 15 16 17 18"
ARG DOCKER_CLI_VERSION=27.3.1

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg zstd mariadb-client tzdata \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && . /etc/os-release \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
http://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && for v in $PG_VERSIONS; do apt-get install -y --no-install-recommends "postgresql-client-$v"; done \
 && apt-get purge -y gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# Docker CLI only (no daemon) — used solely by opt-in restore verification,
# and inert unless the host socket is mounted and BACKUPBOT_ALLOW_DOCKER=1.
RUN arch="$(dpkg --print-architecture)" \
 && case "$arch" in amd64) dl=x86_64 ;; arm64) dl=aarch64 ;; *) dl="" ;; esac \
 && if [ -n "$dl" ]; then \
      curl -fsSL "https://download.docker.com/linux/static/stable/$dl/docker-${DOCKER_CLI_VERSION}.tgz" \
        | tar -xz -C /usr/local/bin --strip-components=1 docker/docker; \
    fi

WORKDIR /app
COPY package.json bun.lock* ./
COPY packages/core/package.json  packages/core/
COPY packages/engine/package.json packages/engine/
COPY packages/cli/package.json   packages/cli/
COPY packages/tui/package.json   packages/tui/
RUN bun install --frozen-lockfile || bun install
COPY packages ./packages

ENV BACKUPBOT_DATA_DIR=/data \
    BACKUPBOT_BACKUPS_DIR=/backups \
    BACKUPBOT_HOST=0.0.0.0 \
    BACKUPBOT_PORT=7817
VOLUME ["/data", "/backups"]
EXPOSE 7817

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.BACKUPBOT_PORT??7817)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["bun", "run", "/app/packages/cli/src/index.ts"]
CMD ["serve"]
