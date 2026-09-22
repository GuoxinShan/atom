/**
 * Match a Needs-you candidate against repo progress + Desk history +
 * high-confidence 云之家 completion talk (`snapshot.discourse`).
 *
 * Hit → already shipped / already triaged (Done gate closes it).
 * Uncertain → stay suggested. Repo scan fail does not produce a hit.
 * Missing yzj discourse does not produce a hit.
 *
 * Desk history is stricter than repo snapshot matching: same/compatible theme
 * (or both untagged), else workspace keyword overlap / a higher title floor.
 * Cross-theme near-dups (速记 vs 日程/会议, 产品缺陷 vs 发布与发布流程) do not
 * `already_done` from history alone.
 *
 * Repo title/stem hits need distinctive shared stems plus either a title/body
 * similarity floor or workspace affinity. Failure words (失败) are generic.
 * 云之家 counts as one phrase — interior bigrams 云之 / 之家 do not each
 * freeload a stem. Atom meta PRs (Desk / Done-gate / chore titles) are not
 * evidence that yzj / ai-advance product work is done, unless the candidate
 * itself routes to atom. Link/SHA hits stay. Fail-open.
 */

import {
  scoreNearDuplicate,
  sharedRefTokens,
  titleTopicOverlap,
  titleTopicTokens,
  DEFAULT_LAYA_MERGE_TOPIC_MIN,
  NEAR_DUP_BODY_MIN,
  NEAR_DUP_OVERRIDE_TITLE_MIN,
  NEAR_DUP_SUPPORT_MIN,
  NEAR_DUP_TEXT_MIN,
  NEAR_DUP_TITLE_MIN,
  type MergeText,
  type NearDuplicateScore,
} from "../agents/near-duplicate.js";
import {
  canonicalNonOtherTheme,
  compactKey,
  divertProjectFromText,
  TAG_OTHER,
  tryMapAllowlist,
  DEFAULT_THEME_VOCABULARY,
} from "../agents/theme-vocabulary.js";
import type { WorkspaceEntry } from "../agents/lead.js";
import type { ProgressItem, ProgressSnapshot } from "./progress-snapshot.js";
import { discourseCoversTitle } from "./yzj-discourse.js";
import { isPersonalAsk } from "./irrelevant.js";

/** Stronger than merge's 0.32 when there is no workspace hint. */
export const DONE_TITLE_MIN = 0.36;
/** Title overlap that may close when workspace keywords also agree. */
export const DONE_TITLE_HINT_MIN = NEAR_DUP_TITLE_MIN;
/**
 * Shared distinctive stems that may close bilingual titles, but only together
 * with a title/body similarity floor or workspace affinity.
 */
export const DONE_STEM_STRONG_MIN = 3;
/**
 * Mixed tagged/untagged history pairs need a stronger title floor than
 * same-theme paraphrases. Repo snapshot matching uses workspace affinity.
 */
export const DONE_HISTORY_MIXED_TITLE_MIN = NEAR_DUP_OVERRIDE_TITLE_MIN;

export type DoneEvidenceKind = "pr" | "issue" | "commit" | "history" | "yzj";

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
  via: "link" | "title" | "history" | "yzj";
  evidence: DoneEvidence;
  reason: string;
};

export type DoneMiss = {
  hit: false;
  failOpen: boolean;
};

export type DoneVerdict = DoneHit | DoneMiss;

/** Generic process words that must not count as shipped-work stems. */
const DONE_GENERIC_PHRASES = [
  "发布",
  "流程",
  "修复",
  "发布流程",
  "发布与发布流程",
  "feat",
  "fix",
  "chore",
  "docs",
  "doc",
  "test",
  "tests",
  "refactor",
  "wip",
  "bump",
  "ci",
  "build",
  "style",
  "tighten",
  "matching",
  "across",
  "themes",
  "theme",
  "history",
  "done",
  "gate",
  "pull",
  "request",
  "merge",
  "pr",
  "issue",
  "commit",
  // Failure / status noise. Must not alone carry a strong stem match.
  "失败",
  "报错",
  "出错",
  "异常",
  "错误",
  "超时",
  "告警",
  "error",
  "errors",
  "fail",
  "failed",
  "failure",
  "warn",
  "warning",
] as const;

/** Product names counted as one stem. Interior bigrams must not each match. */
const DONE_WHOLE_PHRASES = ["云之家"] as const;

function buildGenericStemSet(): Set<string> {
  const out = new Set<string>();
  for (const p of DONE_GENERIC_PHRASES) {
    const t = p.toLowerCase();
    out.add(t);
    if (/[\u3400-\u9fff]/.test(t)) {
      for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    }
  }
  return out;
}

