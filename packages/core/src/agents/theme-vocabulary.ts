/**
 * Closed Chinese theme/project vocabulary for Laya Needs-you grouping.
 *
 * Source of truth: `data/theme-vocabulary.json` (product-editable).
 * Laya must pick from this allowlist. Unknown / empty / garbage maps to
 * the nearest allowlist title when that mapping is unique and compact,
 * otherwise 「其他」. Never persist English kebab slugs as group titles.
 */

import fs from "node:fs";
import path from "node:path";

export const THEME_VOCABULARY_FILE = "data/theme-vocabulary.json";
export const TAG_OTHER = "其他";
export const TAG_NONE = "none";

export type ThemeLabel = {
  title: string;
  hint?: string;
  aliases?: string[];
};

export type ThemeVocabulary = {
  version: 1;
  other: string;
  themes: ThemeLabel[];
  projects: ThemeLabel[];
};

/** Built-in fallback; keep in sync with `data/theme-vocabulary.json`. */
export const DEFAULT_THEME_VOCABULARY: ThemeVocabulary = {
  version: 1,
  other: TAG_OTHER,
  themes: [
    {
      title: "AI推进",
      hint: "company AI advance / lingee / 推进五态 — use AI推进, not ai-advance",
      aliases: ["ai-advance", "lingee-advance", "lingee", "ai 推进", "推进五态"],
    },
    {
      title: "日程/会议",
      hint: "calendar, 日程, meetings, schedule MCP — use 日程/会议, not Schedule Mcp or calendar",
      aliases: [
        "日历",
        "日程",
        "会议",
        "schedule mcp",
        "schedule/mcp",
        "schedule-mcp",
        "schedule_mcp",
        "calendar",
        "meeting",
        "meetings",
      ],
    },
    {
      title: "云之家",
      hint: "yunzhijia client / 1023 IM product work",
      aliases: ["yunzhijia", "yzj", "1023"],
    },
    {
      title: "发布与发布流程",
      hint: "release, ship, rollout, 发布流程 — use 发布与发布流程, not release-process",
      aliases: [
        "release-process",
        "release_process",
        "release process",
        "release",
        "发布",
        "发布流程",
      ],
    },
    {
      title: "产品缺陷",
      hint: "product bugs / 缺陷 — use 产品缺陷, not product-bug",
      aliases: ["product-bug", "product_bug", "product bug", "bug", "缺陷", "产品bug"],
    },
    {
      title: "迁移方案",
      hint: "migration plan / 迁移",
      aliases: ["migration", "migrate", "迁移"],
    },
    {
      title: "能力缺口",
      hint: "capability gap / missing ability",
      aliases: ["capability-gap", "capability_gap", "capability gap", "gap", "缺口"],
    },
    {
      title: "文档",
      hint: "docs, README, 说明文档",
      aliases: ["docs", "documentation", "readme"],
    },
    {
      title: "速记",
      hint: "shorthand / 速记 notes",
      aliases: ["shorthand"],
    },
    {
      title: "其他",
      hint: "does not fit any other theme — keep the card, group under 其他",
      aliases: ["other", "misc", "uncategorized"],
    },
  ],
  projects: [
    {
      title: "AI推进",
      hint: "company AI advance / lingee monorepo",
      aliases: ["ai-advance", "lingee-advance", "lingee", "推进五态"],
    },
    {
      title: "云之家",
      hint: "yunzhijia / 1023 client",
      aliases: ["yunzhijia", "yzj", "1023"],
    },
    {
      title: "事元",
      hint: "personal ATOM / Desk / 事元产品",
      aliases: ["atom", "desk", "事元产品"],
    },
    {
      title: "其他",
      hint: "no clear project — still keep the card",
      aliases: ["other", "misc"],
    },
  ],
};

export const DEFAULT_THEME_LABELS: ThemeLabel[] = DEFAULT_THEME_VOCABULARY.themes;
export const DEFAULT_PROJECT_LABELS: ThemeLabel[] = DEFAULT_THEME_VOCABULARY.projects;
/** @deprecated use DEFAULT_THEME_LABELS — kept so existing tag tests compile. */
export const DEFAULT_TAG_LABELS: ThemeLabel[] = DEFAULT_THEME_LABELS;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function hasCjk(s: string): boolean {
  return /[\u3400-\u9fff]/.test(s);
}

