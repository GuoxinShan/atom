/**
 * Done gate: close Needs-you cards that already shipped (repo progress) or
 * were already triaged (Desk history).
 *
 * Pipeline: extract → noise/merge → Done gate → theme tag → Needs you.
 * Fail-open: missing snapshot / path / git → do not drop on repo evidence.
 * Hit → `decision_rejected` reason `already_done` (off Needs-you).
 */

import { newId } from "../schema/ids.js";
import type { CandidateProposal, CandidateView, Ref } from "../schema/types.js";
import { EventStore } from "../store/events.js";
import { projectCandidates } from "../store/candidates.js";
import { loadGroupingWorkspaces } from "../store/needs-groups.js";
import { loadProgressSnapshot } from "./progress-snapshot.js";
import {
  matchCandidateToDone,
  type DoneHistoryItem,
  type DoneHit,
  type DoneMatchContext,
} from "./done-match.js";
import { listOpenSuggested } from "./merge-sweep.js";

export const ALREADY_DONE_REASON = "already_done";
export const ALREADY_DONE_LABEL = "已在仓库/历史进度关闭";
export const DONE_GATE_ACTOR = "system:done-gate";
export const REOPEN_ACTOR = "user:local";

export type DoneGateClose = {
  id: string;
  title: string;
  via: DoneHit["via"];
  reason: string;
  evidenceTitle: string;
};

export type DoneSweepResult = {
  apply: boolean;
  considered: number;
  closed: number;
  skipped: number;
  failOpen: boolean;
  snapshotMissing: boolean;
  items: DoneGateClose[];
};

export function isAlreadyDoneReason(reason: string | undefined): boolean {
  return (reason ?? "").trim().toLowerCase() === ALREADY_DONE_REASON;
}

export function doneGateToDetail(hit: DoneHit): Record<string, unknown> {
  return {
    action: "already_done",
    fail_open: false,
    via: hit.via,
    reason: hit.reason,
    evidence: hit.evidence,
  };
}

export function historyFromStore(store: EventStore): DoneHistoryItem[] {
  const out: DoneHistoryItem[] = [];
  for (const c of projectCandidates(store)) {
    if (c.keep_open) continue;
    if (c.merged_into) continue;
    if (c.status !== "accepted" && c.status !== "rejected" && c.status !== "merged") continue;
    out.push({
      id: c.id,
      title: c.title,
      body: c.body,
      refs: c.refs.map((r) => r.token),
      status: c.status,
      ...(c.theme ? { theme: c.theme } : {}),
      ...(c.project ? { project: c.project } : {}),
      ...(c.tags ? { tags: c.tags } : {}),
    });
  }
  return out;
}

export function loadDoneContext(store: EventStore, repoRoot?: string): DoneMatchContext {
  const root = repoRoot ?? "";
  return {
    snapshot: root ? loadProgressSnapshot(root) : null,
    history: historyFromStore(store),
    workspaces: root ? loadGroupingWorkspaces(root) : [],
  };
}

export function rememberDoneHistory(ctx: DoneMatchContext, item: DoneHistoryItem): void {
  ctx.history.push(item);
}

export function appendAlreadyDone(
  store: EventStore,
  candidate: { id: string; title: string; refs: Ref[] },
  hit: DoneHit
): void {
  store.append({
    type: "decision_rejected",
    subject_id: candidate.id,
    summary: `already_done: ${candidate.title}`,
    detail: {
      reason: ALREADY_DONE_REASON,
      reason_label: ALREADY_DONE_LABEL,
      disposition: ALREADY_DONE_REASON,
      evidence: hit.evidence,
      done_gate: doneGateToDetail(hit),
    },
    refs: candidate.refs,
    actor: DONE_GATE_ACTOR,
  });
}

export function reopenCandidate(store: EventStore, candidateId: string, note?: string): CandidateView {
  const found = projectCandidates(store).find((c) => c.id === candidateId);
  if (!found) throw new Error(`Candidate not found: ${candidateId}`);
  if (found.status === "suggested") return found;
  if (found.disposition !== ALREADY_DONE_REASON && !isAlreadyDoneReason(found.reject_reason)) {
    throw new Error(`Only already_done items can be reopened: ${candidateId}`);
  }
  store.append({
    type: "decision_reopened",
    subject_id: candidateId,
    summary: `reopened: ${found.title}`,
    detail: {
      note: note ?? "仍要我跟",
      keep_open: true,
      previous_reason: found.reject_reason ?? ALREADY_DONE_REASON,
    },
    refs: found.refs,
    actor: REOPEN_ACTOR,
  });
  const live = projectCandidates(store).find((c) => c.id === candidateId);
  if (!live) throw new Error(`Candidate missing after reopen: ${candidateId}`);
  return live;
}

