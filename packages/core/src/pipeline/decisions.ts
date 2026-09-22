import { EventStore } from "../store/events.js";
import { projectCandidates } from "../store/candidates.js";
import { newId } from "../schema/ids.js";
import { isNoiseProposal, NOISE_REJECT_REASON } from "../agents/noise.js";
import { findSpecForCandidate } from "./handoff.js";

export function approveCandidate(
  store: EventStore,
  candidateId: string,
  note?: string
): { specId: string; created: boolean } {
  const found = projectCandidates(store).find((c) => c.id === candidateId);
  if (!found) throw new Error(`Candidate not found: ${candidateId}`);
  const existing = findSpecForCandidate(store, candidateId);
  if (found.status === "accepted" && existing) {
    return { specId: existing.id, created: false };
  }

  if (found.status !== "accepted") {
    store.append({
      type: "decision_accepted",
      subject_id: candidateId,
      summary: `accepted: ${found.title}`,
      detail: { note: note ?? "" },
      refs: found.refs,
      actor: "user:local",
    });
  }

  // Event loop: acceptance wakes a draft spec (still human-refinable).
  // Does not hand off, dispatch a coding agent, or send Yunzhijia.
  const specId = newId("spec");
  store.append({
    type: "spec_drafted",
    subject_id: specId,
    summary: `spec draft for: ${found.title}`,
    detail: {
      candidate_id: candidateId,
      title: found.title,
      body: found.body,
      acceptance_criteria: [
        `Given cited evidence, «${found.title}» is implemented end-to-end.`,
        "Each criterion is testable without tribal knowledge.",
        "Outbound side effects stay confirm-gated.",
      ],
      status: "draft",
      note: note ?? "",
    },
    refs: found.refs,
    actor: "system:spec-agent",
  });
  return { specId, created: true };
}

export function rejectCandidate(
  store: EventStore,
  candidateId: string,
  reason?: string,
  actor = "user:local"
): void {
  const found = projectCandidates(store).find((c) => c.id === candidateId);
  if (!found) throw new Error(`Candidate not found: ${candidateId}`);
  store.append({
    type: "decision_rejected",
    subject_id: candidateId,
    summary: `rejected: ${found.title}`,
    detail: { reason: reason ?? "" },
    refs: found.refs,
    actor,
  });
}

export function mergeCandidates(
  store: EventStore,
  survivorId: string,
  mergedIds: string[]
): void {
  const all = projectCandidates(store);
  const survivor = all.find((c) => c.id === survivorId);
  if (!survivor) throw new Error(`Survivor not found: ${survivorId}`);
  store.append({
    type: "decision_merged",
    subject_id: survivorId,
    summary: `merged into: ${survivor.title}`,
    detail: { merged_ids: mergedIds },
    refs: survivor.refs,
    actor: "user:local",
  });
}

/** Reject currently-suggested candidates that match the shared noise heuristic. */
export function rejectNoiseCandidates(store: EventStore): {
  rejected: number;
  ids: string[];
  titles: string[];
} {
  const ids: string[] = [];
  const titles: string[] = [];
  for (const c of projectCandidates(store)) {
    if (c.status !== "suggested") continue;
    if (!isNoiseProposal(c.title, c.body)) continue;
    rejectCandidate(store, c.id, NOISE_REJECT_REASON, "system:noise-heuristic");
    ids.push(c.id);
    titles.push(c.title);
  }
  return { rejected: ids.length, ids, titles };
}
