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
                              ↓ human
                         [pr_opened] → merge/release (human)
```

## Human gates (v0)

| Gate | Who | Default |
|---|---|---|
| Demand accept/reject/merge | owner | **required** |
| Spec “good enough to hand off” | owner | required before handoff |
| Outbound digest / chat post | owner | **required** |
| Merge PR / release | owner | **required** |

Autonomous daily job may only: ingest, propose, write local Markdown digest **as projection**.

## Stage 1 MVP (this month)

- One SourceAdapter (Yunzhijia CLI wrapper)
- Daily pull → atoms
- Propose candidates with refs
- Local Markdown 需求日报
- CLI approve/reject/merge writing decision atoms

**Out of stage 1:** multi-agent orchestration, auto Jira/Linear, auto PR, vector DB, web SaaS billing.

## Stage 2+

Only after two weeks of real daily use of stage 1.
