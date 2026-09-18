# 08 · Lead agent (主调度)

## Role

The **LeadAgent** is the only orchestrator that may assign coding work.

It must:

1. Know the user (`data/user-context.md`)
2. Know machines + workspaces (`data/workspaces.json`)
3. Route each `spec_drafted` / handoff to **one** workspace path
4. Brief the coding agent with that route — never blind-dispatch

## Non-goals

- Fan-out the same task to every repo
- Guess a path that is not in `workspaces.json`
- Send Yunzhijia messages without confirm

## CLI

```bash
pnpm atom route <specOrCandidateId>
pnpm atom handoff <id>          # lead routes, writes pack with briefing
pnpm atom handoff <id> --run    # coding agent cwd = routed workspace
```

## Extract reminder

Heuristic = seed gate only. Agentic Grok CLI = extract. Group scope from `data/sources.json`.
