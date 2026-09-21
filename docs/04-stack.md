# 04 · Stack (week 1)

| Concern | Choice |
|---|---|
| Language | TypeScript, Node 22 |
| Package manager | pnpm |
| Run | `tsx` |
| DB | SQLite (`better-sqlite3` or `libsql`) |
| Schedule | in-process interval on `pnpm serve` (`data/triggers.json`) |
| LLM | OpenAI-compatible API + Zod structured output |
| Digest | Markdown files under `./out/` |
| Layout | `ingest/` `extract/` `approve/` `export/` |

## Deferred

- Slack Bolt adapter
- Next.js / Hono UI
- Paddle / Lemon Squeezy (MoR) for overseas billing
- Postgres, Redis, K8s
- Dify / n8n as core runtime (fine as optional glue later, not the source of truth)
- Self-hosted vector DB (keyword + refs first)

## Repo layout (when code starts)

```
apps/cli/
packages/core/     # atom writer, projections, schemas
packages/adapters/ # yzj, later slack
docs/              # contracts (this tree)
out/               # local digests (gitignored)
data/              # sqlite (gitignored)
```

## Triggers (beyond week-1 cron)

Manual + in-process cron first; webhook / IM hook / fs watch share one Trigger interface — see `docs/06-extensibility.md`.
