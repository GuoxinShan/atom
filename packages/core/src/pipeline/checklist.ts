import { EventStore } from "../store/events.js";
import { projectCandidates } from "../store/candidates.js";
import { newId } from "../schema/ids.js";
import type { EventRecord, Ref } from "../schema/types.js";
import { findSpec, listSpecDrafts } from "./handoff.js";

export const CHECKLIST_KEYS = [
  "tests_green",
  "evidence_linked",
  "summary_written",
  "human_gate_ack",
] as const;
export type ChecklistKey = (typeof CHECKLIST_KEYS)[number];

export interface ChecklistItemTemplate {
  key: ChecklistKey;
  required: boolean;
  label: string;
}

/** v0 hardcoded template; make configurable later. */
export const DEFAULT_CHECKLIST_TEMPLATE: ChecklistItemTemplate[] = [
  { key: "tests_green", required: true, label: "Tests green" },
  {
    key: "evidence_linked",
    required: true,
    label: "At least one evidence_attached for this subject",
  },
  {
    key: "summary_written",
    required: true,
    label: "Short PR body / handoff note present",
  },
  {
    key: "human_gate_ack",
    required: true,
    label: "Human gate acknowledgement (explicit --ack, never auto)",
  },
];

export interface ChecklistItemState {
  id: string;
  key: ChecklistKey;
  required: boolean;
  label: string;
  done: boolean;
  note?: string;
  evidence_ref?: string;
}

export interface ChecklistView {
  subjectId: string;
  candidateId?: string;
  handoffId?: string;
  specId?: string;
  title: string;
  items: ChecklistItemState[];
  passed: boolean;
  remainingRequired: ChecklistKey[];
  awaitingHumanAck: boolean;
  evidenceCount: number;
  hasSummary: boolean;
}

export interface StageSubject {
  subjectId: string;
  candidateId?: string;
  handoffId?: string;
  specId?: string;
  title: string;
  refs: Ref[];
}

function parseDetail(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseRefs(raw: string): Ref[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as Ref[]) : [];
  } catch {
    return [];
  }
}

function isChecklistKey(s: string): s is ChecklistKey {
  return (CHECKLIST_KEYS as readonly string[]).includes(s);
}

function listType(store: EventStore, type: EventRecord["type"]): EventRecord[] {
  return store.list({ type, limit: 5000 });
}

function latestHandoffForCandidate(store: EventStore, candidateId: string): EventRecord | undefined {
  return listType(store, "handoff_exported")
    .filter((e) => String(parseDetail(e.detail_json).candidate_id ?? "") === candidateId)
    .at(-1);
}

function latestHandoffById(store: EventStore, handoffId: string): EventRecord | undefined {
  return store.list({ type: "handoff_exported", subject_id: handoffId, limit: 1 }).at(-1);
}

function candidateTitle(store: EventStore, candidateId: string | undefined): string | undefined {
  if (!candidateId) return undefined;
  return projectCandidates(store).find((c) => c.id === candidateId)?.title;
}

/**
 * Resolve a handoff, spec, or candidate id to a stage subject.
 * Prefers an existing checklist subject so later handoffs don't fork the feed.
 */
