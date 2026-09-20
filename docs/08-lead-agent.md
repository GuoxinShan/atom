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

## Routing haystack (week-1)

`LeadAgent.routeSpec` scores **title + acceptance criteria** only.

- Never score raw ref tokens (`yzj:im:…`) or ref digests.
- Generic tooling words (`云之家`, `yzj-cli`, `CLI`, `grok`, `token`, `key`, `本机`, `单机`, `分发`) do not steal workspace `yzj` unless the **title** is a yzj product ask (`1023` / `日历` / `灵基chat开发` / `schedule/mcp`).
- Unsure → personal `atom`. Lead will not guess company paths.

Fixture: `fixtures/lead-routing.json`. Check: `pnpm check:lead-routing`.

## Extract reminder

Heuristic = seed gate only. Agentic Grok CLI = extract. Group scope from `data/sources.json`.

## Laya (optional System 1 gates)

ATOM calls Laya HTTP (`LAYA_URL`, default `http://127.0.0.1:8790`) for typed decisions only — never text generation.

1. **Extract → candidate gate** — after extract proposals, `POST /v1/predict`. High-confidence chat/noise is dropped (same path as `agents/noise.ts`); high-confidence demand stays `suggested`. Ambiguous or Laya down → fail-open to suggested (never auto-approve).
2. **Extract → duplicate merge gate** — after the noise filter, `POST /v1/predict` again with the new candidate plus a short list of recent open Needs-you / suggested items. High-confidence `merge` folds the duplicate into that existing item (`decision_merged` on the loser; survivor stays suggested). Ambiguous, timeout, or Laya down → fail-open and create a new suggested ticket. Desk remains the accept/reject gate.
3. **Lead handoff → model route** — before coding handoff, `POST /v1/route-model` with the task summary. `ornith` = heavier, `bonsai` = lighter; recorded on `handoff_exported` as `laya_model_route`. No intensity-split coding providers yet, so handoff is unchanged.

`LAYA_ENABLED=0` disables. Timeouts ~1–2s; outage never blocks the pipeline. CI does not need `:8790`.
