import { z } from "zod";

export const RefSchema = z.object({
  token: z.string().min(1),
  kind: z.enum(["im", "doc", "meeting", "file", "url", "git"]),
  digest: z.string().optional(),
});
export type Ref = z.infer<typeof RefSchema>;

export const AtomTypeSchema = z.enum([
  "message_ingested",
  "candidate_proposed",
  "decision_accepted",
  "decision_rejected",
  "decision_merged",
  "decision_reopened",
  "spec_drafted",
  "spec_approved",
  "spec_returned",
  "pr_opened",
  "evidence_attached",
  "handoff_exported",
  "pr_checklist_started",
  "pr_checklist_item_done",
  "pr_checklist_passed",
  "agent_started",
  "agent_completed",
  "agent_failed",
  "preference_rsi",
  "candidate_tagged",
]);
export type AtomType = z.infer<typeof AtomTypeSchema>;

export const EventRecordSchema = z.object({
  id: z.string().min(1),
  type: AtomTypeSchema,
  subject_id: z.string().min(1),
  summary: z.string(),
  detail_json: z.string(),
  refs_json: z.string(),
  actor: z.string(),
  created_at: z.string(),
});
export type EventRecord = z.infer<typeof EventRecordSchema>;

export const RawMessageSchema = z.object({
  id: z.string(),
  source: z.string(),
  groupId: z.string().optional(),
  author: z.string().optional(),
  text: z.string(),
  ts: z.string(),
  raw: z.unknown().optional(),
});
export type RawMessage = z.infer<typeof RawMessageSchema>;

export const CandidateTagsSchema = z
  .object({
    theme: z.string().optional(),
    project: z.string().optional(),
  })
  .passthrough();
export type CandidateTags = z.infer<typeof CandidateTagsSchema>;

export const CandidateProposalSchema = z.object({
  title: z.string().min(1),
  body: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0.6),
  cluster_key: z.string().optional(),
  /** Display grouping only — not a Laya classification gate. */
  theme: z.string().optional(),
  project: z.string().optional(),
  tags: CandidateTagsSchema.optional(),
  refs: z.array(RefSchema).min(1),
  source_message_ids: z.array(z.string()).default([]),
});
export type CandidateProposal = z.infer<typeof CandidateProposalSchema>;

export type CandidateStatus = "suggested" | "accepted" | "rejected" | "merged";

export interface CandidateView {
  id: string;
  title: string;
  body: string;
  confidence: number;
  status: CandidateStatus;
  refs: Ref[];
  updated_at: string;
  cluster_key?: string;
  theme?: string;
  project?: string;
  tags?: CandidateTags;
  /** `already_done` when the Done gate auto-closed this card. */
  disposition?: "already_done";
  reject_reason?: string;
  /** Human line for 系统已处理, e.g. 已在仓库/历史进度关闭. */
  closed_reason?: string;
  /** After 「仍要我跟」 — Done gate must not auto-close this id again. */
  keep_open?: boolean;
  /** Laya duplicate-fold loser; survivor id still on Needs-you. */
  merged_into?: string;
}

export interface SourceAdapter {
  id: string;
  pullSince(
    cursor: string | null,
    opts?: { groupIds?: string[] }
  ): Promise<{ messages: RawMessage[]; nextCursor: string }>;
}

export interface ExtractAgent {
  id: string;
  extract(messages: RawMessage[]): Promise<CandidateProposal[]>;
}

export interface Trigger {
  id: string;
  /** Stage-1: manual stub only */
  fire(reason?: string): Promise<void>;
}

export interface SubscriptionSink {
  id: string;
  publish(payload: { kind: string; text: string; meta?: Record<string, unknown> }): Promise<void>;
}

export interface SpecDraft {
  id: string;
  candidate_id: string;
  title: string;
  body: string;
  acceptance_criteria: string[];
  refs: Ref[];
}

/** Human review of a drafted spec, before an explicit Lead handoff. */
export type SpecReviewStatus = "pending" | "returned" | "approved" | "handed_off";

export interface SpecView extends SpecDraft {
  review_status: SpecReviewStatus;
  /** 已通过 → spec 待审 → 已批准 → 已派 Lead (current step). */
  stage_label: string;
  updated_at: string;
  note?: string;
  handoff_id?: string;
  handoff_path?: string;
  handoff_target?: string;
  ran?: boolean;
}

export interface HandoffPack {
  id: string;
  spec_id: string;
  candidate_id: string;
  path: string;
  target: "grok-cli" | "cursor" | "file";
}

/** Execute / coding seam — consumes a drafted spec, may spawn local agents. */
export interface CodingAgent {
  id: string;
  handoff(
    spec: SpecDraft,
    opts?: { run?: boolean; workDir?: string; briefing?: string }
  ): Promise<HandoffPack>;
}
