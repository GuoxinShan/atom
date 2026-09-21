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
2. **Extract → duplicate merge gate** — after the noise filter, `POST /v1/predict` again with the new candidate plus a short list of recent open Needs-you / suggested items. Auto-merge only when `same_request` ≥ **0.90** (preference-memory merge floor, minimum 0.90) **and** the candidate title/topic is not far from the target card. High-confidence `merge` then folds the duplicate into that existing item (`decision_merged` on the loser; survivor stays suggested). Far-apart titles (e.g. 速记 vs 日程 MCP) force `new` even if `same_request` is high. Ambiguous, timeout, or Laya down → fail-open and create a new suggested ticket. Desk remains the accept/reject gate. **Does not change merge thresholds.**
3. **Extract → theme/project tags** — after a candidate is kept as suggested (not noise, not auto-merged), `POST /v1/predict` with typed `theme` / `project` choice heads whose criteria are the **closed Chinese vocabulary** in [`data/theme-vocabulary.json`](../data/theme-vocabulary.json) (product-editable). Persist allowlist titles on `candidate_proposed` (`theme` / `project` and `tags.*`, plus `laya_tags` audit) so Desk `GET /api/candidates` → `groups` prefers them over the workspace+title heuristic. Laya must pick from that list (「AI推进」「日程/会议」「发布与发布流程」…); English kebab slugs (`release-process`, `product-bug`, Schedule Mcp) map onto the nearest allowlist entry when the mapping is unique, otherwise **「其他」**. Timeout, 5xx, or Laya down → **fail-open**: keep the candidate as-is (Grok tags if any; otherwise untagged heuristic grouping). Empty/garbage answers still keep the card and group under 「其他」. Never blocks extract. Display grouping only — not a merge. **Does not change merge thresholds.**
4. **Needs-you duplicate backfill** — one-shot `pnpm atom merge-sweep` (dry-run default; `--apply` writes). Re-runs the same Laya merge interpretation across **existing** open suggested items (twins created before the live gate). Same write as extract: `decision_merged` on the loser, refs on the survivor, `laya_merge` audit. Never merges into rejected/accepted/closed. Idempotent. One timeout fail-opens that pair without poisoning later compares.
5. **Outbound / pre-post gate** — before subscription emit (`runPipeline` → `sink.publish` of the digest ping) and before Desk/CLI would post, `POST /v1/predict` with the same noul heads as the extract noise gate (`is_chat_noise` / `is_work_demand`) plus allow|drop|hold. High-confidence noise → **drop** (skip auto-emit). High-confidence hold → **hold** (skip auto-emit; Desk confirms). Ambiguous, timeout, or Laya down → **fail-open allow**. Audit field `laya_outbound` on `agent_completed` (`kind=outbound-check`). **Never auto-sends to Yunzhijia** — Desk remains the irreversible-send authority. Desk/干饭人: `pnpm atom outbound-check` or `POST /api/outbound-check` `{ title, body, kind }` (returns the gate; does not deliver).
6. **Preference RSI (daily / on-demand)** — reads Desk `decision_accepted` / `decision_rejected` / `decision_merged` (and outbound-check counts) from the event store. Enough feedback (≥5 decisions) moves noise / merge / outbound floors by **0.02**, clamped to `[0.70, 0.95]` for noise/outbound and **`[0.90, 0.95]` for merge**; sparse feedback is a no-op. May add conservative allow/block title stems. Persists `data/preference-memory.json` (and sqlite meta) on `--apply`; Laya gate callers load it on the next run. Dry-run default. Audit atom `preference_rsi` (before/after + sample counts). **Does not retrain Laya.** Desk/干饭人: `pnpm atom preference-rsi` then `--apply`, or `POST /api/preference-rsi` `{ apply: true }`.
7. **Gate acceptance digest (morning / on-demand)** — read-only windowed summary (default last 24h, `--since 24h|7d|YYYY-MM-DD|ISO`) of extract proposed / noise_dropped / fail_open, merge merged / open / fail_open, outbound allow / drop / hold / fail_open, Desk accepted / rejected / suggested, current preference floors + last RSI apply delta, and two honest proxies: `auto_rate = (noise_dropped + merged) / (those + proposed_to_desk)` and `override_rate` = Desk rejects of fail_open (auto-passed) items when the propose carries `laya_gate` / `laya_merge` audit — otherwise **n/a**, never invented. Markdown for 云之家 paste; JSON for Desk. **Does not send Yunzhijia, does not write thresholds, does not retrain Laya.** Desk/干饭人: `pnpm atom gate-digest` after a real `run`, or `GET`/`POST /api/gate-digest`.
8. **Lead handoff → model route** — before coding handoff, `POST /v1/route-model` with the task summary. `ornith` = heavier, `bonsai` = lighter; recorded on `handoff_exported` as `laya_model_route`. No intensity-split coding providers yet, so handoff is unchanged.

`LAYA_ENABLED=0` disables. Default `LAYA_TIMEOUT_MS=10000` (Mac CPU Laya + open-list `/v1/predict`; 1.5s was too tight and aborted merge after a successful noise gate). A single timeout fail-opens that candidate (`reason=timeout`) and keeps later gates; connection refused / repeated 5xx / `/health` down mark Laya unavailable (`reason=unavailable`). Outage never blocks the pipeline. CI does not need `:8790`.
