import { EventStore } from "../store/events.js";
import { projectCandidates } from "../store/candidates.js";
import { newId } from "../schema/ids.js";

export function approveCandidate(
  store: EventStore,
  candidateId: string,
  note?: string
): { specId: string } {
  const found = projectCandidates(store).find((c) => c.id === candidateId);
  if (!found) throw new Error(`Candidate not found: ${candidateId}`);
  store.append({
    type: "decision_accepted",
    subject_id: candidateId,
    summary: `accepted: ${found.title}`,
    detail: { note: note ?? "" },
    refs: found.refs,
    actor: "user:local",
  });

  // Event loop: acceptance wakes a draft spec (still human-refinable).
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
  return { specId };
}

export function rejectCandidate(
  store: EventStore,
  candidateId: string,
  reason?: string
): void {
  const found = projectCandidates(store).find((c) => c.id === candidateId);
  if (!found) throw new Error(`Candidate not found: ${candidateId}`);
  store.append({
    type: "decision_rejected",
    subject_id: candidateId,
    summary: `rejected: ${found.title}`,
    detail: { reason: reason ?? "" },
    refs: found.refs,
    actor: "user:local",
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
