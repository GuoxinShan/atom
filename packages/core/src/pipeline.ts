import type { ExtractAgent, SourceAdapter, SubscriptionSink } from "./interfaces.ts";
import type { Candidate, ProposedCandidate, RawMessage } from "./types.ts";
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

export type Pipeline = {
  store: AtomStore;
  sources: SourceAdapter[];
  extract: ExtractAgent;
  outDir: string;
  sink?: SubscriptionSink;
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
    writeAtom(p.store, {
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
    payload: { source: source.id, ingested, skipped, trigger: MANUAL_TRIGGER.id },
  });
  return { ingested, skipped };
}

export async function extract(p: Pipeline): Promise<{ proposed: number; skipped: number }> {
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
    writeAtom(p.store, {
      type: "candidate_proposed",
      subject_id: id,
      summary: item.title,
      actor: p.extract.id.startsWith("grok") ? "llm" : "system",
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
  await (p.sink ?? new LogSubscriptionSink()).publish({
    topic: "extract",
    payload: { agent: p.extract.id, proposed: count, skipped },
  });
  return { proposed: count, skipped };
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

export function decide(
  p: Pipeline,
  candidateId: string,
  decision: "accepted" | "rejected",
  note?: string,
  actor: `user:${string}` = "user:local",
): Candidate {
  return decideOnStore(p.store, candidateId, decision, note, actor);
}

function slug(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 80);
}

export type { RawMessage };
