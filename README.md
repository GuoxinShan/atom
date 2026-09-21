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

Daily: use **Desk**. Timed ingest runs **inside** serve (15-minute weekday poll, Asia/Shanghai 08:00–20:00). Curl still works if you want a one-shot. Start serve with `docker compose up -d` (see [Docker](#docker-desk)) or `pnpm atom serve` — **not** a LaunchAgent / login item.

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
| `pnpm atom merge-sweep [--apply]` | one-shot Laya fold of existing open Needs-you twins (dry-run default; `--apply` writes) |
| `pnpm atom outbound-check [--title …] [--body … \| --path <file>] [--kind digest]` | Laya pre-post gate (allow/drop/hold); never sends |
| `pnpm atom preference-rsi [--dry-run \| --apply]` | daily Desk-feedback loop: tune Laya floors / allowlists (dry-run default; `--apply` writes `data/preference-memory.json`) |
| `pnpm atom gate-digest [--since 24h\|7d\|YYYY-MM-DD\|ISO] [--json]` | read-only Laya gate acceptance digest for the morning report (default last 24h; markdown stdout, JSON for Desk) |
| `pnpm atom checklist <id>` | start Stage-2 PR checklist (append-only; not auto-merge) |
| `pnpm atom checklist-done <id> <itemKey> [--ack]` | mark a checklist item; `--ack` required for `human_gate_ack` |
| `pnpm atom pr-open <id> --url <prUrl>` | append `pr_opened` only after `pr_checklist_passed` (`--force` warns) |

Default extract agent is **heuristic** (offline). Primary LLM path is **GrokCliExtractAgent** (`grok -p --always-approve --json-schema …`).

Optional **Laya** System-1 HTTP (`LAYA_URL`, default `http://127.0.0.1:8790`) is four gates: extract demand-vs-noise, extract duplicate-merge into an existing Needs-you item, outbound / pre-post (digest subscription emit + `pnpm atom outbound-check`), and lead ornith/bonsai intensity on handoff. If Laya is down or low-confidence, ATOM fail-opens to today’s behavior. Per-call timeout defaults to `LAYA_TIMEOUT_MS=10000` (10s) so Mac CPU Laya can finish open-list `/v1/predict`; a single timeout fail-opens that candidate (`reason=timeout`) without disabling later gates. Connection refused / repeated 5xx / `/health` down still mark Laya unavailable (`reason=unavailable`). Set `LAYA_ENABLED=0` to skip. Desk remains the authority for irreversible sends (Yunzhijia / Agentic Working); the outbound gate only allow/drop/hold — it never auto-posts. Daily **preference RSI** (`pnpm atom preference-rsi`) tunes those gates’ confidence floors and allow/block patterns from Desk accept/reject/merge — it does **not** retrain Laya weights. Morning **gate digest** (`pnpm atom gate-digest`) reads those audits and prints whether the gates earned their keep — it does **not** send, write floors, or retrain. See [`docs/08-lead-agent.md`](docs/08-lead-agent.md).

```bash
pnpm atom run --agent grok-cli
```

### Dispatch Desk

Same daemon, same SQLite. Home is **需要你拍板** (Approve/Reject). **系统已处理** is a read-only 24h gate-digest. **我的偏好** shows `data/preference-memory.json`. **高级** hides the Atoms log placeholder. Lead NL configures sources.

```bash
pnpm atom serve
# open Desk at http://127.0.0.1:8787
```

Light zinc inbox (paper + indigo `#6e7bf2`). Listen → propose → approve → route.

### Cron / webhooks

Serve starts an in-process 15-minute poll (`data/triggers.json` → `poll-yzj-15m`) that runs the same pipeline as `POST /api/run` for `yzj-ai-advance`, plus up to 8 recent Yunzhijia private chats, on **weekdays Asia/Shanghai 08:00–20:00**. Overlap is skipped; one log line per tick (`ok` / `skip` / `fail`). Disable the row or set `ATOM_CRON=0`. Do **not** reinstall LaunchAgents (`com.guoxinshan.atom.serve` / `com.guoxinshan.atom.morning-run`) or login items.

One-shot still:

```bash
curl -sS -X POST http://127.0.0.1:8787/api/run \
  -H 'content-type: application/json' \
  -d '{"source":"yzj-ai-advance"}'
```

Inbound webhooks use `/hooks/run` (same pipeline). CLI `run` uses `/api/run`.

### Yunzhijia source (stub)

Enable in `data/sources.json` or:

```bash
ATOM_YZJ_GROUP_IDS=group1,group2 pnpm atom run --source yzj
```

Wraps `yzj-cli im message list` (ok if untested without groups). That is a **local CLI spawn**, not HTTP — see [Yunzhijia from Docker](#yunzhijia-from-docker) if Desk runs in a container.

Sweep leftover bot-digest / `收到✅` / log-dump suggestions: `pnpm atom reject-noise`.

After deploy, fold **existing** open Needs-you twins that predate the live extract merge gate (one shot; Laya must be up — same `LAYA_URL` / timeout / min confidence as extract):

```bash
pnpm atom serve                 # daemon must be up
pnpm atom merge-sweep           # dry-run: print pairs, write nothing
pnpm atom merge-sweep --apply   # write decision_merged on losers
```

Before a human send (Desk / 干饭人), check outbound content. Same `LAYA_URL` / timeout; fail-open allow if Laya is down. **Does not post to Yunzhijia.**

```bash
pnpm atom outbound-check --title "需求日报" --body "Suggested: Desk OAuth"
pnpm atom outbound-check --path out/digest-2026-09-21.md --kind digest
# POST /api/outbound-check  { title, body, kind }
```

After a few days of Desk triage, tune Laya floors from accept/reject/merge (no weight download). Sparse days no-op; one step per run, clamped to `[0.70, 0.95]`. **Does not send Yunzhijia.**

```bash
pnpm atom preference-rsi           # dry-run: print before/after, write nothing
pnpm atom preference-rsi --apply   # write data/preference-memory.json + preference_rsi audit
# POST /api/preference-rsi  { "apply": true }
```

Next `pnpm atom run` / extract / outbound-check / merge-sweep loads those floors.

Morning measurement of whether those gates earned their keep (read-only; **does not send Yunzhijia**, does not write floors):

```bash
pnpm atom gate-digest              # last 24h markdown (paste into 云之家 / this group)
pnpm atom gate-digest --since 7d
pnpm atom gate-digest --json       # same payload Desk gets
# GET /api/gate-digest?since=24h
# POST /api/gate-digest  { "since": "2026-09-20" }
```

## Docker (Desk)

Desk compose is **manual**. `restart: "no"` so Docker Desktop coming up at login does **not** start ATOM. Laya is a separate container on the Mac (`~/dev/laya-docker`); this repo’s compose does not swallow it.

```bash
docker compose up -d          # build + start Desk on :8787
# open http://127.0.0.1:8787
docker compose logs -f desk   # serve + [cron:poll-yzj-15m] ticks
docker compose down           # stop (data/ and out/ stay on the host)
```

`pnpm atom serve` / `pnpm web` on the host is unchanged (still binds `127.0.0.1` unless you set `ATOM_WEB_HOST`). Host CLI talks to Docker Desk the same way: `ATOM_API_BASE=http://127.0.0.1:8787 pnpm atom …`.

### Host Laya

Compose sets `LAYA_URL=http://host.docker.internal:8790` (Mac Docker Desktop). Keep Laya running on the Mac at `:8790`. `extra_hosts: host.docker.internal:host-gateway` is for Linux Docker Engine; it does **not** put host CLIs on the container PATH.

Override if Laya is elsewhere:

```bash
LAYA_URL=http://host.docker.internal:8790 docker compose up -d
# or LAYA_ENABLED=0 to skip gates
```

### Yunzhijia from Docker

`YzjSource` (`packages/adapters/src/yzj.ts`) does `spawn(yzj-cli, ["im", "message", "list", …])` (and `im group recent` for DMs). Ingest and `poll-yzj-15m` run **inside** the Desk process. Therefore:

| Approach | Works? |
|---|---|
| `LAYA_URL` + `host.docker.internal` | Yes — Laya is HTTP. |
| `extra_hosts` / `network_mode: host` to reuse Mac `yzj-cli` | **No.** This image is Linux. A macOS `yzj-cli` binary will not exec. Mac Keychain / `yzj-cli auth login` is not in the VM. Host networking does not bind-mount host PATH. |
| Bind-mount Mac `yzj-cli` into `/usr/local/bin` | **No** (wrong OS ABI). |
| Linux `yzj-cli` + its login **inside** the container (`ATOM_YZJ_CLI`, bind-mount credential dir if the CLI uses files) | Yes, if you have a Linux build and non-Keychain auth. |
| Host sidecar that runs Mac `yzj-cli` and POSTs messages into Desk | **Not implemented.** Would be a separate Mac process (still not a login item). |

Until a Linux `yzj-cli` (or a host sidecar) exists, live 云之家 ingest from Docker Desk will log `[yzj] list failed` / empty pulls. Fixture source, Desk UI, SQLite (`./data`), digests (`./out`), and Laya fail-open still work. The same ABI/login limit applies to `grok` extract (`GrokCliExtractAgent`); heuristic extract does not need it.

Do **not** set `restart: always` or `unless-stopped` if you want to avoid boot-like autostart.

## Layout

```
apps/cli/          # thin HTTP client (ATOM_API_BASE, default http://127.0.0.1:8787)
apps/web/          # Dispatch Desk (static) + the only local API / core owner
packages/core/     # events writer, projections, agents, registry
packages/adapters/ # fixture + yzj stub
fixtures/          # demo messages.jsonl
data/sources.json  # SourceRegistry config
out/               # digests (gitignored)
Dockerfile         # Desk image (`pnpm serve`)
docker-compose.yml # Desk only (manual up; Laya stays on the host)
docs/              # contracts (see 02-atom-contract, 06-extensibility, 11-single-api)
```

## Contracts

- `candidate_proposed` without refs is **rejected** by the writer.
- Atom types: see `docs/02-atom-contract.md` (incl. Stage-2 `pr_checklist_*` + existing `pr_opened` / `evidence_attached`).

## Docs
- [Operating plan (dogfood)](docs/12-operating-plan.md) — daily rhythm, accept boundary, group/noise
