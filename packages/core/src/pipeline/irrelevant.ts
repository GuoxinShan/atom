/**
 * 跟我无关 — teach the Needs-you queue from a local 拒绝.
 *
 * Desk 拒绝 (empty reason / 跟我无关 / not_mine) writes one source+theme
 * scope into preference memory immediately. It does not wait for RSI's
 * 5-decision sample, and it does not retrain Laya.
 *
 * Later extracts: same group + same theme class (发布流程) or the same
 * distinctive stem leaves Needs you as 「同类已标无关」 on 系统已处理.
 * Uncertain overlap stays suggested (fail-open). A personal ask — owner
 * name or a direct 请你/需要你 — is never diverted.
 */

import {
  loadPreferenceMemory,
  mergeIrrelevant,
  savePreferenceMemory,
  type IrrelevantScope,
  type PreferenceMemory,
} from "../agents/preference-memory.js";
import {
  loadThemeVocabulary,
  tryMapAllowlist,
  type ThemeVocabulary,
} from "../agents/theme-vocabulary.js";
import type { Ref } from "../schema/types.js";
import { projectCandidates } from "../store/candidates.js";
import type { EventStore } from "../store/events.js";
import { listOpenSuggested } from "./merge-sweep.js";

export const NOT_MINE_REASON = "not_mine";
export const IRRELEVANT_REASON = "irrelevant";
export const IRRELEVANT_LABEL = "同类已标无关";
export const IRRELEVANT_ACTOR = "system:irrelevant";

const OWNER_RE = /单国鑫|国鑫|guoxin|rock-shan/i;
const DIRECT_ASK_RE = /请你|需要你|要你|你来|帮我|麻烦你|你确认|你拍板|你看一下|你看下|找你/;

const STEM_GENERIC = new Set([
  "明确",
  "环境",
  "同步",
  "发布",
  "流程",
  "发布流程",
  "预发布",
  "生产",
  "沙箱",
  "需要",
  "确认",
  "修复",
  "优化",
  "支持",
  "方案",
  "问题",
  "进行",
  "一下",
  "这个",
  "我们",
  "大家",
  "今天",
  "已经",
  "可以",
  "不是",
  "没有",
]);

export type IrrelevantVerdict = {
  action: "divert" | "keep";
  /** Same group, but the theme/stem evidence was too thin to close the card. */
  uncertain: boolean;
  scope?: IrrelevantScope;
  reason: string;
};

type ScopeInput = {
  title: string;
  body?: string;
  refs?: Array<{ token: string } | string>;
  theme?: string;
  tags?: { theme?: string };
  confidence?: number;
  keep_open?: boolean;
};

/** Local Desk 拒绝, or an explicit 跟我无关. System reasons stay out. */
export function isUserIrrelevantReason(reason: string | undefined): boolean {
  const r = (reason ?? "").trim().toLowerCase();
  if (!r) return true;
  return r === NOT_MINE_REASON || r === "not-mine" || r === "跟我无关" || r === "not my problem";
}

