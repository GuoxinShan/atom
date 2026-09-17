# 02 · Event contract（事元）

## Principle

**唯一变更通道 = append event.**  
Candidates and stage status are **projections** folded from events. Do not mutate history.

## Table: `events`

| Column | Type | Notes |
|---|---|---|
| `id` | text pk | ulid / uuid |
| `type` | text | enum below |
| `subject_id` | text | candidate id, message id, spec id, … |
| `summary` | text | short human line |
| `detail_json` | text | type-specific payload |
| `refs_json` | text | JSON array of `Ref` (may be empty only when type allows) |
| `actor` | text | `system` \| `llm` \| `user:<id>` |
| `created_at` | text | ISO-8601 |

## Ref

```ts
type Ref = {
  /** e.g. yzj:im:<groupId>:<msgId> or slack:C123:ts */
  token: string
  kind: "im" | "doc" | "meeting" | "file" | "url" | "git"
  /** optional short digest for UI; never a substitute for token */
  digest?: string
}
```

## Event types (v0)

| type | subject | refs required? | detail (sketch) |
|---|---|---|---|
| `message_ingested` | message id | no (self) | raw fields, source adapter id, cursor |
| `candidate_proposed` | candidate id | **yes (≥1)** | title, body, confidence, cluster_key |
| `decision_accepted` | candidate id | optional | note |
| `decision_rejected` | candidate id | optional | reason |
| `decision_merged` | surviving candidate id | optional | `merged_ids[]` |
| `spec_drafted` | spec id | yes (to candidate / messages) | acceptance criteria[] |
| `handoff_exported` | handoff id | yes | target (`cursor`/`codex`/file path) |
| `evidence_attached` | evidence id | yes | kind (`test`/`screenshot`/`log`), path |
| `pr_opened` | pr id | yes | url, branch |

Unknown types are **rejected** by the writer. Adding a type is a contract change (bump doc version).

## Projection: `candidates` (materialized)

Derived fields (examples):

- `title`, `body`, `confidence`
- `status`: `suggested` \| `accepted` \| `rejected` \| `merged`
- `refs[]` union from propose + later attachments
- `updated_at` = last related event time

Rebuildable anytime by replaying events for `subject_id`.

## Hard rules

1. `candidate_proposed` without refs → **invalid**, do not persist.
2. Accept/reject never deletes the propose event.
3. Merge appends `decision_merged`; losers stay in history.
4. LLM output must pass schema validation (Zod) before becoming an event.
5. Outbound sends are **not** events until after human confirm; the confirm itself may be logged as a decision-like event later.

## Version

`event-contract@0.1`
