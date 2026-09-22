import fs from "node:fs";
import path from "node:path";
import { EventStore } from "../store/events.js";
import { projectCandidates } from "../store/candidates.js";
import { newId } from "../schema/ids.js";
import type {
  Ref,
  SpecDraft,
  SpecView,
  SpecReviewStatus,
  HandoffPack,
  CodingAgent,
  EventRecord,
} from "../schema/types.js";
import { LeadAgent, type RouteDecision } from "../agents/lead.js";
import {
  LayaClient,
  layaModelRouteToDetail,
  type LayaModelRoute,
} from "../agents/laya.js";

export function specStageLabel(status: SpecReviewStatus): string {
  if (status === "approved") return "已批准";
  if (status === "handed_off") return "已派 Lead";
  return "spec 待审";
}

function parseRefs(raw: string): Ref[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as Ref[]) : [];
  } catch {
    return [];
  }
}

function parseDetail(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function criteriaFrom(detail: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(detail.acceptance_criteria)) return undefined;
  return detail.acceptance_criteria.map(String);
}

function overlaySpecContent(cur: SpecView, detail: Record<string, unknown>, at: string): void {
  if (typeof detail.title === "string" && detail.title.trim()) cur.title = detail.title.trim();
  if (typeof detail.body === "string") cur.body = detail.body;
  const criteria = criteriaFrom(detail);
  if (criteria) cur.acceptance_criteria = criteria;
  if (typeof detail.note === "string" && detail.note.trim()) cur.note = detail.note.trim();
  cur.updated_at = at;
}

function packFromHandoffEvent(ev: EventRecord): HandoffPack {
  const detail = parseDetail(ev.detail_json);
  const target = detail.target === "grok-cli" || detail.target === "cursor" ? detail.target : "file";
  return {
    id: ev.subject_id,
    spec_id: String(detail.spec_id ?? ""),
    candidate_id: String(detail.candidate_id ?? ""),
    path: String(detail.path ?? ""),
    target,
  };
}

/** Latest handoff_exported for this spec (or candidate id in detail). */
export function findHandoffForSpec(store: EventStore, specOrCandidateId: string): EventRecord | undefined {
  const events = store.list({ type: "handoff_exported", limit: 2000 });
  let found: EventRecord | undefined;
  for (const ev of events) {
    const detail = parseDetail(ev.detail_json);
    const specId = String(detail.spec_id ?? "");
    const candId = String(detail.candidate_id ?? "");
    if (ev.subject_id === specOrCandidateId || specId === specOrCandidateId || candId === specOrCandidateId) {
      found = ev;
    }
  }
  return found;
}

export function handoffPackFor(store: EventStore, specOrCandidateId: string): HandoffPack | undefined {
  const ev = findHandoffForSpec(store, specOrCandidateId);
  return ev ? packFromHandoffEvent(ev) : undefined;
}

