/**
 * One-shot Needs-you duplicate backfill.
 *
 * Live extract only merge-gates *new* proposals. Twins created before that
 * gate stay on Desk as separate suggested items. This sweep re-runs the same
 * Laya merge interpretation across existing open Needs-you / suggested items.
 *
 * Dry-run is the default (no events). `--apply` writes the live-gate merge:
 * `decision_merged` on the loser, refs attach to the survivor, `laya_merge`
 * audit. Existing items already have `candidate_proposed` — do not re-propose.
 *
 * Safe: only suggested↔suggested; never merge into rejected/accepted/merged;
 * skip losers already folded; one timeout fail-opens that pair without
 * poisoning the Laya client (same as extract after PR #13).
 */

import { newId } from "../schema/ids.js";
import type { CandidateView } from "../schema/types.js";
import { EventStore } from "../store/events.js";
import { candidatesByStatus, projectCandidates } from "../store/candidates.js";
import {
  LayaClient,
  MERGE_OPEN_ITEMS_CAP,
  rankOpenItemsForMerge,
  snippetText,
  type LayaMergeGate,
  type OpenItemSnippet,
} from "../agents/laya.js";
import { loadThemeVocabulary } from "../agents/theme-vocabulary.js";
import { appendLayaMergeDecision, isLayaMergeNow } from "./laya-merge.js";

export type MergeSweepPair = {
  loserId: string;
  loserTitle: string;
  survivorId: string;
  survivorTitle: string;
  sameRequest?: number;
  confidence?: number;
  reason: string;
};

export type MergeSweepResult = {
  apply: boolean;
  considered: number;
  compared: number;
  merged: number;
  skipped: number;
  failOpen: boolean;
  layaAvailable: boolean;
  reason?: string;
  pairs: MergeSweepPair[];
};

export function listOpenSuggested(store: EventStore): CandidateView[] {
  return candidatesByStatus(store, "suggested").slice().sort((a, b) => {
    const t = a.updated_at.localeCompare(b.updated_at);
    return t !== 0 ? t : a.id.localeCompare(b.id);
  });
}

export function openItemSnippet(c: CandidateView): OpenItemSnippet {
  return {
    id: c.id,
    title: c.title,
    snippet: snippetText(c.body || c.title),
    refs: c.refs.map((r) => r.token),
  };
}

function emptyResult(
  apply: boolean,
  considered: number,
  extra?: Partial<MergeSweepResult>
): MergeSweepResult {
  return {
    apply,
    considered,
    compared: 0,
    merged: 0,
    skipped: 0,
    failOpen: false,
    layaAvailable: true,
    pairs: [],
    ...extra,
  };
}

function pairFrom(loser: CandidateView, survivor: CandidateView, gate: LayaMergeGate): MergeSweepPair {
  return {
    loserId: loser.id,
    loserTitle: loser.title,
    survivorId: survivor.id,
    survivorTitle: survivor.title,
    sameRequest: gate.sameRequest,
    confidence: gate.confidence,
    reason: gate.reason,
  };
}

function stillSuggested(store: EventStore, id: string): CandidateView | undefined {
  const found = projectCandidates(store).find((c) => c.id === id);
  return found?.status === "suggested" ? found : undefined;
}

