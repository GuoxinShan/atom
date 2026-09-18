import { ExtractAgent, SourceAdapter, SubscriptionSink, Trigger } from "../schema/types.js";
import { EventStore } from "../store/events.js";
import { ingestFromSource } from "./ingest.js";
import { runExtract } from "./extract.js";
import { writeDigest } from "./digest.js";
import { recordRunFinished } from "./runtime-meta.js";

export async function runPipeline(opts: {
  store: EventStore;
  source: SourceAdapter;
  agent: ExtractAgent;
  repoRoot: string;
  trigger?: Trigger;
  sink?: SubscriptionSink;
  groupAllowlist?: string[];
  heuristicGate?: boolean;
}): Promise<{ ingested: number; proposed: number; digestPath: string; seeded: number }> {
  await opts.trigger?.fire("run");
  const { ingested } = await ingestFromSource(opts.store, opts.source);
  const { proposed, seeded } = await runExtract(opts.store, opts.agent, {
    heuristicGate: opts.heuristicGate !== false,
    groupAllowlist: opts.groupAllowlist,
  });
  const digestPath = writeDigest(opts.store, opts.repoRoot);
  recordRunFinished(opts.store);
  await opts.sink?.publish({
    kind: "digest",
    text: `ingest=${ingested} seeds=${seeded} proposed=${proposed} digest=${digestPath}`,
  });
  return { ingested, proposed, digestPath, seeded };
}