export function groupIdsFromRefs(refs: Array<{ token: string } | string> | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs ?? []) {
    const token = typeof ref === "string" ? ref : ref.token;
    const id = groupIdFromToken(token);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function groupIdFromToken(token: string): string | undefined {
  const parts = token.split(":");
  if (parts.length < 4 || parts[1] !== "im") return undefined;
  const group = parts[2]?.trim();
  if (!group || group === "unknown") return undefined;
  return group;
}

/** Owner name or a direct ask. High-confidence group chatter is not personal. */
export function isPersonalAsk(title: string, body = "", confidence = 0): boolean {
  const text = `${title}\n${body}`;
  if (OWNER_RE.test(text) || DIRECT_ASK_RE.test(text)) return true;
  if (confidence >= 0.85 && /你/.test(text) && /请|帮|确认|拍板/.test(text)) return true;
  return false;
}

/**
 * Theme class only when the evidence is a real label or an alias of at least
 * 4 characters. Bare 「发布」 / 「缺陷」 stay uncertain instead of diverting.
 */
export function strongThemeClass(
  cand: { title?: string; body?: string; theme?: string; tags?: { theme?: string } },
  vocab: ThemeVocabulary
): string | undefined {
  const stored = tryMapAllowlist(cand.theme ?? cand.tags?.theme, vocab.themes);
  if (stored && stored !== vocab.other) return stored;
  const text = `${cand.title ?? ""}\n${cand.body ?? ""}`.toLowerCase();
  let best: { title: string; len: number } | undefined;
  for (const label of vocab.themes) {
    if (!label.title || label.title === vocab.other) continue;
    for (const raw of [label.title, ...(label.aliases ?? [])]) {
      const needle = raw.trim().toLowerCase();
      if (needle.length < 4) continue;
      if (!text.includes(needle)) continue;
      if (!best || needle.length > best.len) best = { title: label.title, len: needle.length };
    }
  }
  return best?.title;
}

/** Longest distinctive chunk of a title, after theme-class words are removed. */
export function distinctiveStem(title: string): string {
  const stripped = title
    .replace(/\s+/g, "")
    .replace(/发布与发布流程/g, " ")
    .replace(/预发布/g, " ")
    .replace(/发布流程/g, " ")
    .replace(/[^\u3400-\u9fffA-Za-z0-9]+/g, " ");
  const parts = stripped
    .split(/\s+/)
    .flatMap((chunk) => chunk.split(/到|的|和|与|及|并/))
    .map((s) => s.replace(/^(明确|需要|请|确认|评估|修复|优化|支持|落地|推进|把|将|跟进|同步)+/, ""))
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && !STEM_GENERIC.has(s) && !/^\d+$/.test(s));
  if (!parts.length) return "";
  parts.sort((a, b) => b.length - a.length || a.localeCompare(b));
  return parts[0]!.slice(0, 16);
}

export function scopesFromCandidate(cand: ScopeInput, vocab?: ThemeVocabulary): IrrelevantScope[] {
  const book = vocab ?? loadThemeVocabulary();
  const groups = groupIdsFromRefs(cand.refs);
  if (!groups.length) return [];
  const theme = strongThemeClass(cand, book) ?? "";
  const stem = distinctiveStem(cand.title);
  if (!theme && stem.length < 4) return [];
  return groups.map((source) => ({ source, theme, stem }));
}

function haystack(title: string, body = ""): string {
  return `${title}\n${body}`.replace(/\s+/g, "");
}

function weakClassHint(text: string, theme: string, vocab: ThemeVocabulary): boolean {
  if (!theme) return false;
  const label = vocab.themes.find((t) => t.title === theme);
  if (!label) return false;
  const hay = text.toLowerCase();
  for (const raw of [label.title, ...(label.aliases ?? [])]) {
    const needle = raw.trim().toLowerCase();
    if (needle.length < 2 || needle.length >= 4) continue;
    if (hay.includes(needle)) return true;
  }
  return false;
}

export function judgeIrrelevant(
  cand: ScopeInput,
  memory: PreferenceMemory,
  vocab?: ThemeVocabulary
): IrrelevantVerdict {
  const scopes = memory.irrelevant ?? [];
  if (!scopes.length) return { action: "keep", uncertain: false, reason: "no-scope" };
  if (cand.keep_open) return { action: "keep", uncertain: false, reason: "keep-open" };
  if (isPersonalAsk(cand.title, cand.body ?? "", cand.confidence ?? 0)) {
    return { action: "keep", uncertain: false, reason: "personal" };
  }
  const groups = new Set(groupIdsFromRefs(cand.refs));
  if (!groups.size) return { action: "keep", uncertain: true, reason: "no-group" };

  const book = vocab ?? loadThemeVocabulary();
  const candClass = strongThemeClass(cand, book) ?? "";
  const text = haystack(cand.title, cand.body ?? "");
  let uncertain = false;

  for (const scope of scopes) {
    if (!groups.has(scope.source)) continue;
    const sameClass = Boolean(scope.theme && candClass && scope.theme === candClass);
    const stemHit = scope.stem.length >= 4 && text.includes(scope.stem);
    if (sameClass || stemHit) {
      return {
        action: "divert",
        uncertain: false,
        scope,
        reason: sameClass ? "theme+source" : "stem+source",
      };
    }
    if (weakClassHint(`${cand.title}\n${cand.body ?? ""}`, scope.theme, book)) uncertain = true;
  }

  return {
    action: "keep",
    uncertain,
    reason: uncertain ? "uncertain-same-source" : "different-topic",
  };
}