export function listSpecDrafts(store: EventStore): SpecView[] {
  const drafts = store.list({ type: "spec_drafted", limit: 2000 });
  const returned = store.list({ type: "spec_returned", limit: 2000 });
  const approved = store.list({ type: "spec_approved", limit: 2000 });
  const handoffs = store.list({ type: "handoff_exported", limit: 2000 });
  const map = new Map<string, SpecView>();

  for (const e of drafts) {
    const detail = parseDetail(e.detail_json);
    const refs = parseRefs(e.refs_json);
    map.set(e.subject_id, {
      id: e.subject_id,
      candidate_id: String(detail.candidate_id ?? ""),
      title: String(detail.title ?? e.summary),
      body: String(detail.body ?? ""),
      acceptance_criteria: criteriaFrom(detail) ?? [],
      refs,
      review_status: "pending",
      stage_label: specStageLabel("pending"),
      updated_at: e.created_at,
      note: typeof detail.note === "string" && detail.note.trim() ? detail.note.trim() : undefined,
    });
  }

  const extras = [...returned, ...approved, ...handoffs].sort((a, b) => {
    const t = a.created_at.localeCompare(b.created_at);
    return t !== 0 ? t : a.id.localeCompare(b.id);
  });

  for (const e of extras) {
    const detail = parseDetail(e.detail_json);
    if (e.type === "handoff_exported") {
      const specId = String(detail.spec_id ?? "");
      const cur = map.get(specId);
      if (!cur) continue;
      cur.review_status = "handed_off";
      cur.stage_label = specStageLabel("handed_off");
      cur.handoff_id = e.subject_id;
      cur.handoff_path = String(detail.path ?? "");
      cur.handoff_target = String(detail.target ?? "file");
      cur.ran = Boolean(detail.ran);
      cur.updated_at = e.created_at;
      continue;
    }
    const cur = map.get(e.subject_id);
    if (!cur || cur.review_status === "handed_off") continue;
    overlaySpecContent(cur, detail, e.created_at);
    if (e.type === "spec_approved") {
      cur.review_status = "approved";
      cur.stage_label = specStageLabel("approved");
    } else if (e.type === "spec_returned") {
      cur.review_status = "returned";
      cur.stage_label = specStageLabel("returned");
    }
  }

  return [...map.values()];
}

export function findSpecForCandidate(store: EventStore, candidateId: string): SpecView | undefined {
  return listSpecDrafts(store)
    .filter((s) => s.candidate_id === candidateId)
    .at(-1);
}

export function findSpec(store: EventStore, specOrCandidateId: string): SpecView {
  const bySpec = listSpecDrafts(store).find((s) => s.id === specOrCandidateId);
  if (bySpec) return bySpec;
  const byCand = findSpecForCandidate(store, specOrCandidateId);
  if (byCand) return byCand;
  // Auto-draft if only accepted candidate exists without spec (legacy)
  const cand = projectCandidates(store).find((c) => c.id === specOrCandidateId);
  if (cand && cand.status === "accepted") {
    return {
      id: newId("spec"),
      candidate_id: cand.id,
      title: cand.title,
      body: cand.body,
      acceptance_criteria: [
        `Given cited evidence, «${cand.title}» is implemented end-to-end.`,
        "Each criterion is testable without tribal knowledge.",
      ],
      refs: cand.refs,
      review_status: "pending",
      stage_label: specStageLabel("pending"),
      updated_at: cand.updated_at,
    };
  }
  throw new Error(`No spec/candidate found: ${specOrCandidateId}`);
}

function writeHandoffMarkdown(
  repoRoot: string,
  packId: string,
  spec: SpecDraft,
  extra?: { briefing?: string; route?: RouteDecision }
): string {
  const dir = path.join(repoRoot, "out", "handoffs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${packId}.md`);
  const route = extra?.route;
  const lines = [
    `# Handoff · ${spec.title}`,
    "",
    `- pack: \`${packId}\``,
    `- spec: \`${spec.id}\``,
    `- candidate: \`${spec.candidate_id}\``,
    route
      ? `- workspace: \`${route.workspace.id}\` @ \`${route.workspace.path}\``
      : "",
    "",
    "## Goal",
    "",
    spec.body || spec.title,
    "",
    "## Acceptance criteria",
    "",
    ...spec.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`),
    "",
    "## Evidence refs (mandatory)",
    "",
    ...spec.refs.map((r) => `- \`${r.token}\`${r.digest ? ` — ${r.digest}` : ""}`),
    "",
    extra?.briefing ? extra.briefing : "",
    extra?.briefing ? "" : "",
    "## Instructions for coding agent",
    "",
    "- Implement only what the criteria require.",
    "- Do not invent requirements without a ref.",
    "- When done, write a short evidence note under `out/evidence/` and tell ATOM via `pnpm atom evidence <packId> --path <file>`.",
    "- This pack is handoff-ready. Coding does not start unless `--run` is passed.",
    "",
  ].filter((line, i, arr) => !(line === "" && arr[i - 1] === ""));
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  return file;
}

