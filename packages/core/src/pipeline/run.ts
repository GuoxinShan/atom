import { ExtractAgent, SourceAdapter, SubscriptionSink, Trigger } from "../schema/types.js";
import { EventStore } from "../store/events.js";
import type { LayaClient } from "../agents/laya.js";
import { ingestFromSource } from "./ingest.js";
import { runExtract } from "./extract.js";
import { writeDigest } from "./digest.js";
import { publishOutbound } from "./laya-outbound.js";
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
  /** inject Laya client; `false` skips the outbound gate (tests / LAYA_ENABLED=0) */
  laya?: LayaClient | false;
}): Promise<{ ingested: number; proposed: number; digestPath: string; seeded: number }> {
  await opts.trigger?.fire("run");
  const { ingested } = await ingestFromSource(opts.store, opts.source);
  const { proposed, seeded } = await runExtract(opts.store, opts.agent, {
    heuristicGate: opts.heuristicGate !== false,
    groupAllowlist: opts.groupAllowlist,
    laya: opts.laya,
  });
  const digestPath = writeDigest(opts.store, opts.repoRoot);
  recordRunFinished(opts.store);
  if (opts.sink) {
    // Local digest file is a projection, not a send. Gate the subscription
    // emit — the actual outbound seam — then Desk still confirms Yunzhijia.
    await publishOutbound(
      opts.repoRoot,
      {
        kind: "digest",
        text: `ingest=${ingested} seeds=${seeded} proposed=${proposed} digest=${digestPath}`,
        meta: { digestPath, ingested, seeded, proposed },
      },
      {
        store: opts.store,
        laya: opts.laya,
        deliver: (payload) => opts.sink!.publish(payload),
      }
    );
  }
  return { ingested, proposed, digestPath, seeded };
}
