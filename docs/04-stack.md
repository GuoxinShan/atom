# 04 · Stack (week 1)

| Concern | Choice |
|---|---|
| Language | TypeScript, Node 22 |
| Package manager | pnpm |
| Run | `tsx` |
| DB | SQLite via Node 22 `node:sqlite` (table `events`) |
| Schedule | TriggerRegistry (`manual` now; cron/webhook/IM later via same runner) |
| LLM | Grok Build Agent CLI (`grok -p` + `--json-schema`) + Zod; HeuristicExtractAgent offline fallback |
| Digest | Markdown files under `./out/` |
| Config | `data/sources.json` SourceRegistry; `data/triggers.json` TriggerRegistry; `data/subscriptions.json` SubscriptionRegistry |
| Layout | `apps/cli` `packages/core` `packages/adapters` |

## Deferred

- Web UI / kanban (separate design/prototype pass — Stage-1 is CLI + Markdown)
- Cron daemon / HTTP webhook receiver / IM hook bindings (same `executeTrigger`; registry stubs only)
- Outbound webhook POST / HMAC / pull HTTP API (`SubscriptionSink.onAtom` + `listSince` stubs only)
- Slack Bolt adapter (new `registerSourceType`, not a core enum)
- Next.js SaaS / ICP / hosted multi-tenant UI
- Paddle / Lemon Squeezy (MoR) for overseas billing
- Postgres, Redis, K8s
- Dify / n8n as core runtime (fine as optional glue later, not the source of truth)
- Self-hosted vector DB (keyword + refs first)

## Repo layout (when code starts)

```
apps/cli/
packages/core/     # atom writer, projections, SourceRegistry, TriggerRegistry
packages/adapters/ # source factories, heuristic, grok CLI
docs/              # contracts (this tree)
out/               # local digests (gitignored)
data/              # sqlite + sources.json + triggers.json + subscriptions.json (gitignored)
```
