import fs from "node:fs";
import path from "node:path";
import {
  isGenericToolingTerm,
  titleIsYzjProductAsk,
  type WorkspaceEntry,
  type WorkspacesFile,
} from "../agents/lead.js";
import type { CandidateView } from "../schema/types.js";
import {
  DEFAULT_THEME_VOCABULARY,
  divertProjectFromText,
  divertThemeFromText,
  mapToAllowlist,
  tryMapAllowlist,
  type ThemeVocabulary,
} from "../agents/theme-vocabulary.js";

export type NeedsGroupKind = "theme" | "project" | "heuristic";

export interface NeedsGroup {
  key: string;
  title: string;
  kind: NeedsGroupKind;
  candidate_ids: string[];
}

const STOPWORDS = new Set([
  "需要",
  "给",
  "加上",
  "的",
  "了",
  "一下",
  "请",
  "帮",
  "帮忙",
  "希望",
  "能不能",
  "可以",
  "要",
  "对",
  "把",
  "将",
  "在",
  "和",
  "与",
  "并",
  "and",
  "the",
  "a",
  "an",
  "to",
  "for",
  "of",
  "need",
  "add",
  "support",
  "please",
  "with",
  "from",
]);

const ATOM_GROUP_ALIASES = ["desk", "dispatch desk", "需要你拍板"];

/** Display-only grouping. Does not fold/merge candidates. */
export function groupNeedsYouCandidates(
  candidates: CandidateView[],
  workspaces: WorkspaceEntry[] = [],
  vocab: ThemeVocabulary = DEFAULT_THEME_VOCABULARY
): NeedsGroup[] {
  const suggested = candidates.filter((c) => c.status === "suggested");
  if (!suggested.length) return [];

  type Tentative = {
    cand: CandidateView;
    kind: NeedsGroupKind;
    key: string;
    title: string;
    wsId?: string;
    stem?: string;
  };

  const tentatives: Tentative[] = suggested.map((cand) => classify(cand, workspaces, vocab));
  const stemCount = new Map<string, number>();
  const wsStemCount = new Map<string, number>();
  for (const t of tentatives) {
    if (t.kind !== "heuristic") continue;
    if (t.stem) stemCount.set(t.stem, (stemCount.get(t.stem) ?? 0) + 1);
    if (t.wsId && t.stem) {
      const k = `${t.wsId}\0${t.stem}`;
      wsStemCount.set(k, (wsStemCount.get(k) ?? 0) + 1);
    }
  }

  const assigned = tentatives.map((t) => assignHeuristic(t, workspaces, stemCount, wsStemCount, vocab));
  const buckets = new Map<string, { title: string; kind: NeedsGroupKind; ids: string[]; latest: string }>();
  for (const a of assigned) {
    const cur = buckets.get(a.key);
    if (!cur) {
      buckets.set(a.key, {
        title: a.title,
        kind: a.kind,
        ids: [a.cand.id],
        latest: a.cand.updated_at,
      });
    } else {
      cur.ids.push(a.cand.id);
      if (a.cand.updated_at > cur.latest) cur.latest = a.cand.updated_at;
    }
  }

  const groups: NeedsGroup[] = [...buckets.entries()].map(([key, b]) => ({
    key,
    title: b.title,
    kind: b.kind,
    candidate_ids: b.ids,
  }));

  const kindRank: Record<NeedsGroupKind, number> = { theme: 0, project: 1, heuristic: 2 };
  groups.sort((a, b) => {
    const otherA = a.title === "其他" ? 1 : 0;
    const otherB = b.title === "其他" ? 1 : 0;
    if (otherA !== otherB) return otherA - otherB;
    const kr = kindRank[a.kind] - kindRank[b.kind];
    if (kr !== 0) return kr;
    const latestA = buckets.get(a.key)?.latest ?? "";
    const latestB = buckets.get(b.key)?.latest ?? "";
    return latestB.localeCompare(latestA);
  });
  return coalesceOtherGroups(groups);
}

export function loadGroupingWorkspaces(repoRoot: string): WorkspaceEntry[] {
  const p = path.join(repoRoot, "data", "workspaces.json");
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8")) as WorkspacesFile;
    return Array.isArray(data.workspaces) ? data.workspaces : [];
  } catch {
    return [];
  }
}

