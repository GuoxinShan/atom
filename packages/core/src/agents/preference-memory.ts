/**
 * ATOM-side preference memory for Laya gates.
 *
 * Tuned from Desk accept/reject/merge feedback (preference RSI). Never
 * retrains Laya weights — only confidence floors and allow/block patterns.
 * Loaded by LayaClient.fromEnv and extract / outbound / merge callers.
 */

import fs from "node:fs";
import path from "node:path";
import type { EventStore } from "../store/events.js";

export const RSI_DEFAULT_THRESHOLD = 0.8;
export const RSI_MIN_THRESHOLD = 0.7;
export const RSI_MAX_THRESHOLD = 0.95;
export const RSI_STEP = 0.02;
export const RSI_MIN_SAMPLES = 5;
export const RSI_MAX_PATTERNS = 16;
export const RSI_PATTERN_MIN_HITS = 2;
export const RSI_MIN_PATTERN_CHARS = 4;

export const PREFERENCE_MEMORY_FILE = "data/preference-memory.json";
export const META_PREFERENCE_MEMORY = "preference_memory";

export type LayaGateThresholds = {
  noise: number;
  merge: number;
  outbound: number;
};

export type PreferenceMemory = {
  version: 1;
  updated_at: string | null;
  /** ISO time of last *applied* adjustment — later RSI runs only count newer decisions. */
  cursor_at: string | null;
  thresholds: LayaGateThresholds;
  /** Title/body substrings that must not be auto-dropped as noise. */
  allowlist: string[];
  /** Title/body substrings that should be treated as noise without Laya. */
  blocklist: string[];
};

export function defaultPreferenceMemory(): PreferenceMemory {
  return {
    version: 1,
    updated_at: null,
    cursor_at: null,
    thresholds: {
      noise: RSI_DEFAULT_THRESHOLD,
      merge: RSI_DEFAULT_THRESHOLD,
      outbound: RSI_DEFAULT_THRESHOLD,
    },
    allowlist: [],
    blocklist: [],
  };
}

export function clampThreshold(n: number): number {
  if (!Number.isFinite(n)) return RSI_DEFAULT_THRESHOLD;
  const stepped = Math.round(n * 100) / 100;
  return Math.min(RSI_MAX_THRESHOLD, Math.max(RSI_MIN_THRESHOLD, stepped));
}

export function preferenceMemoryPath(repoRoot: string): string {
  const fromEnv = process.env.ATOM_PREFERENCE_MEMORY?.trim();
  if (fromEnv) return path.isAbsolute(fromEnv) ? fromEnv : path.join(repoRoot, fromEnv);
  return path.join(repoRoot, PREFERENCE_MEMORY_FILE);
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== "string") continue;
    const t = item.trim();
    if (t.length < RSI_MIN_PATTERN_CHARS) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= RSI_MAX_PATTERNS) break;
  }
  return out;
}

function asThreshold(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? clampThreshold(v) : fallback;
}

export function parsePreferenceMemory(raw: unknown): PreferenceMemory {
  const base = defaultPreferenceMemory();
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!r) return base;
  const th = r.thresholds && typeof r.thresholds === "object" && !Array.isArray(r.thresholds)
    ? (r.thresholds as Record<string, unknown>)
    : {};
  return {
    version: 1,
    updated_at: typeof r.updated_at === "string" && r.updated_at.trim() ? r.updated_at : null,
    cursor_at: typeof r.cursor_at === "string" && r.cursor_at.trim() ? r.cursor_at : null,
    thresholds: {
      noise: asThreshold(th.noise, base.thresholds.noise),
      merge: asThreshold(th.merge, base.thresholds.merge),
      outbound: asThreshold(th.outbound, base.thresholds.outbound),
    },
    allowlist: asStringArray(r.allowlist),
    blocklist: asStringArray(r.blocklist),
  };
}

function readJsonFile(filePath: string): unknown | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** File first, then sqlite meta. `null` when neither exists (use env floors). */
export function tryLoadPreferenceMemory(
  repoRoot?: string,
  store?: EventStore
): PreferenceMemory | null {
  const root = repoRoot ?? process.env.ATOM_REPO_ROOT ?? process.cwd();
  const fromFile = readJsonFile(preferenceMemoryPath(root));
  if (fromFile != null) return parsePreferenceMemory(fromFile);
  if (store) {
    const raw = store.getMeta(META_PREFERENCE_MEMORY);
    if (raw) {
      try {
        return parsePreferenceMemory(JSON.parse(raw) as unknown);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * File first (`data/preference-memory.json`), then sqlite meta, then defaults.
 * Missing / corrupt files fail-open to stock Laya floors (0.8).
 */
export function loadPreferenceMemory(repoRoot?: string, store?: EventStore): PreferenceMemory {
  return tryLoadPreferenceMemory(repoRoot, store) ?? defaultPreferenceMemory();
}

export function savePreferenceMemory(
  repoRoot: string,
  memory: PreferenceMemory,
  store?: EventStore
): string {
  const filePath = preferenceMemoryPath(repoRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = `${JSON.stringify(memory, null, 2)}\n`;
  fs.writeFileSync(filePath, payload, "utf8");
  store?.setMeta(META_PREFERENCE_MEMORY, JSON.stringify(memory));
  return filePath;
}

function haystack(title: string, body = ""): string {
  return `${title}\n${body}`.replace(/\s+/g, " ").trim().toLowerCase();
}

export function matchesAllowlist(
  title: string,
  body = "",
  memory: PreferenceMemory
): boolean {
  if (!memory.allowlist.length) return false;
  const h = haystack(title, body);
  return memory.allowlist.some((p) => h.includes(p.toLowerCase()));
}

export function matchesBlocklist(
  title: string,
  body = "",
  memory: PreferenceMemory
): boolean {
  if (!memory.blocklist.length) return false;
  const h = haystack(title, body);
  return memory.blocklist.some((p) => h.includes(p.toLowerCase()));
}

/** Short distinctive stem for allow/block patterns. Not a regex. */
export function patternStem(title: string): string | undefined {
  const t = title.replace(/\s+/g, " ").trim();
  if (t.length < RSI_MIN_PATTERN_CHARS) return undefined;
  const sliced = t.slice(0, 24).trim();
  if (sliced.length < RSI_MIN_PATTERN_CHARS) return undefined;
  if (/^[\d\s\p{P}]+$/u.test(sliced)) return undefined;
  return sliced;
}

export function mergePatternList(existing: string[], added: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of [...existing, ...added]) {
    const t = p.trim();
    if (t.length < RSI_MIN_PATTERN_CHARS) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= RSI_MAX_PATTERNS) break;
  }
  return out;
}