function parseLabel(v: unknown): ThemeLabel | null {
  const r = asRecord(v);
  if (!r) return null;
  const title = typeof r.title === "string" ? r.title.trim() : "";
  if (!title || title.length > 24 || !hasCjk(title)) return null;
  if (/^https?:/i.test(title) || /^(cand|spec|evt|chkitem|handoff|chk)_/i.test(title)) return null;
  const hint = typeof r.hint === "string" && r.hint.trim() ? r.hint.trim() : undefined;
  const aliases = Array.isArray(r.aliases)
    ? r.aliases.filter((a): a is string => typeof a === "string" && Boolean(a.trim())).map((a) => a.trim())
    : undefined;
  return { title, ...(hint ? { hint } : {}), ...(aliases?.length ? { aliases } : {}) };
}

function parseVocabulary(raw: unknown): ThemeVocabulary | null {
  const r = asRecord(raw);
  if (!r) return null;
  const otherRaw = typeof r.other === "string" && r.other.trim() ? r.other.trim() : TAG_OTHER;
  const other = hasCjk(otherRaw) ? otherRaw : TAG_OTHER;
  const themes = (Array.isArray(r.themes) ? r.themes : []).map(parseLabel).filter((x): x is ThemeLabel => Boolean(x));
  const projects = (Array.isArray(r.projects) ? r.projects : [])
    .map(parseLabel)
    .filter((x): x is ThemeLabel => Boolean(x));
  if (!themes.length) return null;
  const ensureOther = (labels: ThemeLabel[]): ThemeLabel[] =>
    labels.some((l) => l.title === other) ? labels : [...labels, { title: other, hint: other, aliases: ["other"] }];
  return {
    version: 1,
    other,
    themes: ensureOther(themes),
    projects: ensureOther(projects.length ? projects : themes),
  };
}

export function themeVocabularyPath(repoRoot: string): string {
  const fromEnv = process.env.ATOM_THEME_VOCABULARY?.trim();
  if (fromEnv) return path.isAbsolute(fromEnv) ? fromEnv : path.join(repoRoot, fromEnv);
  return path.join(repoRoot, THEME_VOCABULARY_FILE);
}

export function loadThemeVocabulary(repoRoot?: string): ThemeVocabulary {
  if (!repoRoot) return DEFAULT_THEME_VOCABULARY;
  const p = themeVocabularyPath(repoRoot);
  if (!fs.existsSync(p)) return DEFAULT_THEME_VOCABULARY;
  try {
    const parsed = parseVocabulary(JSON.parse(fs.readFileSync(p, "utf8")));
    return parsed ?? DEFAULT_THEME_VOCABULARY;
  } catch {
    return DEFAULT_THEME_VOCABULARY;
  }
}

