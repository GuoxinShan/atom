import type { Atom, Candidate, ProposedCandidate, RawMessage } from "./types.ts";
import type { ExtractAgent, SourceAdapter, SubscriptionSink, TriggerConfig } from "./interfaces.ts";
import { HUMAN_GATED_PIPELINES } from "./interfaces.ts";
import { newId } from "./ids.ts";
import { ProposedCandidateSchema } from "./schema.ts";
import type { AtomStore } from "./store.ts";
import { writeAtom } from "./writer.ts";
import {
  existingClusterKeys,
  projectCandidates,
  projectMessages,
} from "./projections.ts";
import { renderDigest, writeDigestFile } from "./digest.ts";
import { MANUAL_TRIGGER } from "./trigger.ts";
import { LogSubscriptionSink } from "./sink.ts";
import { writeAgentCompleted, writeAgentFailed, writeAgentStarted } from "./agents.ts";
import { fanoutAtom, HumanGateError } from "./loop.ts";

export type Pipeline = {
  store: AtomStore;
  sources: SourceAdapter[];
  extract: ExtractAgent;
  outDir: string;
  sink?: SubscriptionSink;
  trigger?: TriggerConfig;
  triggers?: TriggerConfig[];
};

export async function ingest(p: Pipeline): Promise<{ ingested: number; skipped: number }> {
  let ingested = 0;
  let skipped = 0;
  for (const source of p.sources) {
    const r = await ingestOne(p, source);
    ingested += r.ingested;
    skipped += r.skipped;
  }
  return { ingested, skipped };
}

function loopOpts(p: Pipeline) {
  return {
    triggers: p.triggers ?? [],
    dispatch: async (trigger: TriggerConfig) => {
      await executeTrigger(p, trigger);
    },
  };
}

async function commitAtom(p: Pipeline, input: Parameters<typeof writeAtom>[1]): Promise<Atom> {
  const atom = writeAtom(p.store, input);
  await fanoutAtom(atom, loopOpts(p));
  return atom;
}

async function ingestOne(
  p: Pipeline,
  source: SourceAdapter,
): Promise<{ ingested: number; skipped: number }> {
  const cursor = p.store.getCursor(source.id);
  const { messages, nextCursor } = await source.pullSince(cursor);
  let ingested = 0;
  let skipped = 0;
  for (const msg of messages) {
    if (p.store.hasSubject("message_ingested", msg.id)) {
      skipped += 1;
      continue;
    }
    await commitAtom(p, {
      type: "message_ingested",
      subject_id: msg.id,
      summary: `ingested ${msg.id}`,
      actor: "system",
      refs: [],
      detail: {
        source_adapter_id: source.id,
        cursor: msg.cursor ?? msg.id,
        raw: msg,
      },
    });
    ingested += 1;
  }
  p.store.setCursor(source.id, nextCursor, new Date().toISOString());
  await (p.sink ?? new LogSubscriptionSink()).publish({
    topic: "ingest",
    payload: { source: source.id, ingested, skipped, trigger: (p.trigger ?? MANUAL_TRIGGER).id },
  });
  return { ingested, skipped };
}

export async function extract(p: Pipeline): Promise<{ proposed: number; skipped: number }> {
  const actor = p.extract.id.startsWith("grok") ? "llm" : "system";
  const started = writeAgentStarted(
    p.store,
    {
      agent_id: p.extract.id,
      pipeline: "extract",
      trigger_id: (p.trigger ?? MANUAL_TRIGGER).id,
    },
    actor,
  );
  await fanoutAtom(started, loopOpts(p));
  try {
    const atoms = p.store.listAll();
    const messages = projectMessages(atoms);
    const candidates = projectCandidates(atoms);
    const seen = existingClusterKeys(candidates);
    const proposed = await p.extract.propose({ messages });
    let count = 0;
    let skipped = 0;
    for (const raw of proposed) {
      const parsed = ProposedCandidateSchema.safeParse(raw);
      if (!parsed.success) {
        skipped += 1;
        continue;
      }
      const item = parsed.data as ProposedCandidate;
      const cluster = item.cluster_key ?? `title:${slug(item.title)}`;
      if (seen.has(cluster)) {
        skipped += 1;
        continue;
      }
      const id = newId();
      await commitAtom(p, {
        type: "candidate_proposed",
        subject_id: id,
        summary: item.title,
        actor,
        refs: item.refs,
        detail: {
          title: item.title,
          body: item.body,
          confidence: item.confidence,
          cluster_key: cluster,
          extract_agent_id: p.extract.id,
        },
      });
      seen.add(cluster);
      count += 1;
    }
    const done = writeAgentCompleted(
      p.store,
      started.subject_id,
      {
        agent_id: p.extract.id,
        pipeline: "extract",
        trigger_id: (p.trigger ?? MANUAL_TRIGGER).id,
      },
      actor,
    );
    await fanoutAtom(done, loopOpts(p));
    await (p.sink ?? new LogSubscriptionSink()).publish({
      topic: "extract",
      payload: {
        agent: p.extract.id,
        proposed: count,
        skipped,
        trigger: (p.trigger ?? MANUAL_TRIGGER).id,
      },
    });
    return { proposed: count, skipped };
  } catch (err) {
    const failed = writeAgentFailed(
      p.store,
      started.subject_id,
      {
        agent_id: p.extract.id,
        pipeline: "extract",
        trigger_id: (p.trigger ?? MANUAL_TRIGGER).id,
        error: err instanceof Error ? err.message : String(err),
      },
      actor,
    );
    await fanoutAtom(failed, loopOpts(p));
    throw err;
  }
}

