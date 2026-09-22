/**
 * High-confidence 云之家 completion talk → Done-gate progress.
 *
 * Messages already land via poll-yzj / ingest (`message_ingested`). This does
 * not open a second inbox and does not call yzj-cli. The Done gate folds
 * assertive 「已完成 / 搞定 / 上线了」 lines into `progress-snapshot.json`
 * `discourse` (sibling of repo workspaces) so the same matcher path can close
 * already-shipped cards. Vague, negated, future, or question chat is ignored.
 * Missing yzj rows fail-open (no close). Host `progress-scan` does not read
 * SQLite; it preserves `discourse` when it rewrites git items.
 */

import type { EventStore } from "../store/events.js";
import { titleTopicTokens } from "../agents/near-duplicate.js";
import { divertThemeFromText } from "../agents/theme-vocabulary.js";
import {
  loadProgressSnapshot,
  writeProgressSnapshot,
  type ProgressDiscourse,
  type ProgressItem,
  type ProgressSnapshot,
} from "./progress-snapshot.js";

export const YZJ_DISCOURSE_ID = "yzj" as const;
export const YZJ_DISCOURSE_MAX = 80;

/** Assertive done-phrases, longest first so 「已经上线了」 wins over 「上线了」. */
const COMPLETION_PHRASES = [
  "已经上线完成了",
  "已经上线了",
  "已上线完成了",
  "已经完成了",
  "已经搞定了",
  "已经发布了",
  "已经修好了",
  "已经做完了",
  "已经处理完了",
  "上线完成了",
  "已经上线",
  "已上线了",
  "已完成了",
  "已经完成",
  "已经搞定",
  "已经发布",
  "已经修好",
  "已经做完",
  "已经修复",
  "已经合入",
  "已经处理完",
  "处理完了",
  "搞定了",
  "搞完了",
  "做完了",
  "修好了",
  "合入了",
  "上线了",
  "完成了",
  "发布了",
  "交付了",
  "已上线",
  "已完成",
  "已搞定",
  "已发布",
  "已修复",
  "已做完",
  "已合入",
  "已交付",
  "搞定",
] as const;

/** Chat glue that is not a shipped-work stem. */
const FILLER = new Set([
  "需要",
  "给",
  "加上",
  "修复",
  "评估",
  "并",
  "重做",
  "新增",
  "落地",
  "版本",
  "一个",
  "这个",
  "那个",
  "进行",
  "实现",
  "支持",
  "必须",
  "才能",
  "一下",
  "我们",
  "大家",
  "今天",
  "刚刚",
  "刚才",
  "已经",
  "可以",
  "任务",
  "事情",
  "需求",
  "功能",
  "问题",
  "优化",
  "部分",
  "相关",
  "目前",
  "谢谢",
  "收到",
  "导出",
  "上线",
  "完成",
  "搞定",
  "发布",
  "处理",
  "交付",
  "做完",
  "好了",
  "关于",
  "还有",
  "以及",
  "并且",
  "然后",
  "但是",
  "不过",
  "如果",
  "因为",
  "所以",
  "就是",
  "还是",
  "不是",
  "没有",
  "帮助",
  "帮忙",
  "请把",
  "ok",
  "done",
]);

const WEAK_BEFORE =
  /(?:没有|还没|尚未|并未|从没|未曾|未|没|别|不要|不是|不算|暂未|即将|马上|准备|计划|预计|打算|争取|快要|快|需要|请|帮忙|帮我|麻烦|希望|想要|想|去|先不|先别|等待|差不多|基本上|可能|也许|或许|大概|估计|应该|好像|似乎)$/;

const AFTER_REJECT = /^(?:的|吗|呢|吧|啊|呀|哦|哈|么|再说|再看|的话|之后|以后|再)/;

const QUESTION_RE = /[?？]|吗|是否|是不是|有没有|能不能|要不要/;
/** Request framing anywhere before the phrase — 「帮我把 X 搞定」 is not done. */
const REQUEST_HEAD_RE = /帮我|帮忙|请把|请尽快|请先|麻烦|劳驾|能不能|可不可以|要不要/;

export type DiscourseMessage = {
  id: string;
  source?: string;
  adapterId?: string;
  text: string;
  ts?: string;
  groupId?: string;
};

export type CompletionHit = {
  phrase: string;
  subject: string;
  theme?: string;
};

export function isYzjMessageSource(source: string | undefined, adapterId?: string): boolean {
  const s = (source ?? "").trim().toLowerCase();
  const a = (adapterId ?? "").trim().toLowerCase();
  if (s === "yzj" || s.startsWith("yzj-") || s.startsWith("yzj:") || s.includes("yunzhijia")) return true;
  if (a === "yzj" || a.startsWith("yzj-") || a.startsWith("yzj:")) return true;
  return false;
}

