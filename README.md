# ATOM

> Append-only Timeline Of Matters · 事元

Machines propose. Humans decide. Every claim points at evidence.

## Quickstart

```bash
pnpm install
pnpm atom run
pnpm atom candidates
pnpm atom ui          # kanban at http://127.0.0.1:3333
```

Default path: **FixtureSource** + **HeuristicExtractAgent** (offline).  
Writes atoms into SQLite table `events`, Markdown 需求日报 into `out/`, and a local kanban projection of candidates.

```bash
pnpm atom approve <id>
pnpm atom reject <id>
```

## Env

| Variable | Default | Meaning |
|---|---|---|
| `ATOM_SOURCE` | `fixture` | `fixture` \| `yzj` |
| `ATOM_EXTRACT_AGENT` | `heuristic` | `heuristic` \| `grok` |
| `ATOM_GROK_BIN` | `grok` | Grok Build Agent CLI |
| `ATOM_GROK_MODEL` | — | passed as `-m` |
| `ATOM_GROK_MAX_TURNS` | `8` | `--max-turns` |
| `ATOM_UI_PORT` | `3333` | kanban |

Grok extract spawns the local CLI (not OpenAI/xAI HTTP chat completions):

```text
grok -p --always-approve --max-turns N --json-schema <file> --prompt-file <file>
```

## Layout

```
apps/cli/          # pnpm atom …
apps/web/          # local Hono kanban (charcoal / copper)
packages/core/     # SourceAdapter, ExtractAgent, Zod, events writer, projections
packages/adapters/ # Fixture, Yzj (yzj-cli), Heuristic, GrokCliExtractAgent
fixtures/messages.jsonl
config/sources.json
data/  out/        # gitignored
```

## Docs

| Doc | What it is |
|---|---|
| [00-vision](docs/00-vision.md) | Why this exists and what we refuse to be |
| [01-architecture](docs/01-architecture.md) | Layers, single source of truth, projections |
| [02-atom-contract](docs/02-atom-contract.md) | Core contract for the ATOM feed |
| [03-stages](docs/03-stages.md) | Stage doors and human gates |
| [04-stack](docs/04-stack.md) | Week-1 tech stack |
| [05-non-goals](docs/05-non-goals.md) | Explicit non-goals and competitor stance |

## Naming

| Thing | Name |
|---|---|
| **Product** | **ATOM** (*Append-only Timeline Of Matters* / 事元) |
| Unit of change | atom (one append-only record) |
| Persistence table | `events` (implementation detail — **not** the product name) |