export function appendIrrelevantClose(
  store: EventStore,
  candidate: { id: string; title: string; refs: Ref[] },
  scope: IrrelevantScope
): void {
  store.append({
    type: "decision_rejected",
    subject_id: candidate.id,
    summary: `irrelevant: ${candidate.title}`,
    detail: {
      reason: IRRELEVANT_REASON,
      reason_label: IRRELEVANT_LABEL,
      disposition: IRRELEVANT_REASON,
      source: scope.source,
      theme: scope.theme,
      stem: scope.stem,
    },
    refs: candidate.refs,
    actor: IRRELEVANT_ACTOR,
  });
}

export function applyIrrelevantToSuggested(
  store: EventStore,
  opts?: { repoRoot?: string; memory?: PreferenceMemory; vocab?: ThemeVocabulary }
): { closed: number; ids: string[] } {
  const memory = opts?.memory ?? loadPreferenceMemory(opts?.repoRoot, store);
  const vocab = opts?.vocab ?? loadThemeVocabulary(opts?.repoRoot);
  const ids: string[] = [];
  for (const c of listOpenSuggested(store)) {
    const verdict = judgeIrrelevant(
      {
        title: c.title,
        body: c.body,
        refs: c.refs,
        theme: c.theme,
        tags: c.tags,
        confidence: c.confidence,
        keep_open: c.keep_open,
      },
      memory,
      vocab
    );
    if (verdict.action !== "divert" || !verdict.scope) continue;
    appendIrrelevantClose(store, c, verdict.scope);
    ids.push(c.id);
    console.log(`[irrelevant] diverted ${c.id}: ${c.title}`);
  }
  return { closed: ids.length, ids };
}

/**
 * Immediate preference write for a user 拒绝 / 跟我无关.
 * Also diverts open siblings that already match. Does not move RSI cursor_at.
 */
export function teachIrrelevantFromReject(
  store: EventStore,
  repoRoot: string,
  candidateId: string,
  now = new Date()
): { learned: boolean; diverted: string[]; scope: IrrelevantScope | null } {
  const cand = projectCandidates(store).find((c) => c.id === candidateId);
  if (!cand) return { learned: false, diverted: [], scope: null };
  const vocab = loadThemeVocabulary(repoRoot);
  const scopes = scopesFromCandidate(
    {
      title: cand.title,
      body: cand.body,
      refs: cand.refs,
      theme: cand.theme,
      tags: cand.tags,
    },
    vocab
  );
  if (!scopes.length) return { learned: false, diverted: [], scope: null };

  const current = loadPreferenceMemory(repoRoot, store);
  const irrelevant = mergeIrrelevant(current.irrelevant, scopes);
  const changed = irrelevantSig(irrelevant) !== irrelevantSig(current.irrelevant);
  const memory: PreferenceMemory = changed
    ? { ...current, irrelevant, updated_at: now.toISOString() }
    : { ...current, irrelevant };
  if (changed) savePreferenceMemory(repoRoot, memory, store);

  const sweep = applyIrrelevantToSuggested(store, { repoRoot, memory, vocab });
  return { learned: true, diverted: sweep.ids, scope: scopes[0] ?? null };
}

export function irrelevantSig(list: IrrelevantScope[] | undefined): string {
  return (list ?? []).map((s) => `${s.source}\0${s.theme}\0${s.stem}`).join("\n");
}

export type IrrelevantFeedback = {
  status: string;
  rejectReason?: string;
  title: string;
  body?: string;
  refs?: string[];
  theme?: string;
  tags?: { theme?: string };
};

/** Scopes RSI should merge when a window already contains user 跟我无关 rejects. */
export function scopesFromIrrelevantFeedback(
  rows: IrrelevantFeedback[],
  vocab?: ThemeVocabulary
): IrrelevantScope[] {
  const out: IrrelevantScope[] = [];
  for (const row of rows) {
    if (row.status !== "rejected") continue;
    if (!isUserIrrelevantReason(row.rejectReason)) continue;
    out.push(
      ...scopesFromCandidate(
        {
          title: row.title,
          body: row.body,
          refs: row.refs,
          theme: row.theme,
          tags: row.tags,
        },
        vocab
      )
    );
  }
  return mergeIrrelevant([], out);
}
