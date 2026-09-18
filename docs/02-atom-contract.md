# 02 · ATOM contract（事元）

## Principle

**ATOM** is the **product** name: *Append-only Timeline Of Matters* (事元).

**唯一变更通道 = append one atom** (a single immutable change record).  
Candidates and stage status are **projections** folded from that feed. Do not mutate history.

| Layer | Name |
|---|---|
| Product | **ATOM** |
| Domain type / one record | `Atom` |
| SQL table | `events` (boring on purpose — do not name the table after the product) |

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

## Atom types (v0)

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
| `pr_checklist_started` | handoff or candidate id | optional | checklist items[] (`id`, `key`, `required`, `label`) |
| `pr_checklist_item_done` | checklist item id | optional | `key`, `note`, `evidence_ref?`, `parent_id` |
| `pr_checklist_passed` | handoff or candidate id | optional | only when all required items are done (incl. explicit `human_gate_ack`) |
| `pr_opened` | pr id | yes | url, branch |
| `agent_started` | run id | optional | agent id, pipeline |
| `agent_completed` | run id | optional | agent id, pipeline, stats |
| `agent_failed` | run id | optional | agent id, error |

Unknown types are **rejected** by the writer. Adding a type is a contract change (bump `atom-contract` version).

## Projection: `candidates` (materialized)

Derived fields (examples):

- `title`, `body`, `confidence`
- `status`: `suggested` \| `accepted` \| `rejected` \| `merged`
- `refs[]` union from propose + later attachments
- `updated_at` = last related atom time

Rebuildable anytime by replaying atoms for `subject_id`.

## Hard rules

1. `candidate_proposed` without refs → **invalid**, do not persist.
2. Accept/reject never deletes the propose event.
3. Merge appends `decision_merged`; losers stay in history.
4. LLM output must pass schema validation (Zod) before becoming an atom.
5. Outbound sends are **not** events until after human confirm; the confirm itself may be logged as a decision-like event later.

## Version

`atom-contract@0.2`