export function workTokens(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of titleTopicTokens(text)) {
    const t = tok.trim().toLowerCase();
    if (t.length < 2 || FILLER.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Subject names real work, not 「这个 / 搞定 / 速记」 alone. */
export function subjectIsSpecific(subject: string): boolean {
  const tokens = workTokens(subject);
  if (tokens.some((t) => /[\u3400-\u9fff]/.test(t) && t.length >= 3)) return true;
  const cjk = tokens.filter((t) => /[\u3400-\u9fff]/.test(t));
  const latin = tokens.filter((t) => !/[\u3400-\u9fff]/.test(t) && t.length >= 3);
  if (cjk.length >= 2) return true;
  if (cjk.length >= 1 && latin.length >= 1) return true;
  return false;
}

function normalizeClause(raw: string): string {
  return raw.replace(/[ \t\f\v]+/g, " ").replace(/啦|咯/g, "了").trim();
}

function clausesOf(text: string): string[] {
  return text
    .split(/[\n\r。！!?？；;，,、]+/)
    .map((s) => normalizeClause(s))
    .filter(Boolean);
}

function phraseAccepted(clause: string, index: number, phrase: string): boolean {
  if (QUESTION_RE.test(clause)) return false;
  const head = clause.slice(0, index);
  if (REQUEST_HEAD_RE.test(head)) return false;
  const before = head.slice(Math.max(0, head.length - 8));
  if (WEAK_BEFORE.test(before)) return false;
  const after = clause.slice(index + phrase.length);
  if (AFTER_REJECT.test(after)) return false;
  if (phrase === "搞定" && after.length > 0) return false;
  return true;
}

function findCompletion(clause: string): { phrase: string; index: number } | null {
  const occupied: Array<{ index: number; phrase: string }> = [];
  for (const phrase of COMPLETION_PHRASES) {
    let from = 0;
    while (from < clause.length) {
      const index = clause.indexOf(phrase, from);
      if (index < 0) break;
      const inside = occupied.some((m) => index >= m.index && index < m.index + m.phrase.length);
      if (!inside) occupied.push({ index, phrase });
      from = index + Math.max(1, phrase.length);
    }
  }
  occupied.sort((a, b) => a.index - b.index || b.phrase.length - a.phrase.length);
  const seen = new Set<number>();
  for (const m of occupied) {
    if (seen.has(m.index)) continue;
    seen.add(m.index);
    if (phraseAccepted(clause, m.index, m.phrase)) return m;
  }
  return null;
}

function subjectAround(clause: string, index: number, phrase: string): string {
  const before = clause
    .slice(0, index)
    .replace(/^(关于|那个|这个|咱们|我们|已经|刚刚|刚才|今天)+/, "")
    .trim();
  const after = clause
    .slice(index + phrase.length)
    .replace(/^(是|为|了)+/, "")
    .replace(/^[:：\-—~～\s]+/, "")
    .trim();
  const raw = (before.length >= 2 ? before : after).replace(/^[:：\-—~～]+|[:：\-—~～]+$/g, "").trim();
  return raw;
}

/** One clause → a completion, or null when the talk is weak / ambiguous. */
export function completionFromClause(clause: string): CompletionHit | null {
  const text = normalizeClause(clause);
  if (!text) return null;
  const found = findCompletion(text);
  if (!found) return null;
  const subject = subjectAround(text, found.index, found.phrase);
  if (!subjectIsSpecific(subject)) return null;
  const theme = divertThemeFromText(subject, undefined);
  return { phrase: found.phrase, subject, ...(theme ? { theme } : {}) };
}

export function completionsFromText(text: string): CompletionHit[] {
  const out: CompletionHit[] = [];
  const seen = new Set<string>();
  for (const clause of clausesOf(text)) {
    const hit = completionFromClause(clause);
    if (!hit) continue;
    const key = hit.subject;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

function clip(s: string, cap = 480): string {
  const t = s.trim();
  if (!t) return "";
  return t.length > cap ? `${t.slice(0, cap)}…` : t;
}

function withinSince(ts: string | undefined, sinceDays: number, now: Date): boolean {
  if (!ts) return true;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return true;
  return t >= now.getTime() - sinceDays * 86400_000;
}

export function discourseItemsFromMessages(
  messages: DiscourseMessage[],
  opts?: { sinceDays?: number; now?: Date }
): ProgressItem[] {
  const sinceDays = opts?.sinceDays ?? 90;
  const now = opts?.now ?? new Date();
  const items: ProgressItem[] = [];
  const seen = new Set<string>();
  const ordered = [...messages].sort((a, b) => String(b.ts ?? "").localeCompare(String(a.ts ?? "")));
  for (const msg of ordered) {
    if (!isYzjMessageSource(msg.source, msg.adapterId)) continue;
    if (!withinSince(msg.ts, sinceDays, now)) continue;
    const text = (msg.text ?? "").trim();
    if (!text) continue;
    for (const hit of completionsFromText(text)) {
      const key = `${msg.id}:${hit.subject}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        kind: "yzj",
        title: hit.subject,
        body: clip(text),
        workspace_id: YZJ_DISCOURSE_ID,
        ...(msg.ts ? { at: msg.ts } : {}),
        message_id: msg.id,
        ...(hit.theme ? { theme: hit.theme } : {}),
        phrase: hit.phrase,
      });
      if (items.length >= YZJ_DISCOURSE_MAX) return items;
    }
  }
  return items;
}

export function yzjMessagesFromStore(store: EventStore): DiscourseMessage[] {
  return store
    .list({ type: "message_ingested", limit: 5000 })
    .map((ev) => {
      let detail: Record<string, unknown> = {};
      try {
        detail = JSON.parse(ev.detail_json) as Record<string, unknown>;
      } catch {
        detail = {};
      }
      return {
        id: ev.subject_id,
        source: detail.source != null ? String(detail.source) : undefined,
        adapterId: detail.adapter_id != null ? String(detail.adapter_id) : undefined,
        text: String(detail.text ?? ev.summary ?? ""),
        ts: detail.ts != null ? String(detail.ts) : ev.created_at,
        groupId: detail.groupId != null ? String(detail.groupId) : undefined,
      } satisfies DiscourseMessage;
    });
}

export function buildYzjDiscourse(
  messages: DiscourseMessage[],
  opts?: { sinceDays?: number; now?: Date; sawSource?: boolean }
): ProgressDiscourse {
  const yzj = messages.filter((m) => isYzjMessageSource(m.source, m.adapterId));
  const saw = opts?.sawSource ?? yzj.length > 0;
  if (!saw) {
    return {
      id: YZJ_DISCOURSE_ID,
      available: false,
      fail_open: true,
      reason: "no yzj messages ingested",
      scanned: 0,
      refreshed_at: (opts?.now ?? new Date()).toISOString(),
      items: [],
    };
  }
  const items = discourseItemsFromMessages(yzj, opts);
  return {
    id: YZJ_DISCOURSE_ID,
    available: true,
    fail_open: false,
    ...(items.length ? {} : { reason: "no high-confidence 已完成 talk" }),
    scanned: yzj.length,
    refreshed_at: (opts?.now ?? new Date()).toISOString(),
    items,
  };
}

/**
 * Attach discourse for matching.
 * No snapshot file and no completion items → null (repo source still missing).
 */
export function mergeDiscourse(
  snapshot: ProgressSnapshot | null,
  discourse: ProgressDiscourse
): ProgressSnapshot | null {
  if (!snapshot) {
    if (!discourse.items.length) return null;
    return {
      version: 1,
      generated_at: discourse.refreshed_at ?? new Date().toISOString(),
      source: "progress-scan",
      since_days: 90,
      workspaces: [],
      discourse,
    };
  }
  return { ...snapshot, discourse };
}

/**
 * Fold ingested 云之家 completions onto the snapshot.
 * Read errors fail-open: previous snapshot unchanged, no throw.
 * Does not create `progress-snapshot.json` when nothing completed and no file exists.
 */
export function foldYzjDiscourse(
  store: EventStore,
  repoRoot: string | undefined,
  snapshot: ProgressSnapshot | null,
  opts?: { now?: Date }
): ProgressSnapshot | null {
  const now = opts?.now ?? new Date();
  let messages: DiscourseMessage[] = [];
  try {
    messages = yzjMessagesFromStore(store);
  } catch (err) {
    console.warn(`[yzj-discourse] fail-open (store read): ${(err as Error).message}`);
    return snapshot;
  }
  const sinceDays = snapshot?.since_days ?? 90;
  const discourse = buildYzjDiscourse(messages, { sinceDays, now });
  const merged = mergeDiscourse(snapshot, discourse);
  if (!repoRoot) return merged;
  try {
    const latest = loadProgressSnapshot(repoRoot);
    const base = latest ?? snapshot;
    const toStore = mergeDiscourse(base, discourse);
    if (!toStore) return null;
    if (!base && !discourse.items.length) return null;
    writeProgressSnapshot(repoRoot, toStore);
    return toStore;
  } catch (err) {
    console.warn(`[yzj-discourse] fail-open (snapshot write): ${(err as Error).message}`);
    return merged ?? snapshot;
  }
}

/**
 * Candidate title is covered by the completion subject.
 * Filler drops out. Any extra content word on the card (a narrower follow-up)
 * keeps it suggested.
 */
export function discourseCoversTitle(candidateTitle: string, subject: string): boolean {
  const cand = workTokens(candidateTitle);
  const sub = new Set(workTokens(subject));
  if (!cand.length || !sub.size) return false;
  const strong = cand.some((t) => t.length >= 4);
  if (cand.length < 2 && !strong) return false;
  if (!cand.every((t) => sub.has(t))) return false;
  return cand.some((t) => /[\u3400-\u9fff]/.test(t));
}
