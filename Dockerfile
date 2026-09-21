# ATOM Desk — `pnpm serve` / `tsx apps/web/src/server.ts` on :8787
# Native better-sqlite3 needs python3 + make + g++ at image build time.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

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