export function resolveStageSubject(store: EventStore, id: string): StageSubject {
  const existing = findChecklistStarted(store, id);
  if (existing) {
    const detail = parseDetail(existing.detail_json);
    const candidateId = detail.candidate_id ? String(detail.candidate_id) : undefined;
    const storedHandoff = detail.handoff_id ? String(detail.handoff_id) : undefined;
    const handoffId =
      storedHandoff ||
      (candidateId ? latestHandoffForCandidate(store, candidateId)?.subject_id : undefined);
    return {
      subjectId: existing.subject_id,
      candidateId,
      handoffId,
      specId: detail.spec_id ? String(detail.spec_id) : undefined,
      title: String(detail.title ?? existing.summary),
      refs: parseRefs(existing.refs_json),
    };
  }

  const handoff = latestHandoffById(store, id);
  if (handoff) {
    const detail = parseDetail(handoff.detail_json);
    const candidateId = detail.candidate_id ? String(detail.candidate_id) : undefined;
    return {
      subjectId: handoff.subject_id,
      candidateId,
      handoffId: handoff.subject_id,
      specId: detail.spec_id ? String(detail.spec_id) : undefined,
      title: candidateTitle(store, candidateId) ?? handoff.summary.replace(/^handoff:\s*/, ""),
      refs: parseRefs(handoff.refs_json),
    };
  }

  const spec = listSpecDrafts(store).find((s) => s.id === id);
  if (spec) {
    const ho = latestHandoffForCandidate(store, spec.candidate_id);
    const cand = projectCandidates(store).find((c) => c.id === spec.candidate_id);
    const subjectId = ho?.subject_id ?? spec.candidate_id;
    return {
      subjectId,
      candidateId: spec.candidate_id,
      handoffId: ho?.subject_id,
      specId: spec.id,
      title: spec.title,
      refs: spec.refs.length ? spec.refs : cand?.refs ?? [],
    };
  }

  const cand = projectCandidates(store).find((c) => c.id === id);
  if (cand) {
    const ho = latestHandoffForCandidate(store, cand.id);
    let specId: string | undefined;
    try {
      specId = findSpec(store, cand.id).id;
    } catch {
      specId = undefined;
    }
    return {
      subjectId: ho?.subject_id ?? cand.id,
      candidateId: cand.id,
      handoffId: ho?.subject_id,
      specId,
      title: cand.title,
      refs: ho ? parseRefs(ho.refs_json) : cand.refs,
    };
  }

  throw new Error(`No handoff/spec/candidate found: ${id}`);
}

function findChecklistStarted(store: EventStore, id: string): EventRecord | undefined {
  return listType(store, "pr_checklist_started")
    .filter((e) => {
      if (e.subject_id === id) return true;
      const d = parseDetail(e.detail_json);
      return (
        String(d.candidate_id ?? "") === id ||
        String(d.handoff_id ?? "") === id ||
        String(d.spec_id ?? "") === id
      );
    })
    .at(-1);
}

function evidenceEventsFor(store: EventStore, subject: StageSubject): EventRecord[] {
  const ids = new Set(
    [subject.subjectId, subject.handoffId, subject.candidateId].filter(Boolean) as string[]
  );
  if (subject.candidateId) {
    for (const ho of listType(store, "handoff_exported")) {
      if (String(parseDetail(ho.detail_json).candidate_id ?? "") === subject.candidateId) {
        ids.add(ho.subject_id);
      }
    }
  }
  return listType(store, "evidence_attached").filter((e) => {
    const d = parseDetail(e.detail_json);
    const hid = String(d.handoff_id ?? "");
    const cid = String(d.candidate_id ?? "");
    return ids.has(e.subject_id) || (hid && ids.has(hid)) || (cid && ids.has(cid));
  });
}

function summaryPresent(store: EventStore, subject: StageSubject, extraNote?: string): boolean {
  if (extraNote && extraNote.trim()) return true;
  if (subject.handoffId && latestHandoffById(store, subject.handoffId)) return true;
  if (subject.specId) {
    const spec = listSpecDrafts(store).find((s) => s.id === subject.specId);
    if (spec && (spec.body.trim() || spec.title.trim())) return true;
  }
  if (subject.candidateId) {
    const cand = projectCandidates(store).find((c) => c.id === subject.candidateId);
    if (cand && cand.body.trim()) return true;
  }
  return false;
}

function itemDoneEvents(store: EventStore, subjectId: string): EventRecord[] {
  return listType(store, "pr_checklist_item_done").filter((e) => {
    const d = parseDetail(e.detail_json);
    return String(d.parent_id ?? d.subject_id ?? "") === subjectId;
  });
}

function hasPassed(store: EventStore, subjectId: string): boolean {
  return listType(store, "pr_checklist_passed").some((e) => e.subject_id === subjectId);
}

function foldItems(
  started: EventRecord,
  done: EventRecord[]
): ChecklistItemState[] {
  const detail = parseDetail(started.detail_json);
  const rawItems = Array.isArray(detail.items) ? detail.items : [];
  const byKey = new Map<string, EventRecord>();
  for (const ev of done) {
    const d = parseDetail(ev.detail_json);
    const key = String(d.key ?? "");
    if (key) byKey.set(key, ev);
  }

  const items: ChecklistItemState[] = [];
  for (const raw of rawItems) {
    const row = raw as Record<string, unknown>;
    const key = String(row.key ?? "");
    if (!isChecklistKey(key)) continue;
    const doneEv = byKey.get(key);
    const doneDetail = doneEv ? parseDetail(doneEv.detail_json) : {};
    items.push({
      id: String(row.id ?? ""),
      key,
      required: row.required !== false,
      label: String(row.label ?? key),
      done: Boolean(doneEv),
      note: doneDetail.note ? String(doneDetail.note) : undefined,
      evidence_ref: doneDetail.evidence_ref ? String(doneDetail.evidence_ref) : undefined,
    });
  }
  return items;
}

