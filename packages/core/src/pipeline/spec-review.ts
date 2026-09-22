/**
 * Human spec review after candidate accept, before an explicit Lead handoff.
 *
 * Accept writes the draft. Review (approve / return) is a separate gate.
 * 「派给 Lead」 is a third, confirm-gated action that writes a local pack.
 * It does not start coding unless `run: true` (CLI `--run` only).
 */

import { EventStore } from "../store/events.js";
import type { CodingAgent, HandoffPack, SpecView } from "../schema/types.js";
import type { LayaClient } from "../agents/laya.js";
import {
  exportHandoff,
  findSpec,
  findSpecForCandidate,
  handoffPackFor,
  listSpecDrafts,
} from "./handoff.js";

const TITLE_MAX = 240;
const BODY_MAX = 12_000;
const CRITERION_MAX = 400;
const CRITERIA_MAX = 24;

export class SpecReviewError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "not_approved" | "not_editable"
  ) {
    super(message);
    this.name = "SpecReviewError";
  }
}

export type SpecPatch = {
  title?: string;
  body?: string;
  acceptance_criteria?: string[];
  note?: string;
};

export const HANDOFF_LIMITATION_FILE =
  "已写出本机交接包，未启动编码，未发云之家。";
export const HANDOFF_LIMITATION_REUSED = "已派过 Lead，未重复交接。";
export const HANDOFF_LIMITATION_RAN = "已写出交接包并启动编码（--run）。未发云之家。";

function clip(s: string, max: number): string {
  return s.trim().slice(0, max);
}

function sanitizeCriteria(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const row of raw) {
    const s = clip(String(row ?? ""), CRITERION_MAX);
    if (!s) continue;
    out.push(s);
    if (out.length >= CRITERIA_MAX) break;
  }
  return out;
}

function patchDetail(spec: SpecView, patch?: SpecPatch): Record<string, unknown> {
  const detail: Record<string, unknown> = {};
  if (patch?.title !== undefined) {
    const title = clip(patch.title, TITLE_MAX);
    if (title && title !== spec.title) detail.title = title;
  }
  if (patch?.body !== undefined) {
    const body = patch.body.slice(0, BODY_MAX);
    if (body !== spec.body) detail.body = body;
  }
  if (patch?.acceptance_criteria !== undefined) {
    const criteria = sanitizeCriteria(patch.acceptance_criteria) ?? [];
    const same =
      criteria.length === spec.acceptance_criteria.length &&
      criteria.every((c, i) => c === spec.acceptance_criteria[i]);
    if (!same) detail.acceptance_criteria = criteria;
  }
  if (patch?.note !== undefined) {
    const note = clip(patch.note, 400);
    if (note) detail.note = note;
  }
  return detail;
}

function resolvePersistedSpec(store: EventStore, specOrCandidateId: string): SpecView {
  const byId = listSpecDrafts(store).find((s) => s.id === specOrCandidateId);
  if (byId) return byId;
  const byCand = findSpecForCandidate(store, specOrCandidateId);
  if (byCand) return byCand;
  throw new SpecReviewError(`规格不存在：${specOrCandidateId}`, "not_found");
}

export function specsAwaitingReview(store: EventStore): SpecView[] {
  return listSpecDrafts(store).filter((s) => s.review_status !== "handed_off");
}

export function returnSpec(store: EventStore, specOrCandidateId: string, patch?: SpecPatch): SpecView {
  const spec = resolvePersistedSpec(store, specOrCandidateId);
  if (spec.review_status === "handed_off") {
    throw new SpecReviewError("已派 Lead，不能退回修改。", "not_editable");
  }
  const detail = patchDetail(spec, patch);
  store.append({
    type: "spec_returned",
    subject_id: spec.id,
    summary: `spec returned: ${String(detail.title ?? spec.title)}`,
    detail,
    refs: spec.refs,
    actor: "user:local",
  });
  return findSpec(store, spec.id);
}

export function approveSpec(store: EventStore, specOrCandidateId: string, patch?: SpecPatch): SpecView {
  const spec = resolvePersistedSpec(store, specOrCandidateId);
  if (spec.review_status === "handed_off") {
    return spec;
  }
  const detail = patchDetail(spec, patch);
  const contentChanged = Object.keys(detail).some((k) => k !== "note");
  if (spec.review_status === "approved" && !contentChanged && !detail.note) {
    return spec;
  }
  store.append({
    type: "spec_approved",
    subject_id: spec.id,
    summary: `spec approved: ${String(detail.title ?? spec.title)}`,
    detail,
    refs: spec.refs,
    actor: "user:local",
  });
  return findSpec(store, spec.id);
}

export type DispatchToLeadResult = {
  pack: HandoffPack;
  reused: boolean;
  ran: boolean;
  limitation: string;
  spec: SpecView;
};

/**
 * Explicit Lead handoff. Requires a human-approved spec.
 * Default writes a local markdown pack (no coding spawn, no Yunzhijia).
 * Repeated calls return the existing pack.
 */
export async function dispatchToLead(
  store: EventStore,
  repoRoot: string,
  specOrCandidateId: string,
  coding?: CodingAgent,
  opts?: { run?: boolean; target?: "grok-cli" | "cursor" | "file"; laya?: LayaClient | false }
): Promise<DispatchToLeadResult> {
  const spec = resolvePersistedSpec(store, specOrCandidateId);
  const existing = handoffPackFor(store, spec.id) ?? handoffPackFor(store, spec.candidate_id);
  if (existing) {
    return {
      pack: existing,
      reused: true,
      ran: false,
      limitation: HANDOFF_LIMITATION_REUSED,
      spec: findSpec(store, spec.id),
    };
  }
  if (spec.review_status !== "approved") {
    throw new SpecReviewError("规格尚未批准，不能派给 Lead。请先点「批准规格」。", "not_approved");
  }

  const run = Boolean(opts?.run);
  const target = opts?.target ?? (coding && run ? "grok-cli" : "file");
  const codingAgent = run || target === "grok-cli" || target === "cursor" ? coding : undefined;
  const pack = await exportHandoff(store, repoRoot, spec.id, codingAgent, {
    run,
    target,
    laya: opts?.laya,
  });
  return {
    pack,
    reused: false,
    ran: run,
    limitation: run ? HANDOFF_LIMITATION_RAN : HANDOFF_LIMITATION_FILE,
    spec: findSpec(store, spec.id),
  };
}
