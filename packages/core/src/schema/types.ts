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
  "spec_drafted",
  "pr_opened",
  "evidence_attached",
  "handoff_exported",
  "pr_checklist_started",
  "pr_checklist_item_done",
  "pr_checklist_passed",
  "agent_started",
  "agent_completed",
  "agent_failed",
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

export const CandidateProposalSchema = z.object({
  title: z.string().min(1),
  body: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0.6),
  cluster_key: z.string().optional(),
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
}

export interface SourceAdapter {
  id: string;
  pullSince(cursor: string | null): Promise<{ messages: RawMessage[]; nextCursor: string }>;
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
