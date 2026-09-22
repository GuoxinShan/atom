# 06 · Extensibility

## Dynamic sources

Sources are **not** a fixed enum baked into the binary. Each user configures different adapters (groups, repos, inboxes).

- Runtime loads `SourceConfig[]` from a registry (`data/sources.json` or SQLite).
- `SourceAdapter` instances are constructed from `{ type, id, params }`.
- An **agent** (local Grok) may add/edit/disable configs conversationally — humans confirm before outbound side effects.
- Built-in types to start: `fixture`, `yzj`. New types register via plugin/module map.

## Multi-modal triggers

Pipelines are started by **triggers**, not only a daily cron.

| kind | examples |
|---|---|
| `manual` | `atom run`, UI button |
| `cron` | in-process interval on `pnpm serve` (`data/triggers.json`) |
| `webhook` | HTTP callback from GitHub, Stripe, custom |
| `hook` | local git hook, file watcher |
| `im_event` | new Yunzhijia/Slack message matching filter |
| `fs_watch` | new file in a drop folder |

Irregular timing is first-class. The runner is: `Trigger → select pipeline (ingest|extract|run) → SourceRegistry + ExtractAgent → append atoms`.

Stage1 ships `manual` + in-process `cron` (weekday 15m poll) + webhook config stubs; other kinds land behind the same interface.

## UI

Frontend is designed separately (`docs/07-ui-prototype.md`). No placeholder web UI in Stage1 CLI.


## Event loop (agents emit)

Extract and execute agents **emit atoms** when they finish (and optionally when they start/fail). Those atoms are part of the same append-only feed and may wake other triggers (`atom_event` kind: filter on `type` / `subject`).

Suggested atom types (stubs ok in Stage1):

| type | when |
|---|---|
| `agent_started` | agent begins a run |
| `agent_completed` | agent finishes successfully |
| `agent_failed` | agent errors |

Together with domain atoms (`candidate_proposed`, …), this keeps the whole product one loop: **wake → work → emit → wake**.


## Outbound subscriptions

The atom feed is also an **integration bus**. Other systems can subscribe:

| mode | behavior |
|---|---|
| **Pull API** | `GET /atoms?since=cursor&type=` (Stage later) — consumers poll / stream |
| **Outbound webhook** | On each append (optionally filtered by `type`), POST atom payload to registered URLs |

Config stub: `data/subscriptions.json` → `{ id, url, secret, types[], enabled }`.

Runtime seam: `SubscriptionSink.onAtom(atom)` fan-out after successful write (best-effort; failures emit `agent_failed` or a dedicated `delivery_failed` atom later).

Inbound webhooks (triggers) and outbound webhooks (subscriptions) are **different directions** of the same event-loop product.

## Handoff / coding seam

After `decision_accepted` → `spec_drafted` (draft only). Human review (`spec_approved` / `spec_returned`) then explicit 派给 Lead:

```bash
pnpm atom specs
pnpm atom spec-approve <specOrCandidateId>
pnpm atom spec-return <specOrCandidateId> --note "收紧标准"
pnpm atom handoff <specOrCandidateId>          # write out/handoffs/*.md + handoff_exported
pnpm atom handoff <id> --run                   # also spawn local grok -p on the pack
pnpm atom evidence <handoffId> --path ./note.md
pnpm atom checklist <handoffOrCandidateId>     # pr_checklist_started + status
pnpm atom checklist-done <id> tests_green
pnpm atom checklist-done <id> human_gate_ack --ack
pnpm atom pr-open <id> --url <prUrl>           # pr_opened only after checklist_passed
```

`GrokCliCodingAgent` is the default coding seam (CLI agent, not raw HTTP). Cursor can open the same markdown pack.

## Outbound subscriptions (pluggable)

`data/subscriptions.json` — same freedom as agent providers:

| kind | behavior |
|---|---|
| `webhook` / `http-json` | POST JSON envelope |
| `cli` | spawn local binary, JSON on stdin |
| `file` | append JSONL |
| `log` | stdout |
| `noop` | discard |

Filter by `types` (`*` or atom/pipeline kinds). Lead: `订阅加 https://…` / `订阅cli …` / `订阅文件 jsonl`.

## Inbound hooks

Control UI server:

```bash
curl -X POST http://127.0.0.1:8787/hooks/run -H 'content-type: application/json' -d '{"source":"yzj"}'
```

Runs ingest → heuristic seed-gate → configured extract provider → digest. Extract/coding providers come from `data/agents.json`.
