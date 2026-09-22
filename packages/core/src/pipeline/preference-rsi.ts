/**
 * Daily (or on-demand) preference RSI for Laya gates.
 *
 * Reads Desk accept / reject / merge outcomes from the event store,
 * computes one conservative step on noise / merge / outbound floors plus
 * allow/block patterns, and optionally persists `data/preference-memory.json`.
 *
 * Does not retrain Laya. Does not send Yunzhijia. Dry-run is the default.
 */

import { isNoiseProposal } from "../agents/noise.js";
import {
  RSI_MIN_SAMPLES,
  RSI_PATTERN_MIN_HITS,
  RSI_STEP,
  clampMergeThreshold,
  clampThreshold,
  loadPreferenceMemory,
  mergeIrrelevant,
  mergePatternList,
  parsePreferenceMemory,
  patternStem,
  savePreferenceMemory,
  type LayaGateThresholds,
  type PreferenceMemory,
} from "../agents/preference-memory.js";
import { loadThemeVocabulary } from "../agents/theme-vocabulary.js";
import { irrelevantSig, scopesFromIrrelevantFeedback } from "./irrelevant.js";
import { newId } from "../schema/ids.js";
import type { CandidateStatus } from "../schema/types.js";
import type { EventStore } from "../store/events.js";

export type PreferenceRsiSamples = {
  accepted: number;
  rejected: number;
  merged: number;
  suggested: number;
  noise_rejects: number;
  fail_open_accepted: number;
  merge_fail_open_merged: number;
  outbound_checks: number;
  outbound_drops: number;
};

export type PreferenceRsiResult = {
  apply: boolean;
  changed: boolean;
  reason: "adjusted" | "sparse" | "noop";
  path: string | null;
  eventId: string | null;
  samples: PreferenceRsiSamples;
  before: LayaGateThresholds;
  after: LayaGateThresholds;
  deltas: LayaGateThresholds;
  added_allowlist: string[];
  added_blocklist: string[];
  allowlist: string[];
  blocklist: string[];
  cursor_at: string | null;
};

type LayaGateAudit = {
  action?: string;
  fail_open?: boolean;
  noise_noul?: number | null;
  demand_noul?: number | null;
};

type LayaMergeAudit = {
  action?: string;
  fail_open?: boolean;
  same_request?: number | null;
};

type FeedbackRow = {
  id: string;
  title: string;
  body: string;
  refs: string[];
  theme?: string;
  tags?: { theme?: string };
  status: CandidateStatus;
  decidedAt?: string;
  layaGate?: LayaGateAudit;
  layaMerge?: LayaMergeAudit;
  rejectReason?: string;
};