export function stripLabelDecor(raw: string): string {
  return raw
    .trim()
    .replace(/^[「『【\[\s]+|[」』】\]\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isNoneLabel(raw: string): boolean {
  return /^(none|null|n\/a|unknown|无|-)$/i.test(raw.trim());
}

export function compactKey(raw: string): string {
  return stripLabelDecor(raw)
    .toLowerCase()
    .replace(/[「『【」』】\[\]()]/g, "")
    .replace(/[-_/\s.]+/g, "");
}

function labelKeys(label: ThemeLabel): string[] {
  return [label.title, ...(label.aliases ?? [])].map((s) => s.trim()).filter(Boolean);
}

/**
 * Map a Laya/Grok/stored title onto the allowlist.
 * Returns the canonical Chinese title, or undefined when not confidently mappable
 * (caller should use 「其他」). Never returns a free-form slug.
 */
export function tryMapAllowlist(raw: string | undefined, labels: ThemeLabel[]): string | undefined {
  const choice = stripLabelDecor(raw ?? "");
  if (!choice || isNoneLabel(choice)) return undefined;
  const key = choice.toLowerCase();
  const compact = compactKey(choice);
  if (!compact) return undefined;

  for (const label of labels) {
    for (const alias of labelKeys(label)) {
      if (alias.toLowerCase() === key) return label.title;
      if (compactKey(alias) === compact) return label.title;
    }
  }

  if (hasCjk(choice) && choice.length >= 2) {
    const cjkHits = labels.filter((label) =>
      labelKeys(label).some((alias) => {
        if (!hasCjk(alias)) return false;
        return alias.includes(choice) || choice.includes(alias);
      })
    );
    const unique = [...new Set(cjkHits.map((l) => l.title))];
    if (unique.length === 1) return unique[0];
  }

  if (compact.length >= 4) {
    const hits = labels.filter((label) =>
      labelKeys(label).some((alias) => {
        const a = compactKey(alias);
        if (a.length < 4) return false;
        return compact.includes(a) || a.includes(compact);
      })
    );
    const unique = [...new Set(hits.map((l) => l.title))];
    if (unique.length === 1) return unique[0];
  }

  return undefined;
}

export function mapToAllowlist(
  raw: string | undefined,
  labels: ThemeLabel[],
  otherTitle = TAG_OTHER
): string {
  return tryMapAllowlist(raw, labels) ?? otherTitle;
}

function needleIndex(hay: string, needle: string): number {
  if (!needle || needle.length < 2) return -1;
  return hay.indexOf(needle);
}

type DivertHit = { title: string; index: number; len: number };

function scanAllowlistHits(text: string, labels: ThemeLabel[], otherTitle: string): DivertHit[] {
  const hay = (text ?? "").toLowerCase();
  if (!hay.trim()) return [];
  const hits: DivertHit[] = [];
  for (const label of labels) {
    const title = label.title.trim();
    if (!title || title === otherTitle) continue;
    for (const raw of [title, ...(label.aliases ?? [])]) {
      const needle = raw.trim().toLowerCase();
      if (needle.length < 2) continue;
      // Skip 1–3 letter English aliases (bug, gap) — too easy to false-hit.
      if (!hasCjk(needle) && needle.length < 4) continue;
      const index = needleIndex(hay, needle);
      if (index < 0) continue;
      hits.push({ title, index, len: needle.length });
    }
  }
  return hits;
}

function pickDivertHit(hits: DivertHit[]): string | undefined {
  if (!hits.length) return undefined;
  const unique = [...new Set(hits.map((h) => h.title))];
  if (unique.length === 1) return unique[0];
  hits.sort((a, b) => a.index - b.index || b.len - a.len);
  return hits[0]?.title;
}

/**
 * Map title/body onto the closed allowlist without new labels.
 * Unique hit wins; multiple hits prefer the earliest, longest needle
 * (速记迁入灵基 → 速记, not 迁移方案 / AI推进).
 */
export function divertThemeFromText(
  title: string | undefined,
  body: string | undefined,
  vocab: ThemeVocabulary = DEFAULT_THEME_VOCABULARY
): string | undefined {
  const titleHits = scanAllowlistHits(title ?? "", vocab.themes, vocab.other);
  const picked = pickDivertHit(titleHits);
  if (picked) return picked;
  return pickDivertHit(scanAllowlistHits(`${title ?? ""}\n${body ?? ""}`, vocab.themes, vocab.other));
}

export function divertProjectFromText(
  title: string | undefined,
  body: string | undefined,
  vocab: ThemeVocabulary = DEFAULT_THEME_VOCABULARY
): string | undefined {
  const titleHits = scanAllowlistHits(title ?? "", vocab.projects, vocab.other);
  const picked = pickDivertHit(titleHits);
  if (picked) return picked;
  return pickDivertHit(scanAllowlistHits(`${title ?? ""}\n${body ?? ""}`, vocab.projects, vocab.other));
}

/** Stored or diverted non-其他 theme, if any. */
export function canonicalNonOtherTheme(
  cand: { title?: string; body?: string; theme?: string; tags?: { theme?: string } },
  vocab: ThemeVocabulary = DEFAULT_THEME_VOCABULARY
): string | undefined {
  const stored = tryMapAllowlist(cand.theme ?? cand.tags?.theme, vocab.themes);
  if (stored && stored !== vocab.other) return stored;
  return divertThemeFromText(cand.title, cand.body, vocab);
}

export function normalizeTheme(raw: string | undefined, vocab: ThemeVocabulary = DEFAULT_THEME_VOCABULARY): string {
  return mapToAllowlist(raw, vocab.themes, vocab.other);
}

export function normalizeProject(
  raw: string | undefined,
  vocab: ThemeVocabulary = DEFAULT_THEME_VOCABULARY
): string {
  return mapToAllowlist(raw, vocab.projects, vocab.other);
}

export type ExtractTagLabels = {
  themes: ThemeLabel[];
  projects: ThemeLabel[];
  other: string;
};

/** Closed lists only — do not harvest workspace / source / existing titles. */
export function tagLabelsForExtract(repoRoot?: string): ExtractTagLabels {
  const vocab = loadThemeVocabulary(repoRoot);
  return { themes: vocab.themes, projects: vocab.projects, other: vocab.other };
}

/** @deprecated harvest removed; returns closed theme allowlist. */
export function collectTagLabels(opts?: { repoRoot?: string }): ThemeLabel[] {
  return loadThemeVocabulary(opts?.repoRoot).themes;
}