export function digest(p: Pipeline): { path: string; candidates: Candidate[] } {
  const candidates = projectCandidates(p.store.listAll());
  const markdown = renderDigest(candidates);
  const path = writeDigestFile(p.outDir, markdown);
  return { path, candidates };
}

export async function run(p: Pipeline): Promise<{
  ingested: number;
  proposed: number;
  digestPath: string;
}> {
  const ing = await ingest(p);
  const ext = await extract(p);
  const dig = digest(p);
  return { ingested: ing.ingested, proposed: ext.proposed, digestPath: dig.path };
}

/** Dispatch a TriggerConfig onto the same runner. */
export async function executeTrigger(
  p: Pipeline,
  trigger: TriggerConfig,
): Promise<{ ingested?: number; proposed?: number; digestPath?: string; skipped?: number }> {
  if (HUMAN_GATED_PIPELINES.has(trigger.pipeline)) {
    throw new HumanGateError(
      `trigger ${trigger.id} pipeline=${trigger.pipeline} is human-gated; auto-chain will not skip approve`,
    );
  }
  const boundKinds = new Set(["manual", "atom_event"]);
  if (!boundKinds.has(trigger.kind) && !(trigger.kind === "hook" && trigger.config["on"] === "atom")) {
    throw new Error(
      `trigger ${trigger.id} kind=${trigger.kind} is registered but not bound in Stage-1. See docs/06-extensibility.md.`,
    );
  }
  const bound: Pipeline = { ...p, trigger };
  if (trigger.pipeline === "ingest") return ingest(bound);
  if (trigger.pipeline === "extract") return extract(bound);
  if (trigger.pipeline === "digest") {
    const d = digest(bound);
    return { digestPath: d.path };
  }
  if (trigger.pipeline === "run") return run(bound);
  throw new HumanGateError(`trigger ${trigger.id} pipeline=${trigger.pipeline} is not auto-run`);
}

export function decideOnStore(
  store: AtomStore,
  candidateId: string,
  decision: "accepted" | "rejected",
  note?: string,
  actor: `user:${string}` = "user:local",
): Candidate {
  const candidates = projectCandidates(store.listAll());
  const found = candidates.find((c) => c.id === candidateId);
  if (!found) throw new Error(`unknown candidate: ${candidateId}`);
  writeAtom(store, {
    type: decision === "accepted" ? "decision_accepted" : "decision_rejected",
    subject_id: candidateId,
    summary: `${decision} ${found.title}`,
    actor,
    refs: [],
    detail: decision === "accepted" ? { note: note ?? "" } : { reason: note ?? "" },
  });
  const updated = projectCandidates(store.listAll()).find((c) => c.id === candidateId);
  if (!updated) throw new Error(`projection missing ${candidateId}`);
  return updated;
}

export async function decide(
  p: Pipeline,
  candidateId: string,
  decision: "accepted" | "rejected",
  note?: string,
  actor: `user:${string}` = "user:local",
): Promise<Candidate> {
  const updated = decideOnStore(p.store, candidateId, decision, note, actor);
  const last = [...p.store.listAll()].reverse().find((a) => a.subject_id === candidateId);
  if (last) await fanoutAtom(last, loopOpts(p));
  return updated;
}

function slug(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 80);
}

export type { RawMessage };