export async function exportHandoff(
  store: EventStore,
  repoRoot: string,
  specOrCandidateId: string,
  coding?: CodingAgent,
  opts?: { run?: boolean; target?: "grok-cli" | "cursor" | "file"; laya?: LayaClient | false }
): Promise<HandoffPack> {
  const spec = findSpec(store, specOrCandidateId);
  const existing = handoffPackFor(store, spec.id) ?? handoffPackFor(store, spec.candidate_id);
  if (existing) return existing;

  const target = opts?.target ?? (coding ? "grok-cli" : "file");
  const lead = new LeadAgent(repoRoot);
  const route = lead.routeSpec(spec);
  console.log(`[lead] route → ${route.workspace.id} (${route.reason})`);

  const laya = opts?.laya === false ? null : opts?.laya ?? LayaClient.fromEnv();
  let modelRoute: LayaModelRoute | undefined;
  if (laya?.isEnabled()) {
    const summary = [spec.title, spec.body, ...spec.acceptance_criteria]
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n");
    modelRoute = await laya.routeModel(summary);
    if (modelRoute.failOpen) {
      console.warn(`[lead] Laya route-model fail-open (${modelRoute.reason})`);
    } else {
      console.log(
        `[lead] laya model-route → ${modelRoute.model ?? modelRoute.intensity} (${modelRoute.intensity}, conf=${modelRoute.confidence ?? "?"})`
      );
    }
  }

  const briefing = lead.briefing(route, spec, modelRoute);

  let pack: HandoffPack;
  if (coding) {
    // Prefer coding agent that accepts workDir/briefing if available
    const anyCoding = coding as CodingAgent & {
      handoff: (spec: SpecDraft, opts?: { run?: boolean; workDir?: string; briefing?: string }) => Promise<HandoffPack>;
    };
    pack = await anyCoding.handoff(spec, {
      run: opts?.run,
      workDir: route.workspace.path,
      briefing,
    });
  } else {
    const packId = newId("handoff");
    const filePath = writeHandoffMarkdown(repoRoot, packId, spec, { briefing, route });
    pack = {
      id: packId,
      spec_id: spec.id,
      candidate_id: spec.candidate_id,
      path: filePath,
      target: "file",
    };
  }
  pack.target = target === "file" ? "file" : pack.target;

  store.append({
    type: "handoff_exported",
    subject_id: pack.id,
    summary: `handoff: ${spec.title}`,
    detail: {
      spec_id: spec.id,
      candidate_id: spec.candidate_id,
      path: pack.path,
      target: pack.target,
      ran: Boolean(opts?.run),
      route: {
        workspace_id: route.workspace.id,
        machine: route.machine,
        path: route.workspace.path,
        confidence: route.confidence,
        reason: route.reason,
      },
      ...(modelRoute ? { laya_model_route: layaModelRouteToDetail(modelRoute) } : {}),
    },
    refs: spec.refs,
    actor: coding ? `agent:${coding.id}` : "system",
  });

  store.append({
    type: "agent_completed",
    subject_id: pack.id,
    summary: `handoff exported (${pack.target})`,
    detail: { agent: coding?.id ?? "file", path: pack.path, ran: Boolean(opts?.run) },
    refs: spec.refs,
    actor: coding ? `agent:${coding.id}` : "system",
  });

  return pack;
}

export function attachEvidence(
  store: EventStore,
  handoffId: string,
  evidencePath: string,
  kind: "test" | "screenshot" | "log" | "note" = "note"
): string {
  const evidenceId = newId("evidence");
  const handoffs = store.list({ type: "handoff_exported", subject_id: handoffId, limit: 1 });
  const refs = handoffs[0] ? (JSON.parse(handoffs[0].refs_json) as Ref[]) : [];
  store.append({
    type: "evidence_attached",
    subject_id: evidenceId,
    summary: `evidence (${kind}): ${path.basename(evidencePath)}`,
    detail: { handoff_id: handoffId, path: evidencePath, kind },
    refs,
    actor: "user:local",
  });
  return evidenceId;
}