function refTokens(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const item of v) {
      if (item && typeof item === "object" && "token" in item) {
        const token = (item as { token?: unknown }).token;
        if (typeof token === "string" && token) out.push(token);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function parseDetail(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function asAudit(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function collectFeedback(store: EventStore, sinceIso: string | null): FeedbackRow[] {
  const events = store.list({ limit: 8000 });
  const map = new Map<string, FeedbackRow>();

  for (const ev of events) {
    const detail = parseDetail(ev.detail_json);
    if (ev.type === "candidate_proposed") {
      const gate = asAudit(detail.laya_gate);
      const merge = asAudit(detail.laya_merge);
      const tags =
        detail.tags && typeof detail.tags === "object" && !Array.isArray(detail.tags)
          ? (detail.tags as { theme?: string })
          : undefined;
      map.set(ev.subject_id, {
        id: ev.subject_id,
        title: String(detail.title ?? ev.summary),
        body: String(detail.body ?? ""),
        refs: refTokens(ev.refs_json),
        theme: typeof detail.theme === "string" ? detail.theme : tags?.theme,
        ...(tags ? { tags } : {}),
        status: "suggested",
        layaGate: gate
          ? {
              action: typeof gate.action === "string" ? gate.action : undefined,
              fail_open: gate.fail_open === true,
              noise_noul: typeof gate.noise_noul === "number" ? gate.noise_noul : null,
              demand_noul: typeof gate.demand_noul === "number" ? gate.demand_noul : null,
            }
          : undefined,
        layaMerge: merge
          ? {
              action: typeof merge.action === "string" ? merge.action : undefined,
              fail_open: merge.fail_open === true,
              same_request: typeof merge.same_request === "number" ? merge.same_request : null,
            }
          : undefined,
      });
      continue;
    }

    const row = map.get(ev.subject_id);
    if (!row) continue;
    if (sinceIso && ev.created_at < sinceIso) continue;

    if (ev.type === "decision_accepted") {
      row.status = "accepted";
      row.decidedAt = ev.created_at;
    } else if (ev.type === "decision_rejected") {
      row.status = "rejected";
      row.decidedAt = ev.created_at;
      row.rejectReason = String(detail.reason ?? "");
    } else if (ev.type === "decision_merged") {
      row.status = "merged";
      row.decidedAt = ev.created_at;
    } else if (ev.type === "decision_reopened") {
      row.status = "suggested";
      row.rejectReason = undefined;
    }
  }

  return [...map.values()];
}

function countOutbound(store: EventStore, sinceIso: string | null): {
  checks: number;
  drops: number;
} {
  let checks = 0;
  let drops = 0;
  for (const ev of store.list({ type: "agent_completed", limit: 2000 })) {
    if (sinceIso && ev.created_at < sinceIso) continue;
    const detail = parseDetail(ev.detail_json);
    if (detail.kind !== "outbound-check") continue;
    checks += 1;
    const gate = asAudit(detail.laya_outbound);
    if (gate?.action === "drop") drops += 1;
  }
  return { checks, drops };
}

function isNoiseReject(row: FeedbackRow): boolean {
  if (row.status !== "rejected") return false;
  const reason = (row.rejectReason ?? "").toLowerCase();
  if (reason.includes("noise")) return true;
  return isNoiseProposal(row.title, row.body);
}

function stepToward(current: number, delta: number, clamp = clampThreshold): number {
  return clamp(current + delta);
}

function deltaFromCounts(down: number, up: number): number {
  if (down >= RSI_MIN_SAMPLES && up >= RSI_MIN_SAMPLES) return 0;
  if (down >= RSI_MIN_SAMPLES) return -RSI_STEP;
  if (up >= RSI_MIN_SAMPLES) return RSI_STEP;
  return 0;
}

function collectPatterns(
  rows: FeedbackRow[],
  pred: (row: FeedbackRow) => boolean
): string[] {
  const hits = new Map<string, { stem: string; n: number }>();
  for (const row of rows) {
    if (!pred(row)) continue;
    const stem = patternStem(row.title);
    if (!stem) continue;
    const key = stem.toLowerCase();
    const cur = hits.get(key);
    if (cur) cur.n += 1;
    else hits.set(key, { stem, n: 1 });
  }
  return [...hits.values()].filter((h) => h.n >= RSI_PATTERN_MIN_HITS).map((h) => h.stem);
}

export function computePreferenceRsi(
  store: EventStore,
  current: PreferenceMemory,
  opts?: { repoRoot?: string }
): {
  memory: PreferenceMemory;
  samples: PreferenceRsiSamples;
  deltas: LayaGateThresholds;
  added_allowlist: string[];
  added_blocklist: string[];
  reason: "adjusted" | "sparse" | "noop";
} {
  const rows = collectFeedback(store, current.cursor_at);
  const outbound = countOutbound(store, current.cursor_at);

  let accepted = 0;
  let rejected = 0;
  let merged = 0;
  let suggested = 0;
  let noiseRejects = 0;
  let failOpenAccepted = 0;
  let mergeFailOpenMerged = 0;

  for (const row of rows) {
    const skipReason = (row.rejectReason ?? "").toLowerCase();
    if (skipReason === "already_done" || skipReason === "irrelevant" || skipReason === "muted_source") continue;
    if (row.status === "accepted") accepted += 1;
    else if (row.status === "rejected") rejected += 1;
    else if (row.status === "merged") merged += 1;
    else suggested += 1;

    if (isNoiseReject(row)) noiseRejects += 1;
    if (row.status === "accepted" && row.layaGate?.fail_open) failOpenAccepted += 1;
    if (row.status === "merged" && row.layaMerge?.fail_open) mergeFailOpenMerged += 1;
  }

  const samples: PreferenceRsiSamples = {
    accepted,
    rejected,
    merged,
    suggested,
    noise_rejects: noiseRejects,
    fail_open_accepted: failOpenAccepted,
    merge_fail_open_merged: mergeFailOpenMerged,
    outbound_checks: outbound.checks,
    outbound_drops: outbound.drops,
  };

  const decided = accepted + rejected + merged;
  if (decided < RSI_MIN_SAMPLES) {
    return {
      memory: current,
      samples,
      deltas: { noise: 0, merge: 0, outbound: 0 },
      added_allowlist: [],
      added_blocklist: [],
      reason: "sparse",
    };
  }

  const noiseDelta = deltaFromCounts(noiseRejects, failOpenAccepted);
  const mergeDelta = deltaFromCounts(mergeFailOpenMerged, 0);
  // Outbound uses the same noul heads as extract noise. Prefer outbound-check
  // drops when present; otherwise reuse Desk noise rejects as a conservative proxy.
  const outboundDown = outbound.checks >= RSI_MIN_SAMPLES ? outbound.drops : noiseRejects;
  const outboundDelta = deltaFromCounts(outboundDown, failOpenAccepted);

  const afterThresholds: LayaGateThresholds = {
    noise: stepToward(current.thresholds.noise, noiseDelta),
    merge: stepToward(current.thresholds.merge, mergeDelta, clampMergeThreshold),
    outbound: stepToward(current.thresholds.outbound, outboundDelta),
  };

  const acceptedStems = new Set(
    rows.filter((r) => r.status === "accepted").map((r) => patternStem(r.title)?.toLowerCase()).filter(Boolean)
  );
  const rejectedStems = new Set(
    rows.filter((r) => r.status === "rejected").map((r) => patternStem(r.title)?.toLowerCase()).filter(Boolean)
  );

  const addedAllow = collectPatterns(
    rows,
    (r) =>
      r.status === "accepted" &&
      Boolean(r.layaGate?.fail_open || (typeof r.layaGate?.noise_noul === "number" && r.layaGate.noise_noul >= 0.4)) &&
      !rejectedStems.has(patternStem(r.title)?.toLowerCase() ?? "")
  );
  const addedBlock = collectPatterns(
    rows,
    (r) => isNoiseReject(r) && !acceptedStems.has(patternStem(r.title)?.toLowerCase() ?? "")
  );

  const allowlist = mergePatternList(current.allowlist, addedAllow);
  const blocklist = mergePatternList(current.blocklist, addedBlock);
  const irrelevant = mergeIrrelevant(
    current.irrelevant,
    scopesFromIrrelevantFeedback(rows, loadThemeVocabulary(opts?.repoRoot))
  );

  const deltas: LayaGateThresholds = {
    noise: roundDelta(afterThresholds.noise - current.thresholds.noise),
    merge: roundDelta(afterThresholds.merge - current.thresholds.merge),
    outbound: roundDelta(afterThresholds.outbound - current.thresholds.outbound),
  };

  const patternsChanged =
    allowlist.join("\0") !== current.allowlist.join("\0") ||
    blocklist.join("\0") !== current.blocklist.join("\0") ||
    irrelevantSig(irrelevant) !== irrelevantSig(current.irrelevant);
  const thresholdsChanged = deltas.noise !== 0 || deltas.merge !== 0 || deltas.outbound !== 0;

  if (!thresholdsChanged && !patternsChanged) {
    return {
      memory: current,
      samples,
      deltas,
      added_allowlist: [],
      added_blocklist: [],
      reason: "noop",
    };
  }

  const nextAllow = allowlist.filter((p) => !current.allowlist.some((e) => e.toLowerCase() === p.toLowerCase()));
  const nextBlock = blocklist.filter((p) => !current.blocklist.some((e) => e.toLowerCase() === p.toLowerCase()));

  return {
    memory: {
      version: 1,
      updated_at: current.updated_at,
      cursor_at: current.cursor_at,
      thresholds: afterThresholds,
      allowlist,
      blocklist,
      irrelevant,
      muted_sources: (current.muted_sources ?? []).map((s) => ({ ...s })),
    },
    samples,
    deltas,
    added_allowlist: nextAllow,
    added_blocklist: nextBlock,
    reason: "adjusted",
  };
}

function roundDelta(n: number): number {
  return Math.round(n * 100) / 100;
}

function toPublic(memory: PreferenceMemory): LayaGateThresholds {
  return { ...memory.thresholds };
}

function appendPreferenceRsiEvent(store: EventStore, result: PreferenceRsiResult): string {
  const id = newId("pref");
  store.append({
    type: "preference_rsi",
    subject_id: id,
    summary: `preference-rsi ${result.reason}: noise ${result.before.noise}→${result.after.noise}`,
    detail: {
      kind: "preference_rsi",
      apply: result.apply,
      changed: result.changed,
      reason: result.reason,
      samples: result.samples,
      before: result.before,
      after: result.after,
      deltas: result.deltas,
      added_allowlist: result.added_allowlist,
      added_blocklist: result.added_blocklist,
      allowlist: result.allowlist,
      blocklist: result.blocklist,
      cursor_at: result.cursor_at,
    },
    actor: "system:preference-rsi",
  });
  return id;
}

/**
 * Dry-run default (no JSON, no meta, no event). `--apply` writes preference
 * memory and a `preference_rsi` audit atom with before/after + sample counts.
 */
export function runPreferenceRsi(
  store: EventStore,
  opts?: {
    apply?: boolean;
    repoRoot?: string;
    now?: Date;
    current?: PreferenceMemory;
  }
): PreferenceRsiResult {
  const apply = opts?.apply === true;
  const repoRoot = opts?.repoRoot ?? process.env.ATOM_REPO_ROOT ?? process.cwd();
  const now = (opts?.now ?? new Date()).toISOString();
  const current = parsePreferenceMemory(opts?.current ?? loadPreferenceMemory(repoRoot, store));

  const computed = computePreferenceRsi(store, current, { repoRoot });
  const changed = computed.reason === "adjusted";
  const next: PreferenceMemory = changed
    ? { ...computed.memory, updated_at: now, cursor_at: now }
    : current;

  const result: PreferenceRsiResult = {
    apply,
    changed,
    reason: computed.reason,
    path: null,
    eventId: null,
    samples: computed.samples,
    before: toPublic(current),
    after: toPublic(next),
    deltas: computed.deltas,
    added_allowlist: computed.added_allowlist,
    added_blocklist: computed.added_blocklist,
    allowlist: next.allowlist,
    blocklist: next.blocklist,
    cursor_at: next.cursor_at,
  };

  if (!apply) {
    console.log(
      `[preference-rsi] dry-run reason=${result.reason} noise ${result.before.noise}→${result.after.noise} (no writes)`
    );
    return result;
  }

  if (changed) {
    result.path = savePreferenceMemory(repoRoot, next, store);
  }
  result.eventId = appendPreferenceRsiEvent(store, result);
  console.log(
    `[preference-rsi] apply reason=${result.reason} noise ${result.before.noise}→${result.after.noise} wrote=${changed ? "yes" : "no"}`
  );
  return result;
}
