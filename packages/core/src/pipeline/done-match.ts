/**
 * Match a Needs-you candidate against repo progress + Desk history.
 *
 * Hit → already shipped / already triaged (Done gate closes it).
 * Uncertain → stay suggested. Repo scan fail does not produce a hit.
 */

import {
  scoreNearDuplicate,
  sharedRefTokens,
  titleTopicOverlap,
  titleTopicTokens,
  NEAR_DUP_TITLE_MIN,
  type MergeText,
} from "../agents/near-duplicate.js";
import type { WorkspaceEntry } from "../agents/lead.js";
import type { ProgressItem, ProgressSnapshot } from "./progress-snapshot.js";

/** Stronger than merge's 0.32 when there is no workspace hint. */
export const DONE_TITLE_MIN = 0.36;
/** Title overlap that may close when workspace keywords also agree. */
export const DONE_TITLE_HINT_MIN = NEAR_DUP_TITLE_MIN;
/** Shared CJK / long tokens that mean the same shipped work (bilingual titles). */
export const DONE_STEM_STRONG_MIN = 3;

export type DoneEvidenceKind = "pr" | "issue" | "commit" | "history";

export type DoneEvidence = {
  kind: DoneEvidenceKind;
  title: string;
  workspace_id?: string;
  url?: string;
  sha?: string;
  candidate_id?: string;
  status?: string;
};

export type DoneHit = {
  hit: true;
  via: "link" | "title" | "history";
  evidence: DoneEvidence;
  reason: string;
};

export type DoneMiss = {
  hit: false;
  failOpen: boolean;
};

export type DoneVerdict = DoneHit | DoneMiss;

export type DoneHistoryItem = {
  id: string;
  title: string;
  body: string;
  refs: string[];
  status: "accepted" | "rejected" | "merged";
};

export type DoneCandidate = {
  id?: string;
  title: string;
  body?: string;
  refs?: string[];
};

export type DoneMatchContext = {
  snapshot: ProgressSnapshot | null;
  history: DoneHistoryItem[];
  workspaces: WorkspaceEntry[];
};

const URL_RE = /https?:\/\/[^\s)\]>'"]+/gi;
const GITHUB_REF_RE = /\b(?:github\.com|code\.yzjop\.com)\/[^\s)\]>'"]+/gi;
const SHA_RE = /\b[a-f0-9]{7,40}\b/g;

function blobOf(c: { title?: string; body?: string; refs?: string[] }): string {
  return `${c.title ?? ""} ${c.body ?? ""} ${(c.refs ?? []).join(" ")}`;
}

export function extractLinks(text: string): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    const u = raw.replace(/[.,;:!?)]+$/, "").toLowerCase();
    if (u.startsWith("http") || u.includes("github.com") || u.includes("code.yzjop.com")) {
      out.add(u);
    }
  };
  for (const m of text.matchAll(URL_RE)) add(m[0]);
  for (const m of text.matchAll(GITHUB_REF_RE)) add(m[0]);
  return [...out];
}

export function extractShas(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(SHA_RE)) {
    if (m[0].length >= 7) out.add(m[0].toLowerCase());
  }
  return [...out];
}

function itemText(item: ProgressItem): MergeText {
  return {
    title: item.title,
    body: item.body ?? "",
    refs: [item.url, item.sha, item.number != null ? String(item.number) : ""]
      .filter((s): s is string => Boolean(s)),
  };
}

function historyText(h: DoneHistoryItem): MergeText {
  return { title: h.title, body: h.body, refs: h.refs };
}

export function workspaceKeywordHits(
  text: string,
  workspaces: WorkspaceEntry[],
  workspaceId?: string
): string[] {
  const hay = text.toLowerCase();
  const hits: string[] = [];
  for (const ws of workspaces) {
    if (workspaceId && ws.id !== workspaceId) continue;
    for (const n of [...(ws.match ?? []), ...(ws.tags ?? [])]) {
      const needle = n.trim().toLowerCase();
      if (needle.length < 2) continue;
      if (hay.includes(needle) && !hits.includes(n)) hits.push(n);
    }
  }
  return hits;
}

function evidenceFromItem(item: ProgressItem): DoneEvidence {
  return {
    kind: item.kind,
    title: item.title,
    workspace_id: item.workspace_id,
    ...(item.url ? { url: item.url } : {}),
    ...(item.sha ? { sha: item.sha } : {}),
  };
}

function repoItems(snapshot: ProgressSnapshot | null): ProgressItem[] {
  if (!snapshot) return [];
  const out: ProgressItem[] = [];
  for (const ws of snapshot.workspaces) {
    // Fail-open workspaces with no items contribute nothing (don't drop).
    // Preserved items from a prior successful scan are usable Done evidence.
    if (!ws.items.length) continue;
    out.push(...ws.items);
  }
  return out;
}

function snapshotFailOpen(snapshot: ProgressSnapshot | null): boolean {
  if (!snapshot) return true;
  if (!snapshot.workspaces.length) return true;
  return snapshot.workspaces.every((w) => w.fail_open && !w.items.length);
}

