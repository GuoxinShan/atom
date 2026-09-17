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

/** Manual CLI run is the only Stage-1 trigger. */
export interface Trigger {
  id: string;
  kind: "manual";
}

export interface SubscriptionSink {
  id: string;
  publish(event: { topic: string; payload: unknown }): Promise<void>;
}