function proposalRefs(p: Pick<CandidateProposal, "refs">): string[] {
  return p.refs.map((r) => r.token);
}

export function matchProposalToDone(
  p: Pick<CandidateProposal, "title" | "body" | "refs" | "theme" | "project" | "tags"> & { id?: string },
  ctx: DoneMatchContext
): DoneHit | null {
  const verdict = matchCandidateToDone(
    {
      id: p.id,
      title: p.title,
      body: p.body,
      refs: proposalRefs(p),
      theme: p.theme,
      project: p.project,
      tags: p.tags,
    },
    ctx
  );
  return verdict.hit ? verdict : null;
}

export function applyDoneGateToSuggested(
  store: EventStore,
  opts?: { apply?: boolean; repoRoot?: string; ctx?: DoneMatchContext }
): DoneSweepResult {
  const apply = opts?.apply !== false;
  const ctx = opts?.ctx ?? loadDoneContext(store, opts?.repoRoot);
  const snapshotMissing = !ctx.snapshot;
  const open = listOpenSuggested(store);
  const items: DoneGateClose[] = [];
  let skipped = 0;
  let failOpen = snapshotMissing || Boolean(ctx.snapshot?.workspaces.every((w) => w.fail_open && !w.items.length));

  for (const c of open) {
    if (c.keep_open) {
      skipped += 1;
      continue;
    }
    const hit = matchCandidateToDone(
      {
        id: c.id,
        title: c.title,
        body: c.body,
        refs: c.refs.map((r) => r.token),
        theme: c.theme,
        project: c.project,
        tags: c.tags,
      },
      ctx
    );
    if (!hit.hit) {
      if (hit.failOpen) failOpen = true;
      skipped += 1;
      continue;
    }
    items.push({
      id: c.id,
      title: c.title,
      via: hit.via,
      reason: hit.reason,
      evidenceTitle: hit.evidence.title,
    });
    if (apply) {
      appendAlreadyDone(store, c, hit);
      rememberDoneHistory(ctx, {
        id: c.id,
        title: c.title,
        body: c.body,
        refs: c.refs.map((r) => r.token),
        status: "rejected",
        ...(c.theme ? { theme: c.theme } : {}),
        ...(c.project ? { project: c.project } : {}),
        ...(c.tags ? { tags: c.tags } : {}),
      });
      console.log(`[done-gate] already_done ${c.id}: ${c.title} — ${hit.reason}`);
    }
  }

  return {
    apply,
    considered: open.length,
    closed: items.length,
    skipped,
    failOpen,
    snapshotMissing,
    items,
  };
}

export async function runDoneSweep(
  store: EventStore,
  opts?: { apply?: boolean; repoRoot?: string }
): Promise<DoneSweepResult> {
  const apply = opts?.apply === true;
  const ctx = loadDoneContext(store, opts?.repoRoot);
  const open = listOpenSuggested(store);
  const runId = apply ? newId("agent") : undefined;
  if (apply && runId) {
    store.append({
      type: "agent_started",
      subject_id: runId,
      summary: `done-sweep start: open=${open.length}`,
      detail: { kind: "done-sweep", apply: true, open: open.length },
      actor: DONE_GATE_ACTOR,
    });
  }

  try {
    const result = applyDoneGateToSuggested(store, { apply, repoRoot: opts?.repoRoot, ctx });
    if (apply && runId) {
      store.append({
        type: "agent_completed",
        subject_id: runId,
        summary: `done-sweep done: closed=${result.closed}`,
        detail: {
          kind: "done-sweep",
          apply: true,
          considered: result.considered,
          closed: result.closed,
          skipped: result.skipped,
          fail_open: result.failOpen,
          snapshot_missing: result.snapshotMissing,
        },
        actor: DONE_GATE_ACTOR,
      });
    }
    return result;
  } catch (err) {
    if (apply && runId) {
      store.append({
        type: "agent_failed",
        subject_id: runId,
        summary: "done-sweep failed",
        detail: { kind: "done-sweep", error: (err as Error).message },
        actor: DONE_GATE_ACTOR,
      });
    }
    throw err;
  }
}
