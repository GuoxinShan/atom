# ATOM Desk — `pnpm serve` / `tsx apps/web/src/server.ts` on :8787
# Native better-sqlite3 needs python3 + make + g++ at image build time.
# yzj-cli postinstall curls a linux-{x64,arm64} Rust binary (needs curl + unzip).
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ curl unzip ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=/usr/local/bin:$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# Linux CLIs spawned by serve/cron (`yzj-cli`, `grok`). Do not bind-mount Mac binaries.
# @yunzhijia/cli os=linux,darwin,win32 / cpu=x64,arm64 — npm wrapper + CDN binary.
# @xai-official/grok optionalDependencies ship linux-x64 and linux-arm64.
ARG YZJ_CLI_VERSION=0.1.6
ARG GROK_CLI_VERSION=1.0.40
RUN npm install -g "@yunzhijia/cli@${YZJ_CLI_VERSION}" "@xai-official/grok@${GROK_CLI_VERSION}" \
  && yzj-cli --version \
  && grok --version

# Device-code login persists here (named volumes in compose). Never bake tokens into the image.
ENV YZJ_CLI_CONFIG_DIR=/root/.yzj-cli
ENV YZJ_CLI_DATA_DIR=/root/.local/share/yzj-cli
RUN mkdir -p /root/.yzj-cli /root/.local/share/yzj-cli /root/.grok

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/adapters/package.json packages/adapters/

# Keep tsx (root devDependency); serve is still `tsx apps/web/src/server.ts`.
RUN pnpm install --frozen-lockfile

COPY . .

# Published compose port only reaches a non-loopback bind.
ENV ATOM_WEB_HOST=0.0.0.0
ENV ATOM_WEB_PORT=8787

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Same entry as `pnpm serve` on the host. Image does not autostart on boot;
# start with `docker compose up` (see docker-compose.yml restart: "no").
CMD ["pnpm", "serve"]
