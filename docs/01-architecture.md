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

Triggers are **multi-modal**, not cron-only. Every entry is a `TriggerConfig` in `data/triggers.json` (seed: `config/triggers.json`) and binds to the same runner:

```ts
type TriggerKind = "manual" | "cron" | "webhook" | "hook" | "im_event" | "fs_watch" | "atom_event"
type TriggerPipeline = "ingest" | "extract" | "run" | "digest" | "approve" | "spec" | "handoff"
interface TriggerConfig {
  id: string
  kind: TriggerKind
  enabled: boolean
  pipeline: TriggerPipeline
  config: Record<string, unknown>
}
```

Stage-1 binds **`manual`** (`pnpm atom run`) and observes **`atom_event`** (and `hook` with `config.on=atom`) after each append. `config.auto=true` may dispatch; **approve / spec / handoff never auto-run**. Cron, HTTP webhook, yzj/IM hooks, git hooks, and fs watchers stay in the registry as stubs until a receiver is written. Do not stand up a webhook server in Stage-1.

## Event loop

ATOM is a **giant event loop**. Agents are not fire-and-forget side effects.

```
Trigger → Agent → emit Atom into `events` → (optional) atom_event Trigger → Agent → …
```

- Triggers wake a pipeline (`ingest` | `extract` | `run` | …).
- ExtractAgent / later ExecuteAgent **append atoms** on progress and completion (`candidate_proposed`, `handoff_exported`, `evidence_attached`, `agent_started` / `agent_completed` / `agent_failed`).
- `kind=atom_event` (or `hook` with `config.on=atom`) filters on `config.type` / `config.types` (+ optional `subject_id`). Set `config.auto=true` to dispatch; default is observe-only.
- **Human gates:** `approve`, `spec`, and `handoff` never auto-run. A trigger on `candidate_proposed` cannot skip `decision_accepted`.
- **Outbound:** other systems subscribe via `SubscriptionSink.onAtom` (webhook stub / later pull API). See [06-extensibility](06-extensibility.md#outbound-subscriptions).

See [06-extensibility](06-extensibility.md).

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
