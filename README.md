# ATOM

Append-only **demand feed** with mandatory citations. Machines propose. Humans decide.

Domain unit: **atom**. SQL table: **`events`** (never `atoms`).

Stage-1 MVP: local Dispatch Desk + CLI HTTP client + Markdown 需求日报. No Next.js product app.

**One API.** Desk and CLI both talk to the local daemon. Core is not a second CLI entry. See [`docs/11-single-api.md`](docs/11-single-api.md).

## Quickstart

```bash
cd /Users/kingdee/dev/personal/atom   # or this repo root
pnpm install
pnpm atom serve        # Desk + API — keep this running
# open http://127.0.0.1:8787
```

In another terminal (daemon must be up):

```bash
pnpm atom run          # ingest → extract → digest via POST /api/run
pnpm atom candidates   # GET /api/candidates
```

Digest lands in `out/digest-YYYY-MM-DD.md`. SQLite at `data/atom.sqlite`.

Daily: use **Desk**. Automation: **curl the API** or `pnpm atom` (thin client). Always keep `pnpm atom serve` (or `pnpm web`) running.

If the API is down, the CLI exits with:

```
ATOM API is not running at http://127.0.0.1:8787. Start it with `pnpm atom serve` (or `pnpm web`).
```

It does not fall back to in-process `@atom/core`. Optional `ATOM_API_AUTO_START=1` may spawn serve once.

### Commands

| Command | What it does |
|---|---|
| `pnpm atom serve` | start Desk + HTTP API (`pnpm web`) |
| `pnpm atom run` | ingest → extract → digest (`POST /api/run`) |
| `pnpm atom ingest` | pull source only |
| `pnpm atom extract [--agent heuristic\|grok-cli]` | propose candidates |
| `pnpm atom digest` | rewrite Markdown projection |
| `pnpm atom candidates` | print candidate projection |
| `pnpm atom approve <id>` | append `decision_accepted` |
| `pnpm atom reject <id>` | append `decision_rejected` |
| `pnpm atom reject-noise` | reject suggested junk (`bot digest` / `收到✅` / log dumps) as `decision_rejected` reason `noise-heuristic` |
| `pnpm atom checklist <id>` | start Stage-2 PR checklist (append-only; not auto-merge) |
| `pnpm atom checklist-done <id> <itemKey> [--ack]` | mark a checklist item; `--ack` required for `human_gate_ack` |
| `pnpm atom pr-open <id> --url <prUrl>` | append `pr_opened` only after `pr_checklist_passed` (`--force` warns) |

Default extract agent is **heuristic** (offline). Primary LLM path is **GrokCliExtractAgent** (`grok -p --always-approve --json-schema …`).

Optional **Laya** System-1 HTTP (`LAYA_URL`, default `http://127.0.0.1:8790`) is three gates: extract demand-vs-noise, extract duplicate-merge into an existing Needs-you item, and lead ornith/bonsai intensity on handoff. If Laya is down or low-confidence, ATOM fail-opens to today’s behavior. Set `LAYA_ENABLED=0` to skip. See [`docs/08-lead-agent.md`](docs/08-lead-agent.md).

```bash
pnpm atom run --agent grok-cli
```

### Dispatch Desk

Same daemon, same SQLite. Approve/reject append decision atoms. Lead NL configures sources.

```bash
pnpm atom serve
# open Desk at http://127.0.0.1:8787
```

Light zinc inbox (paper + indigo `#6e7bf2`). Listen → propose → approve → route.

### Cron / webhooks

```bash
curl -sS -X POST http://127.0.0.1:8787/api/run \
  -H 'content-type: application/json' \
  -d '{"source":"yzj"}'
```

Inbound webhooks use `/hooks/run` (same pipeline). CLI `run` uses `/api/run`.

### Yunzhijia source (stub)

Enable in `data/sources.json` or:

```bash
ATOM_YZJ_GROUP_IDS=group1,group2 pnpm atom run --source yzj
```

Wraps `yzj-cli im message list` (ok if untested without groups).

Sweep leftover bot-digest / `收到✅` / log-dump suggestions: `pnpm atom reject-noise`.

## Layout

```
apps/cli/          # thin HTTP client (ATOM_API_BASE, default http://127.0.0.1:8787)
apps/web/          # Dispatch Desk (static) + the only local API / core owner
packages/core/     # events writer, projections, agents, registry
packages/adapters/ # fixture + yzj stub
fixtures/          # demo messages.jsonl
data/sources.json  # SourceRegistry config
out/               # digests (gitignored)
docs/              # contracts (see 02-atom-contract, 06-extensibility, 11-single-api)
```

## Contracts

- `candidate_proposed` without refs is **rejected** by the writer.
- Atom types: see `docs/02-atom-contract.md` (incl. Stage-2 `pr_checklist_*` + existing `pr_opened` / `evidence_attached`).

## Docs
- [Operating plan (dogfood)](docs/12-operating-plan.md) — daily rhythm, accept boundary, group/noise
