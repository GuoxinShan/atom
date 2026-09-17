# ATOM

> Append-only Timeline Of Matters · 事元

Machines propose. Humans decide. Every claim points at evidence.

## Quickstart

```bash
pnpm install
pnpm atom run
pnpm atom candidates
pnpm atom sources list
pnpm atom triggers list
pnpm atom subscriptions list
```

Default path: **enabled SourceRegistry rows** (seed includes Fixture) + **HeuristicExtractAgent** (offline).  
Writes atoms into SQLite table `events` and Markdown 需求日报 into `out/`. Stage-1 is **CLI only** — UI is a separate prototype.

```bash
pnpm atom approve <id>
pnpm atom reject <id>
pnpm atom sources add --id yzj-work --type yzj --group-id <gid>
```

## Env

| Variable | Default | Meaning |
|---|---|---|
| `ATOM_SOURCE` | (all enabled) | Source **config id** to run |
| `ATOM_EXTRACT_AGENT` | `heuristic` | `heuristic` \| `grok` |
| `ATOM_GROK_BIN` | `grok` | Grok Build Agent CLI |
| `ATOM_GROK_MODEL` | — | passed as `-m` |
| `ATOM_GROK_MAX_TURNS` | `8` | `--max-turns` |
| `ATOM_SOURCE_REGISTRY` | `data/sources.json` | runtime SourceRegistry |
| `ATOM_TRIGGER_REGISTRY` | `data/triggers.json` | runtime TriggerRegistry |
| `ATOM_SUBSCRIPTION_REGISTRY` | `data/subscriptions.json` | runtime SubscriptionRegistry |

Grok extract spawns the local CLI (not OpenAI/xAI HTTP chat completions):

```text
grok -p --always-approve --max-turns N --json-schema <file> --prompt-file <file>
```

Sources are **not** a closed Fixture/Yzj set. ATOM is an **event loop** (Trigger → Agent → Atom → Trigger); other systems **subscribe** outbound. See [docs/06-extensibility.md](docs/06-extensibility.md).

## Layout

```
apps/cli/          # pnpm atom …
packages/core/     # SourceRegistry, SourceAdapter, ExtractAgent, events writer
packages/adapters/ # factories: fixture, yzj; Heuristic + GrokCliExtractAgent
fixtures/messages.jsonl
config/sources.json         # seed copied to data/sources.json
config/triggers.json        # seed copied to data/triggers.json
config/subscriptions.json   # seed copied to data/subscriptions.json
data/  out/            # gitignored
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
| [06-extensibility](docs/06-extensibility.md) | SourceRegistry, TriggerRegistry, outbound subscriptions, Grok extract |

## Naming

| Thing | Name |
|---|---|
| **Product** | **ATOM** (*Append-only Timeline Of Matters* / 事元) |
| Unit of change | atom (one append-only record) |
| Persistence table | `events` (implementation detail — **not** the product name) |
