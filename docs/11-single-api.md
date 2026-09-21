# 11 · Single API

Desk and CLI are two clients of **one local HTTP daemon**. `@atom/core` is not a second entry point.

```
  Desk (browser)          CLI (`pnpm atom …`)          curl / cron
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

`ATOM_WEB_PORT` changes the listen port. CLI defaults to `http://127.0.0.1:$ATOM_WEB_PORT` or override with `ATOM_API_BASE`.

If the API is down, the CLI prints one line and exits — it does **not** import `@atom/core` and run in-process:

```
ATOM API is not running at http://127.0.0.1:8787. Start it with `pnpm atom serve` (or `pnpm web`).
```

Optional: `ATOM_API_AUTO_START=1` may spawn `serve` once and retry. If spawn/health fails, same one-liner — never a silent core fallback.

## Daily vs automation

| Who | How |
|---|---|
| Human, daily | Desk at `http://127.0.0.1:8787` |
| Human, terminal | `pnpm atom <cmd>` → same `/api/*` |
| Cron / CI / other tools | `curl` the API (or `pnpm atom run`) |

Human gates stay human. `/api/checklist-ack` requires `{ "ack": true }` and will not auto-approve.

## Cron example

```bash
# launchd / crontab — daemon must already be up
curl -sS -X POST http://127.0.0.1:8787/api/run \
  -H 'content-type: application/json' \
  -d '{"source":"yzj"}'
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
| `outbound-check [--title …] [--body … \| --path]` | `POST /api/outbound-check` `{title?, body?, kind?}` (never sends) |
| `preference-rsi [--dry-run \| --apply]` | `POST /api/preference-rsi` `{apply?}` (default dry-run; never sends) |
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

Runtime clocks (real only): `GET /api/meta` → `{ ok, lastExtractAt, lastRunAt }` — either ISO string or `null`. Desk empty state uses this; it does not invent a last-run time.

## Layout

Handlers live in `apps/web/src/routes.ts` (daemon owns DB + core). The CLI is `apps/cli/src/client.ts` + `main.ts` — no `openDb`, no pipeline imports.