export function getChecklist(store: EventStore, id: string): ChecklistView {
  const subject = resolveStageSubject(store, id);
  const started = findChecklistStarted(store, subject.subjectId);
  const evidence = evidenceEventsFor(store, subject);
  const hasSummary = summaryPresent(store, subject);
  const passed = hasPassed(store, subject.subjectId);

  const items = started
    ? foldItems(started, itemDoneEvents(store, subject.subjectId))
    : DEFAULT_CHECKLIST_TEMPLATE.map((t) => ({
        id: "",
        key: t.key,
        required: t.required,
        label: t.label,
        done: false,
      }));

  const remainingRequired = items.filter((i) => i.required && !i.done).map((i) => i.key);
  const awaitingHumanAck =
    remainingRequired.length === 1 && remainingRequired[0] === "human_gate_ack";

  return {
    subjectId: subject.subjectId,
    candidateId: subject.candidateId,
    handoffId: subject.handoffId,
    specId: subject.specId,
    title: subject.title,
    items,
    passed,
    remainingRequired,
    awaitingHumanAck,
    evidenceCount: evidence.length,
    hasSummary,
  };
}

/** Fold started checklists; newest subject first. */
export function listChecklists(store: EventStore): ChecklistView[] {
  const started = listType(store, "pr_checklist_started");
  const seen = new Set<string>();
  const out: ChecklistView[] = [];
  for (const e of [...started].reverse()) {
    if (seen.has(e.subject_id)) continue;
    seen.add(e.subject_id);
    out.push(getChecklist(store, e.subject_id));
  }
  return out;
}

export function formatChecklist(view: ChecklistView): string {
  const lines = [
    `checklist ${view.subjectId}${view.title ? ` · ${view.title}` : ""}`,
    view.handoffId ? `handoff: ${view.handoffId}` : "",
    view.candidateId ? `candidate: ${view.candidateId}` : "",
    `evidence_attached: ${view.evidenceCount}`,
    `summary: ${view.hasSummary ? "yes" : "no"}`,
    `passed: ${view.passed ? "yes" : "no"}`,
    "",
  ].filter((l, i, arr) => l !== "" || arr[i - 1] !== "");

  for (const item of view.items) {
    const mark = item.done ? "x" : " ";
    const extra =
      item.key === "human_gate_ack" && !item.done ? "  (requires --ack)" : "";
    const note = item.note ? ` — ${item.note}` : "";
    lines.push(`- [${mark}] ${item.key}${extra}${note}`);
  }

  if (view.passed) {
    lines.push("", "status: passed");
  } else if (view.awaitingHumanAck) {
    lines.push(
      "",
      "status: all required items done except human_gate_ack",
      "next: pnpm atom checklist-done <id> human_gate_ack --ack"
    );
  } else if (!findStartedFlag(view)) {
    lines.push("", "status: not started");
  } else {
    lines.push("", `status: in_progress (${view.remainingRequired.join(", ") || "none"} remaining)`);
  }
  return lines.join("\n");
}

function findStartedFlag(view: ChecklistView): boolean {
  return view.items.some((i) => i.id);
}

export function startChecklist(store: EventStore, id: string): ChecklistView {
  const existing = getChecklist(store, id);
  if (findStartedFlag(existing)) return existing;

  const subject = resolveStageSubject(store, id);
  const items = DEFAULT_CHECKLIST_TEMPLATE.map((t) => ({
    id: newId("chkitem"),
    key: t.key,
    required: t.required,
    label: t.label,
  }));

  store.append({
    type: "pr_checklist_started",
    subject_id: subject.subjectId,
    summary: `checklist started: ${subject.title}`,
    detail: {
      items,
      candidate_id: subject.candidateId ?? "",
      handoff_id: subject.handoffId ?? "",
      spec_id: subject.specId ?? "",
      title: subject.title,
      template: "v0",
    },
    refs: subject.refs,
    actor: "user:local",
  });

  return getChecklist(store, subject.subjectId);
}