export async function runMergeSweep(
  store: EventStore,
  opts?: {
    /** default false — print / return pairs only; true writes decision_merged */
    apply?: boolean;
    /** inject Laya client; `false` skips (tests / LAYA_ENABLED=0) */
    laya?: LayaClient | false;
    repoRoot?: string;
  }
): Promise<MergeSweepResult> {
  const apply = opts?.apply === true;
  const open = listOpenSuggested(store);
  const considered = open.length;

  const laya =
    opts?.laya === false ? null : opts?.laya ?? LayaClient.fromEnv({ repoRoot: opts?.repoRoot });
  if (!laya?.isEnabled()) {
    return emptyResult(apply, considered, {
      failOpen: true,
      layaAvailable: false,
      reason: "laya-disabled",
    });
  }

  if (considered < 2) {
    return emptyResult(apply, considered);
  }

  let layaAvailable = await laya.ensureUp();
  if (!layaAvailable) {
    console.warn("[merge-sweep] Laya unavailable — fail-open (no merges)");
    return emptyResult(apply, considered, {
      failOpen: true,
      layaAvailable: false,
      reason: "laya-unavailable",
    });
  }

  const runId = apply ? newId("agent") : undefined;
  if (apply && runId) {
    store.append({
      type: "agent_started",
      subject_id: runId,
      summary: `merge-sweep start: open=${considered}`,
      detail: { kind: "merge-sweep", apply: true, open: considered },
      actor: "system:laya-merge",
    });
  }

  const stillOpen = new Map(open.map((c) => [c.id, c]));
  const pairs: MergeSweepPair[] = [];
  let compared = 0;
  let skipped = 0;
  let failOpen = false;

  try {
    for (let i = 0; i < open.length; i++) {
      const item = open[i]!;
      if (!stillOpen.has(item.id)) continue;

      const earlier = open.slice(0, i).filter((c) => stillOpen.has(c.id));
      if (!earlier.length) continue;

      if (laya.unavailable) {
        failOpen = true;
        layaAvailable = false;
        skipped += 1;
        continue;
      }

      // Rank by local near-duplicate score so the cap-8 window sees the twin.
      const openItems = rankOpenItemsForMerge(
        { title: item.title, body: item.body, refs: item.refs.map((r) => r.token) },
        earlier.map(openItemSnippet),
        MERGE_OPEN_ITEMS_CAP
      );

      compared += 1;
      const gate = await laya.gateMerge({
        title: item.title,
        body: item.body,
        refs: item.refs.map((r) => r.token),
        openItems,
      });
      if (gate.failOpen) failOpen = true;

      if (!isLayaMergeNow(gate)) {
        skipped += 1;
        continue;
      }

      const targetLive = stillSuggested(store, gate.targetId);
      const loserLive = stillSuggested(store, item.id);
      if (!targetLive || !loserLive || targetLive.id === loserLive.id) {
        skipped += 1;
        continue;
      }
      if (!stillOpen.has(targetLive.id)) {
        skipped += 1;
        continue;
      }

      const pair = pairFrom(loserLive, targetLive, gate);
      pairs.push(pair);
      stillOpen.delete(loserLive.id);

      if (apply) {
        appendLayaMergeDecision(store, {
          loserId: loserLive.id,
          loserTitle: loserLive.title,
          loserRefs: loserLive.refs,
          targetId: targetLive.id,
          gate,
          loser: loserLive,
          vocab: loadThemeVocabulary(opts?.repoRoot),
        });
        console.log(
          `[merge-sweep] merged ${loserLive.id} → ${targetLive.id}: ${loserLive.title}`
        );
      } else {
        console.log(
          `[merge-sweep] dry-run ${loserLive.id} → ${targetLive.id}: ${loserLive.title}`
        );
      }
    }

    if (apply && runId) {
      store.append({
        type: "agent_completed",
        subject_id: runId,
        summary: `merge-sweep done: merged=${pairs.length}`,
        detail: {
          kind: "merge-sweep",
          apply: true,
          considered,
          compared,
          merged: pairs.length,
          skipped,
          fail_open: failOpen,
        },
        actor: "system:laya-merge",
      });
    }

    return {
      apply,
      considered,
      compared,
      merged: pairs.length,
      skipped,
      failOpen,
      layaAvailable: layaAvailable && !laya.unavailable,
      pairs,
    };
  } catch (err) {
    if (apply && runId) {
      store.append({
        type: "agent_failed",
        subject_id: runId,
        summary: "merge-sweep failed",
        detail: { kind: "merge-sweep", error: (err as Error).message },
        actor: "system:laya-merge",
      });
    }
    throw err;
  }
}
