import type { Atom, ProposedCandidate, RawMessage } from "./types.ts";

export interface SourceAdapter {
  id: string;
  pullSince(cursor: string | null): Promise<{
    messages: RawMessage[];
    nextCursor: string;
  }>;
}

export interface ExtractAgent {
  id: string;
  propose(input: { messages: RawMessage[] }): Promise<ProposedCandidate[]>;
}

export const TRIGGER_KINDS = [
  "manual",
  "cron",
  "webhook",
  "hook",
  "im_event",
  "fs_watch",
  "atom_event",
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export const TRIGGER_PIPELINES = [
  "ingest",
  "extract",
  "run",
  "digest",
  "approve",
  "spec",
  "handoff",
] as const;
export type TriggerPipeline = (typeof TRIGGER_PIPELINES)[number];

/** Auto-chain must stop here — a human writes the next atom. */
export const HUMAN_GATED_PIPELINES: ReadonlySet<TriggerPipeline> = new Set([
  "approve",
  "spec",
  "handoff",
]);

export interface TriggerConfig {
  id: string;
  kind: TriggerKind;
  enabled: boolean;
  pipeline: TriggerPipeline;
  config: Record<string, unknown>;
}

/** @deprecated Use TriggerConfig. */
export type Trigger = TriggerConfig;

export interface ExecuteAgent {
  id: string;
  /** Later: handoff/spec. Must emit atoms; never a fire-and-forget side effect. */
  run?(input: { subjectId: string }): Promise<void>;
}

export interface SubscriptionSink {
  id: string;
  /** Pipeline telemetry (ingest/extract summaries). Not the atom feed. */
  publish(event: { topic: string; payload: unknown }): Promise<void>;
  /** Outbound: called after each atom is appended. Stage-1 stubs HTTP. */
  onAtom(atom: Atom): Promise<void>;
}
