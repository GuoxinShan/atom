import fs from "node:fs";
import path from "node:path";
import { EventStore } from "../store/events.js";
import { projectCandidates } from "../store/candidates.js";
import { newId } from "../schema/ids.js";
import type { Ref, SpecDraft, HandoffPack, CodingAgent } from "../schema/types.js";
import { LeadAgent } from "../agents/lead.js";

export function listSpecDrafts(store: EventStore): SpecDraft[] {
  const events = store.list({ type: "spec_drafted", limit: 500 });
  const out: SpecDraft[] = [];
  for (const e of events) {
    const detail = JSON.parse(e.detail_json) as {
      candidate_id?: string;
      title?: string;
      body?: string;
      acceptance_criteria?: string[];
    };
    const refs = JSON.parse(e.refs_json) as Ref[];
    out.push({
      id: e.subject_id,
      candidate_id: String(detail.candidate_id ?? ""),
      title: String(detail.title ?? e.summary),
      body: String(detail.body ?? ""),
      acceptance_criteria: Array.isArray(detail.acceptance_criteria)
        ? detail.acceptance_criteria.map(String)
        : [],
      refs,
    });
  }
  return out;
}

export function findSpecForCandidate(store: EventStore, candidateId: string): SpecDraft | undefined {
  return listSpecDrafts(store)
    .filter((s) => s.candidate_id === candidateId)
    .at(-1);
}

export function findSpec(store: EventStore, specOrCandidateId: string): SpecDraft {
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
    };
  }
  throw new Error(`No spec/candidate found: ${specOrCandidateId}`);
}

function writeHandoffMarkdown(repoRoot: string, packId: string, spec: SpecDraft): string {
  const dir = path.join(repoRoot, "out", "handoffs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${packId}.md`);
  const lines = [
    `# Handoff · ${spec.title}`,
    "",
    `- pack: \`${packId}\``,
    `- spec: \`${spec.id}\``,
    `- candidate: \`${spec.candidate_id}\``,
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
    "## Instructions for coding agent",
    "",
    "- Implement only what the criteria require.",
    "- Do not invent requirements without a ref.",
    "- When done, write a short evidence note under `out/evidence/` and tell ATOM via `pnpm atom evidence <packId> --path <file>`.",
    "",
  ];
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  return file;
}

export async function exportHandoff(
  store: EventStore,
  repoRoot: string,
  specOrCandidateId: string,
  coding?: CodingAgent,
  opts?: { run?: boolean; target?: "grok-cli" | "cursor" | "file" }
): Promise<HandoffPack> {
  const spec = findSpec(store, specOrCandidateId);
  const target = opts?.target ?? (coding ? "grok-cli" : "file");
  const lead = new LeadAgent(repoRoot);
  const route = lead.routeSpec(spec);
  console.log(`[lead] route → ${route.workspace.id} (${route.reason})`);
  const briefing = lead.briefing(route, spec);

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
    const filePath = writeHandoffMarkdown(repoRoot, packId, spec);
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
    },
    refs: spec.refs,
    actor: coding ? `agent:${coding.id}` : "system",
  });

  store.append({
    type: "agent_completed",
    subject_id: pack.id,
    summary: `handoff exported (${pack.target})`,
    detail: { agent: coding?.id ?? "file", path: pack.path },
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
