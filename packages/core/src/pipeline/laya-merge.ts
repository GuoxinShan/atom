import type { Ref } from "../schema/types.js";
import type { EventStore } from "../store/events.js";
import { layaMergeToDetail, type LayaMergeGate } from "../agents/laya.js";

/** High-confidence Laya fold — same predicate extract uses before writing. */
export function isLayaMergeNow(
  gate: LayaMergeGate | undefined
): gate is LayaMergeGate & { targetId: string } {
  return Boolean(gate && gate.action === "merge" && gate.targetId && !gate.failOpen);
}

/**
 * Live-gate merge write: `decision_merged` on the loser, refs attach to the
 * survivor via projection, `laya_merge` audit in detail. Survivor stays
 * suggested — Desk remains the accept/reject gate.
 */
export function appendLayaMergeDecision(
  store: EventStore,
  input: {
    loserId: string;
    loserTitle: string;
    loserRefs: Ref[];
    targetId: string;
    gate: LayaMergeGate;
  }
): void {
  store.append({
    type: "decision_merged",
    subject_id: input.loserId,
    summary: `laya merge into ${input.targetId}: ${input.loserTitle}`,
    detail: {
      merged_into: input.targetId,
      merged_ids: [input.loserId],
      laya_merge: layaMergeToDetail(input.gate),
    },
    refs: input.loserRefs,
    actor: "system:laya-merge",
  });
}
