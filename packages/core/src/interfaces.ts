import type { ProposedCandidate, RawMessage } from "./types.ts";

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
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export const TRIGGER_PIPELINES = ["ingest", "extract", "run"] as const;
export type TriggerPipeline = (typeof TRIGGER_PIPELINES)[number];

export interface TriggerConfig {
  id: string;
  kind: TriggerKind;
  enabled: boolean;
  pipeline: TriggerPipeline;
  config: Record<string, unknown>;
}

/** @deprecated Use TriggerConfig. */
export type Trigger = TriggerConfig;

export interface SubscriptionSink {
  id: string;
  publish(event: { topic: string; payload: unknown }): Promise<void>;
}
