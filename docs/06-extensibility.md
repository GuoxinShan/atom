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
- Webhook server, ICP, billing, Slack Bolt (adapter type only, when written)
- Employer proprietary schemas
