import type { CandidateView, Ref } from "../schema/types.js";
import type { EventStore } from "../store/events.js";
import { projectCandidates } from "../store/candidates.js";
import { layaMergeToDetail, type LayaMergeGate } from "../agents/laya.js";
import {
  canonicalNonOtherTheme,
  DEFAULT_THEME_VOCABULARY,
  type ThemeVocabulary,
} from "../agents/theme-vocabulary.js";

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
    loser?: Pick<CandidateView, "title" | "body" | "theme" | "project" | "tags">;
    vocab?: ThemeVocabulary;
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
  promoteSurvivorTheme(store, input.targetId, input.loser, input.vocab);
}

/** If the survivor is 其他/untagged, copy a canonical theme from the loser or titles. */
export function promoteSurvivorTheme(
  store: EventStore,
  survivorId: string,
  loser?: Pick<CandidateView, "title" | "body" | "theme" | "project" | "tags">,
  vocab: ThemeVocabulary = DEFAULT_THEME_VOCABULARY
): void {
  const survivor = projectCandidates(store).find((c) => c.id === survivorId);
  if (!survivor || survivor.status !== "suggested") return;
  if (canonicalNonOtherTheme(survivor, vocab)) return;
  const theme =
    (loser ? canonicalNonOtherTheme(loser, vocab) : undefined) ??
    canonicalNonOtherTheme(survivor, vocab);
  if (!theme) return;
  store.append({
    type: "candidate_tagged",
    subject_id: survivorId,
    summary: `tagged merge-promote: ${survivor.title}`,
    detail: {
      theme,
      tags: { theme },
      via: "allowlist",
    },
    actor: "system:laya-tags",
  });
}