function coalesceOtherGroups(groups: NeedsGroup[]): NeedsGroup[] {
  const others = groups.filter((g) => g.title === "其他");
  if (others.length < 2) return groups;
  const winner = others.find((g) => g.kind === "theme") ?? others[0]!;
  const ids = [...new Set(others.flatMap((g) => g.candidate_ids))];
  winner.candidate_ids = ids;
  const drop = new Set(others.filter((g) => g.key !== winner.key).map((g) => g.key));
  return groups.filter((g) => !drop.has(g.key));
}

function classify(cand: CandidateView, workspaces: WorkspaceEntry[], vocab: ThemeVocabulary) {
  const storedTheme = optionalHuman(cand.theme) ?? optionalHuman(cand.tags?.theme);
  const mappedTheme = storedTheme ? tryMapAllowlist(storedTheme, vocab.themes) : undefined;
  const theme =
    mappedTheme && mappedTheme !== vocab.other
      ? mappedTheme
      : divertThemeFromText(cand.title, cand.body, vocab);
  if (theme) {
    return {
      cand,
      kind: "theme" as const,
      key: `theme:${normKey(theme)}`,
      title: theme,
    };
  }
  const storedProject = optionalHuman(cand.project) ?? optionalHuman(cand.tags?.project);
  const mappedProject = storedProject ? tryMapAllowlist(storedProject, vocab.projects) : undefined;
  const project =
    mappedProject && mappedProject !== vocab.other
      ? mappedProject
      : divertProjectFromText(cand.title, cand.body, vocab);
  if (project) {
    return {
      cand,
      kind: "project" as const,
      key: `project:${normKey(project)}`,
      title: project,
    };
  }
  if (storedTheme) {
    return {
      cand,
      kind: "theme" as const,
      key: `theme:${normKey(vocab.other)}`,
      title: vocab.other,
    };
  }
  const ws = matchWorkspace(cand, workspaces);
  const stemSource = humanClusterKey(cand.cluster_key) || cand.title;
  const stem = titleStem(stemSource);
  return {
    cand,
    kind: "heuristic" as const,
    key: "",
    title: "",
    wsId: ws?.id,
    stem,
  };
}

function assignHeuristic(
  t: {
    cand: CandidateView;
    kind: NeedsGroupKind;
    key: string;
    title: string;
    wsId?: string;
    stem?: string;
  },
  workspaces: WorkspaceEntry[],
  stemCount: Map<string, number>,
  wsStemCount: Map<string, number>,
  vocab: ThemeVocabulary
) {
  if (t.kind !== "heuristic") return t;
  const ws = t.wsId ? workspaces.find((w) => w.id === t.wsId) : undefined;
  const wsTitle = ws ? workspaceGroupTitle(ws) : "";
  const stem = t.stem || "";
  const sharedStem = stem && (stemCount.get(stem) ?? 0) >= 2;
  const sharedWsStem = Boolean(t.wsId && stem && (wsStemCount.get(`${t.wsId}\0${stem}`) ?? 0) >= 2);

  const foldTheme =
    tryMapAllowlist(wsTitle, vocab.themes) ??
    (stem ? tryMapAllowlist(prettyStem(stem, t.cand.title), vocab.themes) : undefined);
  if (foldTheme && foldTheme !== vocab.other) {
    return {
      ...t,
      kind: "theme" as const,
      key: `theme:${normKey(foldTheme)}`,
      title: foldTheme,
    };
  }

  if (t.wsId && wsTitle && sharedWsStem) {
    return {
      ...t,
      key: `heuristic:ws:${t.wsId}:${normKey(stem)}`,
      title: `${wsTitle} · ${prettyStem(stem, t.cand.title)}`,
    };
  }
  if (t.wsId && wsTitle) {
    return {
      ...t,
      key: `heuristic:ws:${t.wsId}`,
      title: wsTitle,
    };
  }
  if (sharedStem) {
    return {
      ...t,
      key: `heuristic:stem:${normKey(stem)}`,
      title: prettyStem(stem, t.cand.title),
    };
  }
  return {
    ...t,
    key: "heuristic:other",
    title: "其他",
  };
}

export function pickTheme(
  cand: Pick<CandidateView, "theme" | "tags">,
  vocab: ThemeVocabulary = DEFAULT_THEME_VOCABULARY
): string | undefined {
  const raw = optionalHuman(cand.theme) ?? optionalHuman(cand.tags?.theme);
  if (!raw) return undefined;
  return mapToAllowlist(raw, vocab.themes, vocab.other);
}

