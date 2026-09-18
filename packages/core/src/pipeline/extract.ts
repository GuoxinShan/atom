import { ExtractAgent, RawMessage } from "../schema/types.js";
import { EventStore } from "../store/events.js";
import { newId } from "../schema/ids.js";
import { HeuristicCandidateGate } from "../agents/heuristic.js";

function messagesFromStore(store: EventStore, groupAllow?: Set<string>): RawMessage[] {
  return store
    .list({ type: "message_ingested", limit: 5000 })
    .map((ev) => {
      const detail = JSON.parse(ev.detail_json) as Record<string, unknown>;
      return {
        id: ev.subject_id,
        source: String(detail.source ?? "unknown"),
        groupId: detail.groupId ? String(detail.groupId) : undefined,
        author: detail.author ? String(detail.author) : undefined,
        text: String(detail.text ?? ev.summary),
        ts: String(detail.ts ?? ev.created_at),
      };
    })
    .filter((m) => {
      if (!groupAllow || groupAllow.size === 0) return true;
      return m.groupId ? groupAllow.has(m.groupId) : false;
    });
}

export async function runExtract(
  store: EventStore,
  agent: ExtractAgent,
  opts?: {
    /** default true — heuristic only shortlists seeds */
    heuristicGate?: boolean;
    /** limit extract to these yzj group ids */
    groupAllowlist?: string[];
  }
): Promise<{ proposed: number; skipped: number; seeded: number; gated: number }> {
  const runId = newId("agent");
  const useGate = opts?.heuristicGate !== false;
  const groupAllow = opts?.groupAllowlist?.length
    ? new Set(opts.groupAllowlist)
    : undefined;

  store.append({
    type: "agent_started",
    subject_id: runId,
    summary: `extract start: ${agent.id}${useGate ? "+heuristic-gate" : ""}`,
    detail: {
      agent_id: agent.id,
      kind: "extract",
      heuristic_gate: useGate,
      group_allowlist: opts?.groupAllowlist ?? [],
    },
    actor: `agent:${agent.id}`,
  });

  try {
    const all = messagesFromStore(store, groupAllow);
    const gate = new HeuristicCandidateGate();
    const seeded = useGate ? gate.filter(all) : all;

    console.log(
      `[extract] messages=${all.length} seeds=${seeded.length} agent=${agent.id} groups=${
        opts?.groupAllowlist?.join(",") || "*"
      }`
    );

    const proposals = await agent.extract(seeded);

    const existing = store.list({ type: "candidate_proposed", limit: 5000 });
    const seenKeys = new Set(
      existing.map((e) => {
        const d = JSON.parse(e.detail_json) as Record<string, unknown>;
        return String(d.cluster_key ?? e.summary);
      })
    );

    let proposed = 0;
    let skipped = 0;
    for (const p of proposals) {
      const key = p.cluster_key ?? p.title;
      if (seenKeys.has(key)) {
        skipped += 1;
        continue;
      }
      if (!p.refs.length) {
        skipped += 1;
        continue;
      }
      const candId = newId("cand");
      store.append({
        type: "candidate_proposed",
        subject_id: candId,
        summary: p.title,
        detail: {
          title: p.title,
          body: p.body,
          confidence: p.confidence,
          cluster_key: key,
          source_message_ids: p.source_message_ids,
          agent_id: agent.id,
          gated_by: useGate ? "heuristic-gate" : "none",
        },
        refs: p.refs,
        actor: `agent:${agent.id}`,
      });
      seenKeys.add(key);
      proposed += 1;
    }

    store.append({
      type: "agent_completed",
      subject_id: runId,
      summary: `extract done: ${agent.id} proposed=${proposed} seeds=${seeded.length}`,
      detail: {
        agent_id: agent.id,
        proposed,
        skipped,
        message_count: all.length,
        seed_count: seeded.length,
      },
      actor: `agent:${agent.id}`,
    });

    return { proposed, skipped, seeded: seeded.length, gated: all.length - seeded.length };
  } catch (err) {
    store.append({
      type: "agent_failed",
      subject_id: runId,
      summary: `extract failed: ${agent.id}`,
      detail: { agent_id: agent.id, error: (err as Error).message },
      actor: `agent:${agent.id}`,
    });
    throw err;
  }
}
