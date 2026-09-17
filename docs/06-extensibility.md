# 06 · Extensibility

Stage-1 is **CLI + Markdown digest**. A UI prototype is designed **outside** this repo until that pass lands. Do not treat Fixture or Yunzhijia as a closed adapter set.

## SourceRegistry

Runtime configs live in **`data/sources.json`** (gitignored). First run copies the seed at `config/sources.json`.

Each row is a `SourceConfig`:

| Field | Role |
|---|---|
| `id` | Stable adapter instance id (cursor key, ingest `source_adapter_id`) |
| `type` | Factory key — **open string**, not an enum of fixture/yzj |
| `enabled` | Ingested on `pnpm atom run` unless `ATOM_SOURCE=<id>` selects one |
| `groupIds` | Chat/group ids (Yunzhijia: **from config**, not env-only) |
| `credentialRef` | Pointer into a secret store (`keychain:…`, `env:…`). Never put tokens here |
| `cursor` | Optional seed; live cursors stay in SQLite `cursors` |
| `settings` | Type-specific (`path`, `bin`, …) |

Later a Grok (or other) agent should **add/edit these rows** via `upsertSourceConfig` — same seam as the CLI.

```bash
pnpm atom sources list
pnpm atom sources add --id yzj-work --type yzj --group-id <gid> --credential-ref keychain:yzj-cli
```

Unknown `type` values are stored. Ingest **skips** them until someone calls `registerSourceType(type, factory)` in `packages/adapters` (or a future plugin). That is the extension point.

SQLite table `source_configs` is **not** used in Stage-1 (avoid a second writable copy). JSON is the config store; `events` remains the atom feed.

## Triggers

Triggers are **multi-modal**. Runtime file: **`data/triggers.json`** (seed `config/triggers.json`). Missing seed ids are appended on load; existing rows are never overwritten.

| kind | Stage-1 | Later |
|---|---|---|
| `manual` | **bound** — `pnpm atom run` / ingest / extract | — |
| `atom_event` | **observe** after append; `auto` dispatch if not human-gated | same runner |
| `cron` | stub row (`config.expr`) | launchd / cron calls the same `executeTrigger` |
| `webhook` | stub row (`config.path`) | tiny HTTP receiver, same runner — **not shipped here** |
| `hook` | stub (`config.on=atom` same filter as atom_event) | git / agent hook |
| `im_event` | stub (`config.sourceId`) | yzj-cli / IM push |
| `fs_watch` | stub | watch a drop folder |

## Event loop

```
Trigger → Agent → emit Atom (`events`) → atom_event Trigger → Agent → …
```

Extract (and later Execute) emit `agent_started` / `agent_completed` / `agent_failed` plus domain atoms (`candidate_proposed`, later `handoff_exported`, `evidence_attached`). Matching `atom_event` rows observe the next stage; `config.auto=true` dispatches the same runner. **Approve is never skipped:** pipeline `approve` | `spec` | `handoff` throw `HumanGateError` if auto-chained; `candidate_proposed` waits for `decision_accepted`.

```bash
pnpm atom triggers list
```

`executeTrigger(pipeline, config)` is the single dispatch. Bound kinds: `manual`, `atom_event`, `hook` with `config.on=atom`. Cron / webhook / im_event / fs_watch throw “not bound in Stage-1” if invoked.

## Outbound subscriptions

Atoms are not only an internal loop — other systems can **subscribe**. Stage-1 ships the registry + fan-out seam, not a production HTTP stack.

```
Trigger → Agent → emit Atom (`events`)
                    ├─ atom_event Trigger (internal loop)
                    └─ SubscriptionSink.onAtom(atom)  → outbound webhooks / later pull
```

```ts
interface SubscriptionSink {
  id: string
  publish(event: { topic: string; payload: unknown }): Promise<void>
  onAtom(atom: Atom): Promise<void>
}
```

After each append, the pipeline calls `onAtom`. `LogSubscriptionSink` fans out to **`data/subscriptions.json`** (seed `config/subscriptions.json`). Missing seed ids are appended on load.

| Field | Role |
|---|---|
| `id` | Stable subscription id |
| `enabled` | Stage-1: when on, **log a stub line** (`[atom:sub] stub webhook …`). No `fetch` / POST |
| `url` | Later POST target |
| `secret` | Later HMAC (keep empty in git; runtime file is gitignored) |
| `types` | Type filter (`[]` / omit = all). e.g. `candidate_proposed`, `decision_accepted` |

```bash
pnpm atom subscriptions list
```

### 1) Pull API (later)

Consumers list/stream atoms since a cursor, optionally filtered by type. Core seam (no HTTP server in Stage-1):

```ts
store.listSince(cursor, { types?: AtomType[], limit?: number })
// → { atoms, nextCursor }
```

Later: `GET /atoms?since=<id>&type=candidate_proposed` wrapping the same method.

### 2) Outbound webhooks

On append, matching enabled rows would POST the atom JSON to `url` (signed with `secret`). Stage-1 **does not POST**. Enable a row only to see the stub log. Inbound Trigger `kind=webhook` is a different seam (wake a pipeline) and also has no HTTP server here.

Outbound hooks are **projections of the feed**, not a second demand store. They must not auto-accept candidates.

## SourceAdapter factories

```ts
registerSourceType("slack", (config, ctx) => new SlackSource(config))
```

Shipped factories: `fixture`, `yzj`. Adding Slack later is a new factory + a registry row — not a core fork.

## Extract

| Agent | When |
|---|---|
| `GrokCliExtractAgent` | `ATOM_EXTRACT_AGENT=grok` — spawns local `grok -p --always-approve --max-turns N --json-schema … --prompt-file …` |
| `HeuristicExtractAgent` | default / offline fallback; ≥1 ref per candidate |

Do not ship OpenAI-compatible HTTP chat as the primary extract path.

## Not in Stage-1

- Web UI / Next / kanban (separate design pass)
- Inbound webhook server / cron daemon (TriggerRegistry stubs only)
- Outbound HTTP POST / HMAC (SubscriptionRegistry stubs only — `onAtom` logs)
- ICP, billing, Slack Bolt (adapter type only, when written)
- Employer proprietary schemas
