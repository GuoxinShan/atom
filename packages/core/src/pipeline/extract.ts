import { ExtractAgent, RawMessage } from "../schema/types.js";
import { EventStore } from "../store/events.js";
import { candidatesByStatus } from "../store/candidates.js";
import { newId } from "../schema/ids.js";
import { HeuristicCandidateGate } from "../agents/heuristic.js";
import { isNoiseProposal } from "../agents/noise.js";
import {
  LayaClient,
  MERGE_OPEN_ITEMS_CAP,
  layaGateToDetail,
  layaMergeToDetail,
  snippetText,
  type LayaCandidateGate,
  type LayaMergeGate,
  type OpenItemSnippet,
} from "../agents/laya.js";
import { appendLayaMergeDecision, isLayaMergeNow } from "./laya-merge.js";
import { recordExtractFinished } from "./runtime-meta.js";

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

/** Recent open Needs-you / suggested items for the Laya duplicate-merge gate. */
export function openSuggestedItems(
  store: EventStore,
  cap = MERGE_OPEN_ITEMS_CAP
): OpenItemSnippet[] {
  return candidatesByStatus(store, "suggested")
    .slice(0, cap)
    .map((c) => ({
      id: c.id,
      title: c.title,
      snippet: snippetText(c.body || c.title),
    }));
}

export async function runExtract(
  store: EventStore,
  agent: ExtractAgent,
  opts?: {
    /** default true — heuristic only shortlists seeds */
    heuristicGate?: boolean;
    /** limit extract to these yzj group ids */
    groupAllowlist?: string[];
    /** inject Laya client; `false` skips the optional gate (tests / LAYA_ENABLED=0) */
    laya?: LayaClient | false;
  }
): Promise<{
  proposed: number;
  skipped: number;
  seeded: number;
  gated: number;
  noiseDropped: number;
  merged: number;
}> {
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
    const ungatedCount = messagesFromStore(store).length;
    if (groupAllow && groupAllow.size > 0 && all.length === 0 && ungatedCount > 0) {
      console.warn(
        `[extract] group allowlist matched 0/${ungatedCount} messages — check --source / sources.json groupIds`
      );
    }
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

    const laya = opts?.laya === false ? null : opts?.laya ?? LayaClient.fromEnv();
    let layaAvailable = false;
    if (laya?.isEnabled()) {
      layaAvailable = await laya.ensureUp();
      if (!layaAvailable) {
        console.warn("[extract] Laya unavailable — fail-open (keep suggested)");
      }
    }

    let proposed = 0;
    let skipped = 0;
    let noiseDropped = 0;
    let merged = 0;
    let layaNoiseDropped = 0;
    let layaMerged = 0;
    let layaFailOpen = !layaAvailable && Boolean(laya?.isEnabled());
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
      if (isNoiseProposal(p.title, p.body)) {
        noiseDropped += 1;
        skipped += 1;
        continue;
      }

      let layaGate: LayaCandidateGate | undefined;
      if (laya?.isEnabled() && layaAvailable && !laya.unavailable) {
        layaGate = await laya.gateCandidate({ title: p.title, body: p.body });
        if (layaGate.failOpen) layaFailOpen = true;
        // interpretCandidateAnswers is noul-first: high is_chat_noise noul
        // already yields action=noise even when kind choice confidence is low.
        if (layaGate.action === "noise") {
          layaNoiseDropped += 1;
          noiseDropped += 1;
          skipped += 1;
          console.log(`[extract] laya dropped noise: ${p.title}`);
          continue;
        }
      } else if (laya?.isEnabled() && !layaAvailable) {
        layaFailOpen = true;
      }

      let layaMerge: LayaMergeGate | undefined;
      const openItems = openSuggestedItems(store);
      if (laya?.isEnabled() && layaAvailable && !laya.unavailable && openItems.length > 0) {
        layaMerge = await laya.gateMerge({
          title: p.title,
          body: p.body,
          openItems,
        });
        if (layaMerge.failOpen) layaFailOpen = true;
      }

      const candId = newId("cand");
      // interpretMergeAnswers is noul-first: high same_request + a real
      // open-item target is already action=merge / failOpen=false, even when
      // action choice confidence is low. Do not re-check choice confidence here.

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
          ...(layaGate ? { laya_gate: layaGateToDetail(layaGate) } : {}),
          ...(layaMerge ? { laya_merge: layaMergeToDetail(layaMerge) } : {}),
        },
        refs: p.refs,
        actor: `agent:${agent.id}`,
      });
      seenKeys.add(key);

      if (isLayaMergeNow(layaMerge)) {
        // Fold the duplicate off Needs-you. Survivor stays suggested — Desk
        // is still the accept/reject gate. Subject is the loser so projection
        // does not mark the existing item merged.
        appendLayaMergeDecision(store, {
          loserId: candId,
          loserTitle: p.title,
          loserRefs: p.refs,
          targetId: layaMerge.targetId,
          gate: layaMerge,
        });
        merged += 1;
        layaMerged += 1;
        console.log(
          `[extract] laya merged duplicate into ${layaMerge.targetId}: ${p.title}`
        );
        continue;
      }

      proposed += 1;
    }

    if (noiseDropped > 0) {
      console.log(`[extract] dropped ${noiseDropped} noise proposals`);
    }

    store.append({
      type: "agent_completed",
      subject_id: runId,
      summary: `extract done: ${agent.id} proposed=${proposed} seeds=${seeded.length}`,
      detail: {
        agent_id: agent.id,
        kind: "extract",
        proposed,
        skipped,
        merged,
        noise_dropped: noiseDropped,
        laya_noise_dropped: layaNoiseDropped,
        laya_merged: layaMerged,
        laya_fail_open: layaFailOpen,
        message_count: all.length,
        seed_count: seeded.length,
      },
      actor: `agent:${agent.id}`,
    });
    recordExtractFinished(store);

    return {
      proposed,
      skipped,
      seeded: seeded.length,
      gated: all.length - seeded.length,
      noiseDropped,
      merged,
    };
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
