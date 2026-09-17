# 01 · Architecture

## Layers

```
ingest/    → pull incremental messages from a SourceAdapter
extract/   → noise filter + LLM propose candidates (structured)
approve/   → human decisions (CLI or later UI)
export/    → Markdown digest / later Slack projection / handoff packs
```

Runtime truth lives in **SQLite**. Markdown and chat posts are **projections**, never a second writable state machine.

## Source of truth

| Data | Authority | Projection |
|---|---|---|
| Messages, candidates, decisions, specs, evidence | SQLite `events` feed (ATOM product) + derived views | — |
| Daily digest Markdown | — | export from atoms |
| Outbound chat digests | — | export after human confirm |
| Issues / PR text for coding agents | — | export after accept |

**No dual-write.** If a projection is edited by hand, either ignore it or re-ingest as a new event — never silently become truth.

## Adapters

```ts
interface SourceAdapter {
  id: string
  pullSince(cursor: string | null): Promise<{ messages: RawMessage[]; nextCursor: string }>
}
```

Week 1: Yunzhijia wrapper around existing local CLI, **instantiated from SourceRegistry** (`data/sources.json`). Group ids live on the config row.  
Types are open: `registerSourceType` adds adapters (later Slack, etc.) without changing ingest.  
See [06-extensibility](06-extensibility.md).

## Triggers

Triggers are **multi-modal**, not cron-only. Every entry is a `TriggerConfig` in `data/triggers.json` (seed: `config/triggers.json`) and binds to the same runner (`ingest` | `extract` | `run`):

```ts
type TriggerKind = "manual" | "cron" | "webhook" | "hook" | "im_event" | "fs_watch"
interface TriggerConfig {
  id: string
  kind: TriggerKind
  enabled: boolean
  pipeline: "ingest" | "extract" | "run"
  config: Record<string, unknown>
}
```

Stage-1 binds **`manual`** (`pnpm atom run`). Cron, HTTP webhook, yzj/IM hooks, git hooks, and fs watchers stay in the registry as stubs until a receiver is written. Do not stand up a webhook server in Stage-1.

## Separation (non-negotiable)

| Plane | May do | Must not do |
|---|---|---|
| ingest | store messages | invent requirements |
| extract | propose candidates with refs | mark accepted |
| approve | accept / reject / merge | call outbound send without confirm |
| execute (later) | hand off to external coding agents | become a second demand store |

## Inspired discipline (abstracted)

Patterns borrowed at the *discipline* level only (not a product fork):

- human-present vs human-absent gates
- suggested draft before commit
- mandatory refs / bounded fetch of evidence
- append-only feed under the ATOM product（事元）
- confirm before any outbound side effect
