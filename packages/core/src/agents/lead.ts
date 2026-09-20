import fs from "node:fs";
import path from "node:path";
import type { SpecDraft } from "../schema/types.js";
import type { LayaModelRoute } from "./laya.js";

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
 * Week-1 haystack rules (see fixtures/lead-routing.json):
 * - Score primarily on `spec.title` + acceptance criteria.
 * - Never score raw ref tokens (`yzj:im:…`) or ref digests — they leak tooling words.
 * - Ignore generic tooling terms (云之家 / yzj-cli / CLI / grok / token / key / 本机 / 单机 / 分发)
 *   unless the TITLE itself is a yzj product ask (1023 / 日历 / 灵基chat开发 / schedule/mcp).
 * - Unsure → personal `atom` only; do not guess company paths.
 */
export const GENERIC_TOOLING_TERMS = [
  "云之家",
  "yzj-cli",
  "cli",
  "grok",
  "token",
  "key",
  "本机",
  "单机",
  "分发",
] as const;

export const YZJ_TITLE_SIGNALS = ["1023", "日历", "灵基chat开发", "schedule/mcp"] as const;

export function titleIsYzjProductAsk(title: string): boolean {
  const t = title.toLowerCase();
  return YZJ_TITLE_SIGNALS.some((s) => t.includes(s.toLowerCase()));
}

export function isGenericToolingTerm(needle: string): boolean {
  const n = needle.toLowerCase();
  return GENERIC_TOOLING_TERMS.some((g) => n === g.toLowerCase());
}

function needleHits(ws: WorkspaceEntry, needle: string, hay: string, title: string): boolean {
  if (!needle) return false;
  if (isGenericToolingTerm(needle)) {
    if (ws.id !== "yzj" || !titleIsYzjProductAsk(title)) return false;
  }
  return hay.includes(needle);
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
    // Title + acceptance only. Body / ref tokens / ref digests stay out of the haystack.
    const titleHay = spec.title.toLowerCase();
    const acceptHay = spec.acceptance_criteria.join("\n").toLowerCase();

    let best: { ws: WorkspaceEntry; score: number; hits: string[] } | null = null;
    for (const ws of cfg.workspaces) {
      const needles = [
        ...new Set([...(ws.match ?? []), ...(ws.tags ?? [])].map((s) => s.toLowerCase())),
      ];
      const titleHits = needles.filter((n) => needleHits(ws, n, titleHay, spec.title));
      const acceptHits = needles.filter(
        (n) => !titleHits.includes(n) && needleHits(ws, n, acceptHay, spec.title)
      );
      const hits = [...titleHits, ...acceptHits];
      const score = titleHits.length * 2 + acceptHits.length;
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

  briefing(route: RouteDecision, spec: SpecDraft, modelRoute?: LayaModelRoute): string {
    const modelLines =
      modelRoute && !modelRoute.failOpen
        ? [
            `- laya model: ${modelRoute.model ?? modelRoute.intensity}`,
            `- laya intensity: ${modelRoute.intensity}`,
            `- laya confidence: ${modelRoute.confidence ?? "n/a"}`,
          ]
        : modelRoute
          ? [`- laya model: fail-open (${modelRoute.reason})`]
          : [];
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
      ...modelLines,
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
