# 11 · Single API

Desk and CLI are two clients of **one local HTTP daemon**. `@atom/core` is not a second entry point.

```
  Desk (browser)          CLI (`pnpm atom …`)          curl (one-shot)
         │                        │                         │
         └──────────── fetch ─────┴──────────── fetch ──────┘
                                      │
                                      ▼
                         pnpm atom serve  /  pnpm web
                         apps/web/src/server.ts
                                      │
                         ┌────────────┴────────────┐
                         │  /api/*  JSON in/out    │
                         │  /hooks/*  inbound webhooks
                         │  in-process cron poll
                         └────────────┬────────────┘
                                      ▼
                              @atom/core + SQLite
```

## Serve (keep this running)

```bash
pnpm atom serve          # alias of pnpm web
# Desk:  http://127.0.0.1:8787
# API:   http://127.0.0.1:8787/api/…
```

`ATOM_WEB_PORT` changes the listen port. `ATOM_WEB_HOST` changes the bind address (default `127.0.0.1` for `pnpm serve`; Docker compose sets `0.0.0.0`). CLI defaults to `http://127.0.0.1:$ATOM_WEB_PORT` or override with `ATOM_API_BASE`.

Docker alternative (no LaunchAgent): `docker compose up -d` — same daemon, published `8787:8787`. Linux `yzj-cli` / `grok` are in the image; device-code login is `docker compose exec desk yzj-cli auth login --device`. See README **Docker (Desk)** / **Yunzhijia from Docker**.

If the API is down, the CLI prints one line and exits — it does **not** import `@atom/core` and run in-process:

```
ATOM API is not running at http://127.0.0.1:8787. Start it with `pnpm atom serve` (or `pnpm web`).
```

**Exception:** `pnpm atom progress-scan` writes `data/progress-snapshot.json` on the host (git/`gh` against `workspaces.json` paths). Desk in Docker cannot see `/Users/kingdee/dev/…`, so this command is host-local by design. It does not open SQLite. `--apply` still talks to the API (`POST /api/done-sweep`) when Desk is up.

Optional: `ATOM_API_AUTO_START=1` may spawn `serve` once and retry. If spawn/health fails, same one-liner — never a silent core fallback.

## Daily vs automation

| Who | How |
|---|---|
| Human, daily | Desk at `http://127.0.0.1:8787` |
| Human, terminal | `pnpm atom <cmd>` → same `/api/*` |
| Timed ingest | in-process cron on serve (`data/triggers.json` `poll-yzj-15m`) |
| One-shot / CI | `curl` the API (or `pnpm atom run`) |

Human gates stay human. `/api/checklist-ack` requires `{ "ack": true }` and will not auto-approve.

## Cron (in-process)

`pnpm serve` or `docker compose up` starts the 15-minute poll. Do not load LaunchAgents (`com.guoxinshan.atom.serve` / `com.guoxinshan.atom.morning-run`).

```bash
# one-shot still works — daemon must already be up
curl -sS -X POST http://127.0.0.1:8787/api/run \
  -H 'content-type: application/json' \
  -d '{"source":"yzj-ai-advance","groupIds":["…"]}'
```

Webhook alias (same pipeline as `/api/run`):

```bash
curl -sS -X POST http://127.0.0.1:8787/hooks/run \
  -H 'content-type: application/json' \
  -d '{"source":"yzj"}'
```

Use **`POST /api/run`** from the CLI. Keep **`POST /hooks/run`** for inbound webhooks. Split steps: `/api/ingest`, `/api/extract`, `/api/digest` (also `/hooks/ingest|extract|digest`).

## Command → route

| CLI | HTTP |
|---|---|
| `serve` | *(starts this daemon)* |
| `candidates [--status]` | `GET /api/candidates?status=` |
| `approve <id>` | `POST /api/approve` `{id, note?}` |
| `reject <id>` | `POST /api/reject` `{id, reason?}` |
| `reject-noise` | `POST /api/reject-noise` |
| `merge-sweep [--apply]` | `POST /api/merge-sweep` `{apply?}` (default dry-run) |
| `tag-backfill [--apply]` | `POST /api/tag-backfill` `{apply?}` (default dry-run; suggested only) |
| `progress-scan [--apply]` | **host-local** write `data/progress-snapshot.json` (imports core for git/`gh`; Docker cannot see Mac paths). `--apply` then `POST /api/done-sweep` `{apply:true}` if Desk is up |
| `done-sweep [--apply]` | `POST /api/done-sweep` `{apply?}` (default dry-run; already_done off Needs-you) |
| `reopen <id>` | `POST /api/reopen` `{id, note?}` (「仍要我跟」; already_done only) |
| `outbound-check [--title …] [--body … \| --path]` | `POST /api/outbound-check` `{title?, body?, kind?}` (never sends) |
| `preference-rsi [--dry-run \| --apply]` | `POST /api/preference-rsi` `{apply?}` (default dry-run; never sends) |
| `gate-digest [--since …] [--json]` | `GET` or `POST /api/gate-digest` `{since?}` (read-only; default last 24h; never sends) |
| *(Desk 我的偏好)* | `GET /api/preference-memory` (file + last RSI; never sends) |
| *(Desk 我的偏好 light-edit)* | `PATCH /api/preference-memory` `{thresholds?, blocklist?, blocklist_add?, blocklist_remove?}` (clamped; never sends; does not move RSI `cursor_at`) |
| *(Desk status strip)* | `GET /api/status` `{desk, lastRunAt, lastExtractAt, preference.floors, laya}` (Laya probe ≤400ms) |
| `specs` | `GET /api/specs` |
| `handoff <id>` | `POST /api/handoff` `{id, run?, target?}` |
| `lead "…"` | `POST /api/lead` `{utterance}` |
| `agents` | `GET /api/agents` |
| `doctor` | `GET /api/doctor` *(same report as `GET /api/setup`)* |
| `setup` | `POST /api/setup` *(ensure templates + report)* |
| `sources` | `GET /api/sources` |
| `subscriptions` | `GET /api/subscriptions` |
| `triggers` | `GET /api/triggers` |
| `workspaces` | `GET /api/workspaces` |
| `checklist-ack <id>` | `POST /api/checklist-ack` `{id, ack:true}` |
| `run` | `POST /api/run` |
| `ingest` | `POST /api/ingest` |
| `extract` | `POST /api/extract` |
| `digest` | `POST /api/digest` |
| `evidence <id> --path` | `POST /api/evidence` `{id, path}` |
| `checklist <id>` | `POST /api/checklist` `{id}` |
| `checklist-done …` | `POST /api/checklist-done` `{id, itemKey, note?, ack?}` |
| `pr-open …` | `POST /api/pr-open` `{id, url, branch?, force?}` |
| `route <id>` | `POST /api/route` `{id}` |

Health: `GET /api/health` → `{ ok: true, service: "atom-desk" }`.

Runtime clocks (real only): `GET /api/meta` → `{ ok, lastExtractAt, lastRunAt }` — either ISO string or `null`. Desk empty state does not invent a last-run time. The status strip uses `GET /api/status` (same clocks plus floors + cheap Laya/Desk health).

## Layout

Handlers live in `apps/web/src/routes.ts` (daemon owns DB + core). The CLI is `apps/cli/src/client.ts` + `main.ts` — no `openDb`, no pipeline imports except **`progress-scan`** (host git snapshot writer).
