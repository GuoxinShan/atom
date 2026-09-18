import fs from "node:fs";
import path from "node:path";
import type { SpecDraft } from "../schema/types.js";

export interface WorkspaceEntry {
  id: string;
  machine: string;
  path: string;
  kind: string;
  tags?: string[];
  match?: string[];
  codingAgent?: string;
  notes?: string;
}

export interface RouteDecision {
  workspace: WorkspaceEntry;
  reason: string;
  confidence: number;
  machine: string;
}

export interface WorkspacesFile {
  version: number;
  defaultMachine: string;
  machines: Record<string, { label: string; hostname?: string; notes?: string }>;
  workspaces: WorkspaceEntry[];
}

/**
 * Lead / orchestrator: knows user + machines, routes work to a workspace.
 * Not a blind fan-out.
 */
export class LeadAgent {
  readonly id = "lead";

  constructor(private readonly repoRoot: string) {}

  loadWorkspaces(): WorkspacesFile {
    const p = path.join(this.repoRoot, "data", "workspaces.json");
    return JSON.parse(fs.readFileSync(p, "utf8")) as WorkspacesFile;
  }

  userContext(): string {
    const p = path.join(this.repoRoot, "data", "user-context.md");
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  }

  routeSpec(spec: SpecDraft): RouteDecision {
    const cfg = this.loadWorkspaces();
    // Ref tokens look like `yzj:im:group:msg` — never score the adapter prefix.
    const refDigests = spec.refs.map((r) => r.digest ?? "").join("\n");
    const hay = [spec.title, spec.body, ...spec.acceptance_criteria, refDigests]
      .join("\n")
      .toLowerCase();

    let best: { ws: WorkspaceEntry; score: number; hits: string[] } | null = null;
    for (const ws of cfg.workspaces) {
      const needles = [...(ws.match ?? []), ...(ws.tags ?? [])].map((s) => s.toLowerCase());
      const hits = needles.filter((n) => n && hay.includes(n));
      const score = hits.length;
      if (!best || score > best.score) best = { ws, score, hits };
    }

    if (!best || best.score === 0) {
      const atom = cfg.workspaces.find((w) => w.id === "atom");
      if (!atom) throw new Error("workspaces.json missing atom workspace");
      return {
        workspace: atom,
        machine: atom.machine,
        confidence: 0.35,
        reason:
          "no strong match — default personal ATOM workspace (lead will not guess company paths)",
      };
    }

    const conf = Math.min(0.95, 0.45 + best.score * 0.15);
    return {
      workspace: best.ws,
      machine: best.ws.machine,
      confidence: conf,
      reason:
        best.hits.length > 0
          ? `matched [${best.hits.join(", ")}] → ${best.ws.id} @ ${best.ws.path}`
          : `fallback ${best.ws.id}`,
    };
  }

  briefing(route: RouteDecision, spec: SpecDraft): string {
    return [
      "# Lead agent briefing",
      "",
      this.userContext(),
      "",
      "## Route decision",
      `- workspace: ${route.workspace.id}`,
      `- machine: ${route.machine}`,
      `- path: ${route.workspace.path}`,
      `- confidence: ${route.confidence}`,
      `- reason: ${route.reason}`,
      "",
      "## Task",
      `- title: ${spec.title}`,
      `- candidate: ${spec.candidate_id}`,
      `- spec: ${spec.id}`,
      "",
      "Work ONLY in the routed workspace path unless the user explicitly overrides.",
    ].join("\n");
  }
}
