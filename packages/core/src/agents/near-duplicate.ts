/**
 * Local same-request / same-topic scoring for Needs-you merge.
 *
 * Laya `same_request` noul is still the live gate, but the open-item window is
 * only MERGE_OPEN_ITEMS_CAP deep. Ranking by title/body/ref overlap puts the
 * real twin in that window. Near-duplicate titles also lower the noul floor
 * so paraphrases fold; unrelated work stays vetoed by the topic Jaccard.
 */

export const DEFAULT_LAYA_MERGE_TOPIC_MIN = 0.18;
/** Strong title paraphrase — enough to treat as the same ask. */
export const NEAR_DUP_TITLE_MIN = 0.32;
/** Combined title+body overlap for near-duplicates. */
export const NEAR_DUP_TEXT_MIN = 0.4;
/** Title overlap that may merge when body or refs also agree. */
export const NEAR_DUP_SUPPORT_MIN = 0.28;
export const NEAR_DUP_BODY_MIN = 0.32;
/** `same_request` floor when the pair is already a local near-duplicate. */
export const NEAR_DUP_MERGE_NOUL_MIN = 0.72;
/** Very high title overlap may override a high-confidence Laya `new`. */
export const NEAR_DUP_OVERRIDE_TITLE_MIN = 0.55;

/** Process words that should not glue unrelated work items together. */
const TITLE_TOPIC_STOP = new Set([
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
  "进行",
  "实现",
  "支持",
  "必须",
  "才能",
  "一下",
]);

export type MergeText = {
  title?: string;
  body?: string;
  snippet?: string;
  refs?: string[];
};

function itemBody(item: MergeText): string {
  return (item.body || item.snippet || "").trim();
}

function itemBlob(item: MergeText): string {
  return `${item.title ?? ""} ${itemBody(item)}`.trim();
}

export function titleTopicTokens(text: string): string[] {
  const t = (text ?? "").toLowerCase();
  const tokens = new Set<string>();
  for (const m of t.matchAll(/[a-z0-9][a-z0-9._-]{1,}/g)) {
    tokens.add(m[0]);
  }
  const runs = t.match(/[\u3400-\u9fff]+/g) ?? [];
  for (const run of runs) {
    if (run.length === 1) {
      if (!TITLE_TOPIC_STOP.has(run)) tokens.add(run);
      continue;
    }
    if (run.length <= 4 && !TITLE_TOPIC_STOP.has(run)) tokens.add(run);
    for (let i = 0; i < run.length - 1; i++) {
      const bg = run.slice(i, i + 2);
      if (!TITLE_TOPIC_STOP.has(bg)) tokens.add(bg);
    }
  }
  return [...tokens];
}

/** Jaccard overlap of title/topic tokens. 1 when either side is empty (do not veto). */
export function titleTopicOverlap(a: string, b: string): number {
  const A = new Set(titleTopicTokens(a));
  const B = new Set(titleTopicTokens(b));
  if (A.size === 0 || B.size === 0) return 1;
  let inter = 0;
  for (const tok of A) {
    if (B.has(tok)) inter += 1;
  }
  const union = A.size + B.size - inter;
  return union === 0 ? 1 : inter / union;
}

export function titlesAreSameTopic(
  a: string,
  b: string,
  minOverlap = DEFAULT_LAYA_MERGE_TOPIC_MIN
): boolean {
  return titleTopicOverlap(a, b) >= minOverlap;
}

export function sharedRefTokens(a?: string[], b?: string[]): string[] {
  if (!a?.length || !b?.length) return [];
  const B = new Set(b.filter(Boolean));
  return [...new Set(a.filter((t) => t && B.has(t)))];
}

export type NearDuplicateScore = {
  titleOverlap: number;
  bodyOverlap: number;
  textOverlap: number;
  sharedRefs: string[];
  nearDuplicate: boolean;
};

export function scoreNearDuplicate(a: MergeText, b: MergeText): NearDuplicateScore {
  const titleOverlap = titleTopicOverlap(a.title ?? "", b.title ?? "");
  const rawBodyA = itemBody(a);
  const rawBodyB = itemBody(b);
  const bodyOverlap = rawBodyA && rawBodyB ? titleTopicOverlap(rawBodyA, rawBodyB) : 0;
  const textOverlap = titleTopicOverlap(itemBlob(a), itemBlob(b));
  const sharedRefs = sharedRefTokens(a.refs, b.refs);
  const nearDuplicate =
    titleOverlap >= DEFAULT_LAYA_MERGE_TOPIC_MIN &&
    (titleOverlap >= NEAR_DUP_TITLE_MIN ||
      textOverlap >= NEAR_DUP_TEXT_MIN ||
      (titleOverlap >= NEAR_DUP_SUPPORT_MIN && bodyOverlap >= NEAR_DUP_BODY_MIN) ||
      (titleOverlap >= NEAR_DUP_SUPPORT_MIN && sharedRefs.length > 0));
  return { titleOverlap, bodyOverlap, textOverlap, sharedRefs, nearDuplicate };
}

export function isNearDuplicate(a: MergeText, b: MergeText): boolean {
  return scoreNearDuplicate(a, b).nearDuplicate;
}

export function bestNearDuplicate<T extends MergeText & { id: string }>(
  candidate: MergeText,
  items: T[]
): T | undefined {
  let best: { item: T; score: NearDuplicateScore } | undefined;
  for (const item of items) {
    const score = scoreNearDuplicate(candidate, item);
    if (!score.nearDuplicate) continue;
    if (
      !best ||
      score.titleOverlap > best.score.titleOverlap ||
      (score.titleOverlap === best.score.titleOverlap && score.textOverlap > best.score.textOverlap)
    ) {
      best = { item, score };
    }
  }
  return best?.item;
}

/**
 * Put local near-duplicates first so the cap-8 Laya window sees the real twin
 * instead of the 8 most recent unrelated cards.
 */
export function rankOpenItemsForMerge<T extends MergeText>(
  candidate: MergeText,
  items: T[],
  cap: number
): T[] {
  const scored = items.map((item, index) => {
    const score = scoreNearDuplicate(candidate, item);
    return { item, index, score, overlap: Math.max(score.titleOverlap, score.textOverlap) };
  });
  scored.sort((a, b) => {
    if (a.score.nearDuplicate !== b.score.nearDuplicate) return a.score.nearDuplicate ? -1 : 1;
    if (b.overlap !== a.overlap) return b.overlap - a.overlap;
    return a.index - b.index;
  });
  return scored.slice(0, cap).map((s) => s.item);
}