export const DONE_GENERIC_STEMS = buildGenericStemSet();

export type DoneThemeFields = {
  theme?: string;
  project?: string;
  tags?: { theme?: string; project?: string };
};

export type DoneHistoryItem = DoneThemeFields & {
  id: string;
  title: string;
  body: string;
  refs: string[];
  status: "accepted" | "rejected" | "merged";
  /** User 跟我无关 / auto 同类 divert. Not evidence that the work shipped. */
  reject_reason?: string;
};

export type DoneCandidate = DoneThemeFields & {
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

/** Workspace `match`/`tags` needles that appear on both sides. */
export function sharedWorkspaceKeywords(
  a: { title?: string; body?: string; refs?: string[] },
  b: { title?: string; body?: string; refs?: string[] },
  workspaces: WorkspaceEntry[]
): string[] {
  const left = workspaceKeywordHits(blobOf(a), workspaces);
  if (!left.length) return [];
  const right = new Set(
    workspaceKeywordHits(blobOf(b), workspaces).map((n) => n.trim().toLowerCase())
  );
  return left.filter((n) => right.has(n.trim().toLowerCase()));
}

/** Stored or diverted non-其他 theme. Does not persist tags. */
export function resolveDoneTheme(item: DoneThemeFields & { title?: string; body?: string }): string | undefined {
  return canonicalNonOtherTheme({
    title: item.title,
    body: item.body,
    theme: item.theme,
    tags: item.tags,
  });
}

/** Stored or diverted non-其他 project (事元 / 云之家 / AI推进). */
export function resolveDoneProject(item: DoneThemeFields & { title?: string; body?: string }): string | undefined {
  const stored = tryMapAllowlist(item.project ?? item.tags?.project, DEFAULT_THEME_VOCABULARY.projects);
  if (stored && stored !== TAG_OTHER) return stored;
  return divertProjectFromText(item.title, item.body);
}

function affinityBlob(cand: DoneCandidate): string {
  return [
    blobOf(cand),
    cand.theme ?? "",
    cand.project ?? "",
    cand.tags?.theme ?? "",
    cand.tags?.project ?? "",
  ].join(" ");
}

function labelHitsWorkspace(label: string, ws: WorkspaceEntry): boolean {
  const t = label.toLowerCase();
  const compactT = compactKey(label);
  for (const n of [...(ws.match ?? []), ...(ws.tags ?? [])]) {
    const needle = n.trim().toLowerCase();
    if (needle.length < 2) continue;
    if (t.includes(needle) || needle.includes(t)) return true;
    const compactN = compactKey(n);
    if (compactN.length >= 2 && (compactT.includes(compactN) || compactN.includes(compactT))) return true;
  }
  return false;
}

/**
 * Candidate theme/keywords vs workspace `match`/`tags`.
 * Atom evidence requires this before a title/stem hit can close.
 */
export function candidateAffinesWorkspace(
  cand: DoneCandidate,
  workspaceId: string | undefined,
  workspaces: WorkspaceEntry[]
): boolean {
  if (!workspaceId) return false;
  if (workspaceKeywordHits(affinityBlob(cand), workspaces, workspaceId).length > 0) return true;
  const ws = workspaces.find((w) => w.id === workspaceId);
  if (!ws) return false;
  const theme = resolveDoneTheme(cand);
  if (theme && labelHitsWorkspace(theme, ws)) return true;
  const project = resolveDoneProject(cand);
  if (project && labelHitsWorkspace(project, ws)) return true;
  return false;
}

/**
 * Desk-history guard. Cross-theme near-dups never close from history alone.
 * Same theme, or both untagged, keep the existing topic score. Mixed
 * tagged/untagged needs workspace keyword overlap or a higher title floor.
 */
export function historyPairCompatible(
  cand: DoneCandidate,
  hist: DoneHistoryItem,
  score: Pick<NearDuplicateScore, "titleOverlap">,
  workspaces: WorkspaceEntry[]
): boolean {
  const themeA = resolveDoneTheme(cand);
  const themeB = resolveDoneTheme(hist);
  if (themeA && themeB) return themeA === themeB;
  if (!themeA && !themeB) return true;
  if (score.titleOverlap >= DONE_HISTORY_MIXED_TITLE_MIN) return true;
  return sharedWorkspaceKeywords(cand, hist, workspaces).length > 0;
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

function occurrenceCoveredByPhrase(text: string, index: number, length: number, phrase: string): boolean {
  let from = 0;
  while (from <= index) {
    const at = text.indexOf(phrase, from);
    if (at < 0 || at > index) return false;
    if (at + phrase.length >= index + length) return true;
    from = at + 1;
  }
  return false;
}

function bigramOccursOutsidePhrase(text: string, bigram: string, phrase: string): boolean {
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf(bigram, from);
    if (at < 0) return false;
    if (!occurrenceCoveredByPhrase(text, at, bigram.length, phrase)) return true;
    from = at + 1;
  }
  return false;
}

/**
 * Topic tokens for Done matching. Same cuts as merge, except a whole phrase
 * such as 云之家 stays one token — 云之 / 之家 do not each count when they
 * only occur inside that phrase.
 */
export function doneTopicTokens(text: string): string[] {
  const tokens = new Set(titleTopicTokens(text));
  const lower = (text ?? "").toLowerCase();
  for (const phrase of DONE_WHOLE_PHRASES) {
    if (!lower.includes(phrase)) continue;
    tokens.add(phrase);
    for (let i = 0; i < phrase.length - 1; i++) {
      const bg = phrase.slice(i, i + 2);
      if (!bigramOccursOutsidePhrase(lower, bg, phrase)) tokens.delete(bg);
    }
  }
  return [...tokens];
}

/** Jaccard of Done topic tokens. 1 when either side is empty (same as merge). */
export function doneTopicOverlap(a: string, b: string): number {
  const A = new Set(doneTopicTokens(a));
  const B = new Set(doneTopicTokens(b));
  if (A.size === 0 || B.size === 0) return 1;
  let inter = 0;
  for (const tok of A) {
    if (B.has(tok)) inter += 1;
  }
  const union = A.size + B.size - inter;
  return union === 0 ? 1 : inter / union;
}

function mergeBody(item: MergeText): string {
  return (item.body || item.snippet || "").trim();
}

/**
 * Near-duplicate score using phrase-aware tokens. Thresholds match
 * `scoreNearDuplicate`; 云之家 must not inflate Jaccard via 云之 + 之家.
 */
function scoreDonePair(a: MergeText, b: MergeText): NearDuplicateScore {
  const titleOverlap = doneTopicOverlap(a.title ?? "", b.title ?? "");
  const rawBodyA = mergeBody(a);
  const rawBodyB = mergeBody(b);
  const bodyOverlap = rawBodyA && rawBodyB ? doneTopicOverlap(rawBodyA, rawBodyB) : 0;
  const textOverlap = doneTopicOverlap(
    `${a.title ?? ""} ${rawBodyA}`.trim(),
    `${b.title ?? ""} ${rawBodyB}`.trim()
  );
  const sharedRefs = sharedRefTokens(a.refs, b.refs);
  const nearDuplicate =
    titleOverlap >= DEFAULT_LAYA_MERGE_TOPIC_MIN &&
    (titleOverlap >= NEAR_DUP_TITLE_MIN ||
      textOverlap >= NEAR_DUP_TEXT_MIN ||
      (titleOverlap >= NEAR_DUP_SUPPORT_MIN && bodyOverlap >= NEAR_DUP_BODY_MIN) ||
      (titleOverlap >= NEAR_DUP_SUPPORT_MIN && sharedRefs.length > 0));
  return { titleOverlap, bodyOverlap, textOverlap, sharedRefs, nearDuplicate };
}

function strongSharedStems(a: string, b: string): string[] {
  const A = new Set(doneTopicTokens(a));
  const B = new Set(doneTopicTokens(b));
  const shared: string[] = [];
  for (const tok of A) {
    if (!B.has(tok) || tok.length < 2) continue;
    // CJK bigrams (速记/灵基) or latin stems of length ≥ 3 (mcp/oauth)
    if (/[\u3400-\u9fff]/.test(tok) || tok.length >= 3) shared.push(tok);
  }
  return shared;
}

export function isDistinctiveStem(tok: string): boolean {
  if (tok.length < 2) return false;
  if (DONE_GENERIC_STEMS.has(tok.toLowerCase())) return false;
  return /[\u3400-\u9fff]/.test(tok) || tok.length >= 3;
}

/** Shared CJK / long tokens excluding generic 发布/流程/修复 / chore prefixes. */
export function distinctiveSharedStems(a: string, b: string): string[] {
  return strongSharedStems(a, b).filter(isDistinctiveStem);
}

function titleHit(
  cand: DoneCandidate,
  item: ProgressItem,
  workspaces: WorkspaceEntry[]
): { ok: boolean; overlap: number; hinted: boolean } {
  const text: MergeText = {
    title: cand.title,
    body: cand.body ?? "",
    refs: cand.refs ?? [],
  };
  const hinted = candidateAffinesWorkspace(cand, item.workspace_id, workspaces);
  // Phrase-aware overlap: 云之家 is one token, so 云之 + 之家 cannot inflate a near-dup.
  const score = scoreDonePair(text, itemText(item));
  const overlap = Math.max(score.titleOverlap, score.textOverlap);
  // Atom meta PRs (Desk / Done-gate / chore) are not product-done evidence.
  if (item.workspace_id === "atom" && !hinted) {
    return { ok: false, overlap, hinted: false };
  }
  // PR titles are often English while Desk cards stay Chinese — use title+body stem
  // overlap, not title-to-title only (merge's nearDuplicate requires titleOverlap ≥ 0.18).
  const stems = distinctiveSharedStems(blobOf(text), `${item.title} ${item.body ?? ""}`);
  const distinctive = stems.length >= 1;
  if (score.nearDuplicate && (hinted || distinctive)) return { ok: true, overlap, hinted };
  // Pure stem hits need real distinctive stems AND a similarity floor or the same workspace.
  // 失败 + 云之家 (split into 云之 / 之家) must not close by count alone.
  if (stems.length >= DONE_STEM_STRONG_MIN && (hinted || overlap >= DONE_TITLE_MIN)) {
    return { ok: true, overlap, hinted };
  }
  if (overlap >= DONE_TITLE_MIN && (hinted || distinctive)) return { ok: true, overlap, hinted };
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
    if (item.kind === "yzj") continue;
    if (sharedLinkHit(blob, item)) {
      const where = item.kind === "pr" ? "合并 PR" : item.kind === "issue" ? "已关 issue" : "仓库提交";
      return {
        hit: true,
        via: "link",
        evidence: evidenceFromItem(item),
        reason: `与${where}「${item.title}」共享链接/引用`,
      };
    }
    const t = titleHit(cand, item, workspaces);
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

function discourseItems(snapshot: ProgressSnapshot | null): ProgressItem[] {
  const block = snapshot?.discourse;
  if (!block?.items.length) return [];
  return block.items.filter((item) => item.kind === "yzj" && item.title.trim());
}

/**
 * 云之家 completion subject must cover the card title, and themes must agree
 * when both sides resolve. Weak chat never becomes an item.
 */
function bestDiscourseHit(cand: DoneCandidate, snapshot: ProgressSnapshot | null): DoneHit | null {
  const items = discourseItems(snapshot);
  if (!items.length) return null;
  const candTheme = resolveDoneTheme(cand);
  let best: { item: ProgressItem } | null = null;
  for (const item of items) {
    const itemTheme = resolveDoneTheme({
      title: item.title,
      theme: item.theme,
    });
    if (candTheme && itemTheme && candTheme !== itemTheme) continue;
    if (!discourseCoversTitle(cand.title, item.title)) continue;
    best = { item };
    break;
  }
  if (!best) return null;
  const phrase = best.item.phrase ? `（${best.item.phrase}）` : "";
  return {
    hit: true,
    via: "yzj",
    evidence: {
      kind: "yzj",
      title: best.item.title,
      workspace_id: best.item.workspace_id || "yzj",
      ...(best.item.message_id ? { sha: best.item.message_id } : {}),
    },
    reason: `云之家进度关闭：群里说「${best.item.title}」${phrase}`,
  };
}

function bestHistoryHit(
  cand: DoneCandidate,
  history: DoneHistoryItem[],
  workspaces: WorkspaceEntry[]
): DoneHit | null {
  const text: MergeText = {
    title: cand.title,
    body: cand.body ?? "",
    refs: cand.refs ?? [],
  };
  let best: { h: DoneHistoryItem; overlap: number } | null = null;
  for (const h of history) {
    if (cand.id && h.id === cand.id) continue;
    // 拒绝 / 同类已标无关 means "not my problem", not "this ask is done".
    // A later personal ask with the same words still belongs on Needs you.
    if (
      (h.reject_reason === "not_mine" ||
        h.reject_reason === "irrelevant" ||
        h.reject_reason === "muted_source") &&
      isPersonalAsk(cand.title, cand.body ?? "")
    ) {
      continue;
    }
    const score = scoreNearDuplicate(text, historyText(h));
    const shared = sharedRefTokens(cand.refs, h.refs);
    const same =
      score.nearDuplicate ||
      shared.length > 0 ||
      titleTopicOverlap(cand.title, h.title) >= DONE_TITLE_MIN;
    if (!same) continue;
    if (!historyPairCompatible(cand, h, score, workspaces)) continue;
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
  const historyHit = bestHistoryHit(cand, ctx.history, ctx.workspaces);
  if (historyHit) return historyHit;

  const repoHit = bestRepoHit(cand, ctx.snapshot, ctx.workspaces);
  if (repoHit) return repoHit;

  const yzjHit = bestDiscourseHit(cand, ctx.snapshot);
  if (yzjHit) return yzjHit;

  return { hit: false, failOpen: snapshotFailOpen(ctx.snapshot) };
}