export function pickProject(
  cand: Pick<CandidateView, "project" | "tags">,
  vocab: ThemeVocabulary = DEFAULT_THEME_VOCABULARY
): string | undefined {
  const raw = optionalHuman(cand.project) ?? optionalHuman(cand.tags?.project);
  if (!raw) return undefined;
  return mapToAllowlist(raw, vocab.projects, vocab.other);
}

export function titleStem(raw: string): string {
  let s = String(raw ?? "").toLowerCase().trim();
  if (!s) return "";
  s = s.replace(/^(feat|fix|chore|docs|refactor|wip)[:：/\s-]+/i, "");
  s = s.replace(/existing-[a-z0-9_]+/gi, " ");
  s = s.replace(/\b(cand|spec|evt|chkitem|handoff|chk)_[a-z0-9_]+\b/gi, " ");
  s = s.replace(/[^\p{L}\p{N}\s_-]+/gu, " ");
  s = s.replace(/[_-]+/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  const tokens = s.split(" ").filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  if (!tokens.length) return s.slice(0, 12);
  const cjk = tokens.filter((t) => /[\u4e00-\u9fff]/.test(t));
  if (cjk.length && cjk[0] && cjk[0].length >= 2) {
    return cjk[0].slice(0, 8);
  }
  return tokens.slice(0, 2).join(" ");
}

export function matchWorkspace(
  cand: Pick<CandidateView, "title" | "body" | "cluster_key">,
  workspaces: WorkspaceEntry[]
): WorkspaceEntry | undefined {
  if (!workspaces.length) return undefined;
  const title = cand.title || "";
  const titleHay = title.toLowerCase();
  const bodyHay = `${title}\n${cand.body ?? ""}\n${humanClusterKey(cand.cluster_key) ?? ""}`.toLowerCase();

  let best: { ws: WorkspaceEntry; score: number } | null = null;
  for (const ws of workspaces) {
    const needles = [
      ...new Set(
        [...(ws.match ?? []), ...(ws.tags ?? []), ...(ws.id === "atom" ? ATOM_GROUP_ALIASES : [])].map((s) =>
          s.toLowerCase()
        )
      ),
    ].filter(Boolean);
    const titleHits = needles.filter((n) => needleHits(ws, n, titleHay, title));
    const bodyHits = needles.filter(
      (n) => !titleHits.includes(n) && needleHits(ws, n, bodyHay, title)
    );
    const score = titleHits.length * 2 + bodyHits.length;
    if (!best || score > best.score) best = { ws, score };
  }
  if (!best || best.score <= 0) return undefined;
  return best.ws;
}

function needleHits(ws: WorkspaceEntry, needle: string, hay: string, title: string): boolean {
  if (!needle) return false;
  if (isGenericToolingTerm(needle)) {
    if (ws.id !== "yzj" || !titleIsYzjProductAsk(title)) return false;
  }
  return hay.includes(needle);
}

export function workspaceGroupTitle(ws: WorkspaceEntry): string {
  const names = [...(ws.match ?? []), ...(ws.tags ?? []), ws.id]
    .map((s) => String(s).trim())
    .filter((s) => s && !s.includes("/") && s.length <= 16 && !looksTechnicalId(s));
  return names[0] || ws.id;
}

function prettyStem(stem: string, fallbackTitle: string): string {
  const s = stem.trim();
  if (!s) return firstHuman(fallbackTitle) || "其他";
  if (/[\u4e00-\u9fff]/.test(s)) return s;
  return s
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function humanClusterKey(raw: string | undefined): string | undefined {
  const s = optionalHuman(raw);
  return s && !looksTechnicalId(s) ? s : undefined;
}

function firstHuman(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    const s = optionalHuman(v);
    if (s && !looksTechnicalId(s)) return s;
  }
  return undefined;
}

function optionalHuman(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s || undefined;
}

function normKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export function looksTechnicalId(value: string): boolean {
  const s = String(value ?? "").trim();
  if (!s) return true;
  if (/^(cand|spec|evt|chkitem|handoff|chk)_/i.test(s)) return true;
  if (/^existing-/i.test(s) && /cand_/i.test(s)) return true;
  if (/:(im|doc|git|file|url):/.test(s)) return true;
  if (/^[a-f0-9]{16,}$/i.test(s)) return true;
  if (/^[a-z]+_[a-z0-9]{6,}$/i.test(s) && !s.includes("-")) return true;
  return false;
}