export function completeChecklistItem(
  store: EventStore,
  id: string,
  itemKey: string,
  opts?: { note?: string; ack?: boolean; evidenceRef?: string }
): ChecklistView {
  if (!isChecklistKey(itemKey)) {
    throw new Error(`Unknown checklist item: ${itemKey} (want ${CHECKLIST_KEYS.join(", ")})`);
  }

  let view = getChecklist(store, id);
  if (!findStartedFlag(view)) {
    view = startChecklist(store, id);
  }
  if (view.passed) return view;

  const item = view.items.find((i) => i.key === itemKey);
  if (!item) throw new Error(`Checklist has no item ${itemKey}`);
  if (item.done) {
    return maybeAppendPassed(store, view);
  }

  if (itemKey === "human_gate_ack" && !opts?.ack) {
    throw new Error("human_gate_ack requires --ack (never auto)");
  }

  if (itemKey === "evidence_linked" && view.evidenceCount < 1) {
    throw new Error(
      "evidence_linked needs at least one evidence_attached for this subject — run `pnpm atom evidence <handoffId> --path <file>` first"
    );
  }

  if (itemKey === "summary_written" && !summaryPresent(store, resolveStageSubject(store, id), opts?.note)) {
    throw new Error("summary_written needs --note or an existing handoff/spec body");
  }

  const evidence = evidenceEventsFor(store, resolveStageSubject(store, id));
  const evidenceRef = opts?.evidenceRef ?? evidence.at(-1)?.subject_id;

  store.append({
    type: "pr_checklist_item_done",
    subject_id: item.id || newId("chkitem"),
    summary: `checklist item done: ${itemKey}`,
    detail: {
      key: itemKey,
      note: opts?.note ?? "",
      evidence_ref: itemKey === "evidence_linked" ? evidenceRef ?? "" : opts?.evidenceRef ?? "",
      parent_id: view.subjectId,
      ack: itemKey === "human_gate_ack" ? true : undefined,
    },
    refs: resolveStageSubject(store, id).refs,
    actor: "user:local",
  });

  const next = getChecklist(store, view.subjectId);
  return maybeAppendPassed(store, next);
}

function maybeAppendPassed(store: EventStore, view: ChecklistView): ChecklistView {
  if (view.passed) return view;
  if (!findStartedFlag(view)) return view;
  if (view.remainingRequired.length > 0) return view;
  const subject = resolveStageSubject(store, view.subjectId);
  store.append({
    type: "pr_checklist_passed",
    subject_id: view.subjectId,
    summary: `checklist passed: ${subject.title}`,
    detail: {
      candidate_id: subject.candidateId ?? "",
      handoff_id: subject.handoffId ?? "",
      spec_id: subject.specId ?? "",
      items: view.items.map((i) => i.key),
    },
    refs: subject.refs,
    actor: "user:local",
  });
  return getChecklist(store, view.subjectId);
}

export function openPr(
  store: EventStore,
  id: string,
  opts: { url: string; branch?: string; force?: boolean }
): { prId: string; forced: boolean; view: ChecklistView } {
  const url = opts.url.trim();
  if (!url) throw new Error("pr-open requires --url <prUrl>");

  const subject = resolveStageSubject(store, id);
  const view = getChecklist(store, subject.subjectId);
  const forced = Boolean(opts.force) && !view.passed;
  if (!view.passed && !opts.force) {
    throw new Error(
      `checklist has not passed for ${subject.subjectId}; pass --force to append pr_opened anyway`
    );
  }
  if (forced) {
    console.warn(
      `WARNING: appending pr_opened without pr_checklist_passed for ${subject.subjectId} (--force)`
    );
  }

  const prId = newId("pr");
  const refs: Ref[] = [
    { token: url, kind: "url" },
    ...subject.refs.filter((r) => r.token !== url),
  ];
  if (opts.branch) {
    refs.push({ token: `git:${opts.branch}`, kind: "git" });
  }

  store.append({
    type: "pr_opened",
    subject_id: prId,
    summary: `pr opened: ${url}`,
    detail: {
      url,
      branch: opts.branch ?? "",
      handoff_id: subject.handoffId ?? "",
      candidate_id: subject.candidateId ?? "",
      checklist_subject: subject.subjectId,
      forced,
    },
    refs,
    actor: "user:local",
  });

  return { prId, forced, view: getChecklist(store, subject.subjectId) };
}
