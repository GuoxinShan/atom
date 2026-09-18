# ATOM

Append-only **demand feed** with mandatory citations. Machines propose. Humans decide.

Domain unit: **atom**. SQL table: **`events`** (never `atoms`).

Stage-1 MVP: CLI + Markdown 需求日报 + optional local kanban. No Next.js product app.

## Quickstart

```bash
cd /Users/kingdee/dev/personal/atom   # or this repo root
pnpm install
pnpm atom run          # FixtureSource + HeuristicExtractAgent
pnpm atom candidates   # list suggested candidates with refs
```

Digest lands in `out/digest-YYYY-MM-DD.md`. SQLite at `data/atom.sqlite`.

### Commands

| Command | What it does |
|---|---|
| `pnpm atom run` | ingest → extract → digest |
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

```bash
pnpm atom run --agent grok-cli
```

### Kanban (optional)

Same SQLite. Approve/reject append decision atoms.

```bash
pnpm web
# open http://127.0.0.1:8787
```

Dark editorial UI (charcoal + copper): Suggested / Accepted / Rejected.

### Yunzhijia source (stub)

Enable in `data/sources.json` or:

```bash
ATOM_YZJ_GROUP_IDS=group1,group2 pnpm atom run --source yzj
```

Wraps `yzj-cli im message list` (ok if untested without groups).

Sweep leftover bot-digest / `收到✅` / log-dump suggestions: `pnpm atom reject-noise`.

## Layout

```
apps/cli/          # tsx CLI
apps/web/          # tiny local kanban + API
packages/core/     # events writer, projections, agents, registry
packages/adapters/ # fixture + yzj stub
fixtures/          # demo messages.jsonl
data/sources.json  # SourceRegistry config
out/               # digests (gitignored)
docs/              # contracts (see 02-atom-contract, 06-extensibility)
```

## Contracts

- `candidate_proposed` without refs is **rejected** by the writer.
- Atom types: see `docs/02-atom-contract.md` (incl. Stage-2 `pr_checklist_*` + existing `pr_opened` / `evidence_attached`).
