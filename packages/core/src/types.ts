export const ATOM_CONTRACT_VERSION = "atom-contract@0.2";

export const ATOM_TYPES = [
  "message_ingested",
  "candidate_proposed",
  "decision_accepted",
  "decision_rejected",
  "decision_merged",
  "spec_drafted",
  "handoff_exported",
  "evidence_attached",
  "pr_opened",
  "agent_started",
  "agent_completed",
  "agent_failed",
] as const;

export type AtomType = (typeof ATOM_TYPES)[number];

export const REF_KINDS = ["im", "doc", "meeting", "file", "url", "git"] as const;
export type RefKind = (typeof REF_KINDS)[number];

export type Ref = {
  /** e.g. yzj:im:<groupId>:<msgId> or slack:C123:ts */
  token: string;
  kind: RefKind;
  /** optional short digest for UI; never a substitute for token */
  digest?: string;
};

export type Actor = "system" | "llm" | `user:${string}`;

/** Domain record: one append-only change. Persisted in SQL table `events`. */
export type Atom = {
  id: string;
  type: AtomType;
  subject_id: string;
  summary: string;
  detail: unknown;
  refs: Ref[];
  actor: Actor;
  created_at: string;
};

export type RawMessage = {
  id: string;
  sourceId: string;
  groupId?: string;
  author: string;
  text: string;
  sentAt: string;
  token: string;
  cursor?: string;
};

export type ProposedCandidate = {
  title: string;
  body: string;
  confidence: number;
  cluster_key?: string;
  refs: [Ref, ...Ref[]];
};

export type CandidateStatus = "suggested" | "accepted" | "rejected" | "merged";

export type Candidate = {
  id: string;
  title: string;
  body: string;
  confidence: number;
  cluster_key?: string;
  status: CandidateStatus;
  refs: Ref[];
  updated_at: string;
};

export type NewAtom = {
  type: AtomType;
  subject_id: string;
  summary: string;
  detail?: unknown;
  refs?: Ref[];
  actor: Actor;
};

export const TYPES_REQUIRING_REFS: ReadonlySet<AtomType> = new Set([
  "candidate_proposed",
  "spec_drafted",
  "handoff_exported",
  "evidence_attached",
  "pr_opened",
]);
