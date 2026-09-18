# 03 · Stages and gates

## Stage map

```
[ingest] → [extract] → suggested candidates
                              ↓ human
                    accept | reject | merge
                              ↓
                         [spec_drafted]
                              ↓ human (optional tighten)
                         [handoff_exported]
                              ↓ external coding agent
                         [evidence_attached]
                              ↓
                         [pr_checklist_started]
                              ↓ item_done × required
                         [pr_checklist_passed]  ← human_gate_ack is explicit CLI --ack (never auto)
                              ↓
                         [pr_opened] → merge/release (human)
```

## Human gates (v0)

| Gate | Who | Default |
|---|---|---|
| Demand accept/reject/merge | owner | **required** |
| Spec “good enough to hand off” | owner | required before handoff |
| Outbound digest / chat post | owner | **required** |
| PR checklist (`human_gate_ack`) | owner | **required** (`--ack`; never auto) |
| Merge PR / release | owner | **required** |

Autonomous daily job may only: ingest, propose, write local Markdown digest **as projection**.

## Stage 1 MVP (this month)

- One SourceAdapter (Yunzhijia CLI wrapper)
- Daily pull → atoms
- Propose candidates with refs
- Local Markdown 需求日报
- CLI approve/reject/merge writing decision atoms

**Out of stage 1:** multi-agent orchestration, auto Jira/Linear, auto PR, vector DB, web SaaS billing.

## Stage 2 bridge (checklist, not auto-merge)

After evidence, start a hardcoded v0 checklist (`tests_green`, `evidence_linked`, `summary_written`, `human_gate_ack`) then `pr_opened`. This is a human-gated land step — ATOM does **not** auto-merge PRs.

```bash
pnpm atom checklist <handoffOrCandidateId>
pnpm atom checklist-done <id> tests_green
pnpm atom checklist-done <id> evidence_linked
pnpm atom checklist-done <id> summary_written --note "…"
pnpm atom checklist-done <id> human_gate_ack --ack
pnpm atom pr-open <id> --url https://github.com/org/repo/pull/1 [--branch feat/…]
```

`pr-open` refuses unless `pr_checklist_passed` exists (override with `--force` + warning).

## Stage 2+

Only after two weeks of real daily use of stage 1. Checklist is the first Stage-2 seam; still no coding agent loop and no auto-merge.