function sharedLinkHit(candBlob: string, item: ProgressItem): boolean {
  const candLinks = extractLinks(candBlob);
  const itemBlob = `${item.title} ${item.body ?? ""} ${item.url ?? ""}`;
  const itemLinks = extractLinks(itemBlob);
  if (item.url) {
    const u = item.url.replace(/[.,;:!?)]+$/, "").toLowerCase();
    if (candBlob.toLowerCase().includes(u) || candLinks.includes(u)) return true;
  }
  if (item.sha && candBlob.toLowerCase().includes(item.sha.toLowerCase())) return true;
  if (item.sha) {
    const short = item.sha.slice(0, 7).toLowerCase();
    const shas = extractShas(candBlob);
    if (shas.some((s) => s.startsWith(short) || short.startsWith(s.slice(0, 7)))) return true;
  }
  for (const a of candLinks) {
    for (const b of itemLinks) {
      if (a === b || a.includes(b) || b.includes(a)) return true;
    }
  }
  return false;
}

function strongSharedStems(a: string, b: string): string[] {
  const A = new Set(titleTopicTokens(a));
  const B = new Set(titleTopicTokens(b));
  const shared: string[] = [];
  for (const tok of A) {
    if (!B.has(tok) || tok.length < 2) continue;
    // CJK bigrams (速记/灵基) or latin stems of length ≥ 3 (mcp/oauth)
    if (/[\u3400-\u9fff]/.test(tok) || tok.length >= 3) shared.push(tok);
  }
  return shared;
}

function titleHit(
  cand: MergeText,
  item: ProgressItem,
  workspaces: WorkspaceEntry[]
): { ok: boolean; overlap: number; hinted: boolean } {
  const score = scoreNearDuplicate(cand, itemText(item));
  const hinted = workspaceKeywordHits(blobOf(cand), workspaces, item.workspace_id).length > 0;
  // PR titles are often English while Desk cards stay Chinese — use title+body stem
  // overlap, not title-to-title only (merge's nearDuplicate requires titleOverlap ≥ 0.18).
  const overlap = Math.max(score.titleOverlap, score.textOverlap);
  const stems = strongSharedStems(blobOf(cand), `${item.title} ${item.body ?? ""}`);
  if (score.nearDuplicate) return { ok: true, overlap, hinted };
  if (stems.length >= DONE_STEM_STRONG_MIN) return { ok: true, overlap, hinted };
  if (overlap >= DONE_TITLE_MIN) return { ok: true, overlap, hinted };
  if (hinted && overlap >= DONE_TITLE_HINT_MIN) {
    return { ok: true, overlap, hinted };
  }
  return { ok: false, overlap, hinted };
}

function bestRepoHit(
  cand: DoneCandidate,
  snapshot: ProgressSnapshot | null,
  workspaces: WorkspaceEntry[]
): DoneHit | null {
  const items = repoItems(snapshot);
  if (!items.length) return null;
  const text: MergeText = {
    title: cand.title,
    body: cand.body ?? "",
    refs: cand.refs ?? [],
  };
  const blob = blobOf(text);

  let bestTitle: { item: ProgressItem; overlap: number; hinted: boolean } | null = null;
  for (const item of items) {
    if (sharedLinkHit(blob, item)) {
      const where = item.kind === "pr" ? "合并 PR" : item.kind === "issue" ? "已关 issue" : "仓库提交";
      return {
        hit: true,
        via: "link",
        evidence: evidenceFromItem(item),
        reason: `与${where}「${item.title}」共享链接/引用`,
      };
    }
    const t = titleHit(text, item, workspaces);
    if (!t.ok) continue;
    if (!bestTitle || t.overlap > bestTitle.overlap) bestTitle = { item, overlap: t.overlap, hinted: t.hinted };
  }
  if (!bestTitle) return null;
  const where =
    bestTitle.item.kind === "pr" ? "已合并 PR" : bestTitle.item.kind === "issue" ? "已关 issue" : "最近提交";
  return {
    hit: true,
    via: "title",
    evidence: evidenceFromItem(bestTitle.item),
    reason: `标题接近${where}「${bestTitle.item.title}」`,
  };
}

function bestHistoryHit(cand: DoneCandidate, history: DoneHistoryItem[]): DoneHit | null {
  const text: MergeText = {
    title: cand.title,
    body: cand.body ?? "",
    refs: cand.refs ?? [],
  };
  let best: { h: DoneHistoryItem; overlap: number } | null = null;
  for (const h of history) {
    if (cand.id && h.id === cand.id) continue;
    const score = scoreNearDuplicate(text, historyText(h));
    const shared = sharedRefTokens(cand.refs, h.refs);
    const same =
      score.nearDuplicate ||
      shared.length > 0 ||
      titleTopicOverlap(cand.title, h.title) >= DONE_TITLE_MIN;
    if (!same) continue;
    if (!best || score.titleOverlap > best.overlap) best = { h, overlap: score.titleOverlap };
  }
  if (!best) return null;
  const label =
    best.h.status === "accepted" ? "已通过" : best.h.status === "merged" ? "已合并" : "已处理";
  return {
    hit: true,
    via: "history",
    evidence: {
      kind: "history",
      title: best.h.title,
      candidate_id: best.h.id,
      status: best.h.status,
    },
    reason: `与Desk历史${label}项「${best.h.title}」是同一件事`,
  };
}

/**
 * Conservative matcher. Uncertain → miss (stay suggested).
 * Missing snapshot / all-workspaces fail-open only affects repo evidence;
 * Desk history can still hit.
 */
export function matchCandidateToDone(cand: DoneCandidate, ctx: DoneMatchContext): DoneVerdict {
  const historyHit = bestHistoryHit(cand, ctx.history);
  if (historyHit) return historyHit;

  const repoHit = bestRepoHit(cand, ctx.snapshot, ctx.workspaces);
  if (repoHit) return repoHit;

  return { hit: false, failOpen: snapshotFailOpen(ctx.snapshot) };
}
