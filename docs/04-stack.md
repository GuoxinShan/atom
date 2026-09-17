# 04 · Stack (week 1)

| Concern | Choice |
|---|---|
| Language | TypeScript, Node 22 |
| Package manager | pnpm |
| Run | `tsx` |
| DB | SQLite (`better-sqlite3` or `libsql`) |
| Schedule | local `cron` / `launchd` |
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
packages/core/     # event writer, projections, schemas
packages/adapters/ # yzj, later slack
docs/              # contracts (this tree)
out/               # local digests (gitignored)
data/              # sqlite (gitignored)
```
