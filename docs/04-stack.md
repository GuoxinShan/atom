# 04 · Stack (week 1)

| Concern | Choice |
|---|---|
| Language | TypeScript, Node 22 |
| Package manager | pnpm |
| Run | `tsx` |
| DB | SQLite via Node 22 `node:sqlite` (table `events`) |
| Schedule | local `cron` / `launchd` |
| LLM | Grok Build Agent CLI (`grok -p` + `--json-schema`) + Zod; HeuristicExtractAgent offline fallback |
| Digest | Markdown files under `./out/` |
| Local UI | Hono kanban (charcoal / copper) reading SQLite projections |
| Layout | `apps/cli` `apps/web` `packages/core` `packages/adapters` |

## Deferred

- Slack Bolt adapter
- Next.js SaaS / ICP / hosted multi-tenant UI
- Paddle / Lemon Squeezy (MoR) for overseas billing
- Postgres, Redis, K8s
- Dify / n8n as core runtime (fine as optional glue later, not the source of truth)
- Self-hosted vector DB (keyword + refs first)

## Repo layout (when code starts)

```
apps/cli/
apps/web/          # local kanban projection
packages/core/     # atom writer, projections, schemas
packages/adapters/ # fixture, yzj-cli, heuristic, grok CLI
docs/              # contracts (this tree)
out/               # local digests (gitignored)
data/              # sqlite (gitignored)
```
