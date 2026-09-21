/**
 * Laya System-1 HTTP client (typed decisions only — never text generation).
 *
 * ATOM uses two endpoints:
 * - POST /v1/predict  — extract → candidate noise gate, then duplicate-merge gate;
 *   outbound / pre-post gate (digest, subscription emit, Desk/CLI check)
 * - POST /v1/route-model — lead handoff → ornith (heavy) vs bonsai (light)
 *
 * Fail-open: timeout, 5xx, or truly ambiguous (both noul and choice weak)
 * never blocks the pipeline. Noul is preferred over choice confidence —
 * high same_request / is_chat_noise does not fail-open just because the
 * companion choice head is poorly calibrated.
 * A single per-call timeout fail-opens that candidate (`reason=timeout`)
 * without marking the client unavailable — later candidates still get a
 * predict. Connection refused, repeated 5xx, or /health down mark the
 * client unavailable for the rest of the run (`reason=unavailable`).
 * Laya never auto-approves; Desk remains the human accept/reject gate.
 */

import { LAYA_NOISE_REJECT_REASON } from "./noise.js";
import {
  tryLoadPreferenceMemory,
  type LayaGateThresholds,
} from "./preference-memory.js";

export const DEFAULT_LAYA_URL = "http://127.0.0.1:8790";
/**
 * Per-call HTTP budget. 1.5s covers `/health` and small noise-gate prompts,
 * but Mac CPU Laya + `/v1/predict` with an open-item list (merge gate,
 * up to MERGE_OPEN_ITEMS_CAP snippets) routinely exceeds that. Live runs
 * after the noul-first merge gate then fail-opened remaining siblings
 * with `reason=unavailable` after the first AbortError. 10s is inside the
 * 8–15s window for local CPU inference without stalling extract. Override
 * with LAYA_TIMEOUT_MS.
 */
export const DEFAULT_LAYA_TIMEOUT_MS = 10_000;
/** Consecutive HTTP 5xx responses before the client is marked unavailable. */
export const LAYA_UNAVAILABLE_AFTER_5XX = 2;
export const DEFAULT_LAYA_MIN_CONFIDENCE = 0.8;
/** Auto-merge floor for `same_request`. Preference memory may raise this; never lower. */
export const DEFAULT_LAYA_MERGE_MIN_CONFIDENCE = 0.9;
/** Jaccard floor: below this, titles are a different topic even if same_request is high. */
export const DEFAULT_LAYA_MERGE_TOPIC_MIN = 0.18;
export const LAYA_NOISE_REASON = LAYA_NOISE_REJECT_REASON;
export type LayaTransportFail = "timeout" | "unavailable";

export type LayaFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type LayaAnswer = {
  type?: "choice" | "score" | "noul" | string;
  choice?: string;
  score?: number;
  noul?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
};

export type LayaPredictResult = {
  answers: Record<string, LayaAnswer>;
  raw: unknown;
};

export type CodingIntensity = "heavy" | "light" | "unknown";

export type LayaCandidateGate = {
  action: "suggested" | "noise";
  failOpen: boolean;
  reason: string;
  kind?: string;
  confidence?: number;
  demandNoul?: number;
  noiseNoul?: number;
};

/** Open Needs-you / suggested item sent to Laya for duplicate detection. */
export type OpenItemSnippet = {
  id: string;
  title: string;
  snippet: string;
};

export const MERGE_OPEN_ITEMS_CAP = 8;
export const MERGE_SNIPPET_CHARS = 160;

export type LayaMergeGate = {
  action: "merge" | "new";
  failOpen: boolean;
  reason: string;
  confidence?: number;
  sameRequest?: number;
  topicOverlap?: number;
  targetId?: string;
};

/**
 * Pre-post / outbound gate. Drop high-confidence noise; hold is a high-conf
 * Desk-confirm signal; everything else (including fail-open) is allow.
 * Never auto-sends — Desk remains the irreversible-send authority.
 */
export type LayaOutboundAction = "allow" | "drop" | "hold";

export type LayaOutboundGate = {
  action: LayaOutboundAction;
  failOpen: boolean;
  reason: string;
  kind?: string;
  confidence?: number;
  demandNoul?: number;
  noiseNoul?: number;
};

export type LayaModelRoute = {
  model?: string;
  intensity: CodingIntensity;
  confidence?: number;
  failOpen: boolean;
  reason: string;
};

export type LayaClientOptions = {
  url?: string;
  enabled?: boolean;
  timeoutMs?: number;
  minConfidence?: number;
  /** Per-gate floors from preference memory; default to minConfidence. */
  thresholds?: Partial<LayaGateThresholds>;
  /** Repo root for `data/preference-memory.json` (fromEnv). */
  repoRoot?: string;
  fetch?: LayaFetch;
};

export const CANDIDATE_GATE_QUESTIONS: Record<string, unknown> = {
  kind: {
    type: "choice",
    instructions:
      "Is this a real work demand that should enter ATOM Needs-you, or chat/noise?",
    criteria: {
      demand:
        "actionable work: feature, bug, task, request, 需求 that a human should triage",
      noise:
        "casual chat, social, lunch, weather, ack, bot digest — e.g. 明天一起吃饭 is not a work demand",
    },
  },
  is_work_demand: {
    type: "noul",
    instructions:
      "Is this a real work demand a human should see on the Desk Needs-you queue?",
  },
  is_chat_noise: {
    type: "noul",
    instructions:
      "Is this casual chat or noise rather than a work demand? Treat 「明天一起吃饭」 as noise.",
  },
};

/**
 * Outbound / pre-post questions. Same noul heads as the extract noise gate
 * (no Laya retrain) plus allow|drop|hold choice for the send itself.
 */
export const OUTBOUND_GATE_QUESTIONS: Record<string, unknown> = {
  kind: {
    type: "choice",
    instructions:
      "Should this outbound post (digest, IM, subscription) be sent to humans/groups, dropped as noise, or held for Desk confirm?",
    criteria: {
      allow:
        "real work update, demand digest, or handoff note that humans/groups should receive",
      drop: "casual chat, social, lunch, weather, ack, bot digest — e.g. 明天一起吃饭 must not be posted",
      hold: "uncertain; Desk should confirm before this leaves ATOM",
    },
  },
  is_work_demand: {
    type: "noul",
    instructions:
      "Is this real work content that humans/groups should receive outbound?",
  },
  is_chat_noise: {
    type: "noul",
    instructions:
      "Is this casual chat or noise rather than a work post? Treat 「明天一起吃饭」 as noise that must not be sent.",
  },
};

/** Static merge-gate questions (dict schema, never a list). `target` is filled per open set. */
export const MERGE_GATE_QUESTIONS: Record<string, unknown> = {
  action: {
    type: "choice",
    instructions:
      "Merge this candidate into an existing open Needs-you/suggested item, or create a new suggested ticket?",
    criteria: {
      merge: "duplicate of an existing open item — same underlying user request",
      new: "distinct request that should become its own suggested ticket",
    },
  },
  same_request: {
    type: "noul",
    instructions:
      "Is this the same underlying user request as the best matching open item listed in state.open_items (first item is the best candidate)?",
  },
};

export function snippetText(text: string, max = MERGE_SNIPPET_CHARS): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

export function mergeGateQuestions(openItems: OpenItemSnippet[]): Record<string, unknown> {
  const criteria: Record<string, string> = {
    none: "not a duplicate — create a new suggested ticket",
  };
  for (const item of openItems) {
    criteria[item.id] = `${item.title} — ${item.snippet}`;
  }
  return {
    ...MERGE_GATE_QUESTIONS,
    target: {
      type: "choice",
      instructions:
        "If this is a duplicate, pick the matching open item id. Use none if it is a new request.",
      criteria,
    },
  };
}

function isAbortError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  if (name === "AbortError" || name === "TimeoutError") return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const causeName = (cause as { name?: string }).name;
    if (causeName === "AbortError" || causeName === "TimeoutError") return true;
  }
  return false;
}

function parseEnabled(raw: string | undefined): boolean {
  if (raw == null || raw.trim() === "") return true;
  return !/^(0|false|off|no)$/i.test(raw.trim());
}

function parseNumber(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function parseLayaAnswer(v: unknown): LayaAnswer | null {
  const r = asRecord(v);
  if (!r) return null;
  const answer: LayaAnswer = {};
  if (typeof r.type === "string") answer.type = r.type;
  if (typeof r.choice === "string") answer.choice = r.choice;
  const score = asNumber(r.score);
  if (score != null) answer.score = score;
  const noul = asNumber(r.noul);
  if (noul != null) answer.noul = noul;
  const confidence = asNumber(r.confidence);
  if (confidence != null) answer.confidence = confidence;
  if (r.probabilities && typeof r.probabilities === "object") {
    answer.probabilities = r.probabilities as Record<string, number>;
  }
  if (
    answer.choice == null &&
    answer.score == null &&
    answer.noul == null &&
    answer.confidence == null
  ) {
    return null;
  }
  return answer;
}

export function parsePredictAnswers(raw: unknown): Record<string, LayaAnswer> {
  const root = asRecord(raw);
  if (!root) return {};
  const answersRaw = asRecord(root.answers) ?? root;
  const out: Record<string, LayaAnswer> = {};
  for (const [k, v] of Object.entries(answersRaw)) {
    const parsed = parseLayaAnswer(v);
    if (parsed) out[k] = parsed;
  }
  return out;
}

function noulClears(noul: number | undefined, min: number): boolean {
  return typeof noul === "number" && noul >= min;
}

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

export function effectiveMergeFloor(raw?: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(DEFAULT_LAYA_MERGE_MIN_CONFIDENCE, raw);
  }
  return DEFAULT_LAYA_MERGE_MIN_CONFIDENCE;
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

export function interpretCandidateAnswers(
  answers: Record<string, LayaAnswer>,
  minConfidence = DEFAULT_LAYA_MIN_CONFIDENCE
): LayaCandidateGate {
  const kind = answers.kind;
  const choice = kind?.choice?.toLowerCase();
  const conf = kind?.confidence ?? 0;
  const demandNoul = answers.is_work_demand?.noul;
  const noiseNoul = answers.is_chat_noise?.noul;

  // Prefer is_chat_noise / is_work_demand noul over kind-choice confidence.
  // Live choice calibration is weak; noul is the reliable signal. Choice
  // only breaks ties (both noul high, or both absent/weak). Do not require
  // high kind.confidence if a noul already clears LAYA_MIN_CONFIDENCE.
  const noiseNoulHigh = noulClears(noiseNoul, minConfidence);
  const demandNoulHigh = noulClears(demandNoul, minConfidence);
  const choiceHigh = conf >= minConfidence;

  const noiseGate = (driving: number | undefined): LayaCandidateGate => ({
    action: "noise",
    failOpen: false,
    reason: LAYA_NOISE_REASON,
    kind: choice ?? "noise",
    confidence: driving ?? conf,
    demandNoul,
    noiseNoul,
  });
  const demandGate = (driving: number | undefined): LayaCandidateGate => ({
    action: "suggested",
    failOpen: false,
    reason: "demand",
    kind: choice ?? "demand",
    confidence: driving ?? conf,
    demandNoul,
    noiseNoul,
  });

  if (noiseNoulHigh && !demandNoulHigh) return noiseGate(noiseNoul);
  if (demandNoulHigh && !noiseNoulHigh) return demandGate(demandNoul);

  if (noiseNoulHigh && demandNoulHigh) {
    if (choice === "noise") return noiseGate(noiseNoul);
    if (choice === "demand") return demandGate(demandNoul);
  } else {
    if (choice === "noise" && choiceHigh) return noiseGate(conf);
    if (choice === "demand" && choiceHigh) return demandGate(conf);
  }

  return {
    action: "suggested",
    failOpen: true,
    reason: "ambiguous",
    kind: choice,
    confidence: conf || demandNoul || noiseNoul,
    demandNoul,
    noiseNoul,
  };
}

function outboundChoice(raw: string | undefined): LayaOutboundAction | undefined {
  const c = raw?.toLowerCase();
  if (c === "drop" || c === "noise") return "drop";
  if (c === "hold") return "hold";
  if (c === "allow" || c === "demand") return "allow";
  return undefined;
}

export function interpretOutboundAnswers(
  answers: Record<string, LayaAnswer>,
  minConfidence = DEFAULT_LAYA_MIN_CONFIDENCE
): LayaOutboundGate {
  const kind = answers.kind;
  const mapped = outboundChoice(kind?.choice);
  const conf = kind?.confidence ?? 0;
  const demandNoul = answers.is_work_demand?.noul;
  const noiseNoul = answers.is_chat_noise?.noul;

  // Same noul-first policy as interpretCandidateAnswers. Choice only breaks
  // ties (both noul high, or both absent/weak). High-conf hold is a real
  // Desk-confirm decision — not fail-open.
  const noiseNoulHigh = noulClears(noiseNoul, minConfidence);
  const demandNoulHigh = noulClears(demandNoul, minConfidence);
  const choiceHigh = conf >= minConfidence;

  const dropGate = (driving: number | undefined): LayaOutboundGate => ({
    action: "drop",
    failOpen: false,
    reason: LAYA_NOISE_REASON,
    kind: mapped ?? kind?.choice?.toLowerCase() ?? "drop",
    confidence: driving ?? conf,
    demandNoul,
    noiseNoul,
  });
  const allowGate = (driving: number | undefined): LayaOutboundGate => ({
    action: "allow",
    failOpen: false,
    reason: "demand",
    kind: mapped ?? kind?.choice?.toLowerCase() ?? "allow",
    confidence: driving ?? conf,
    demandNoul,
    noiseNoul,
  });
  const holdGate = (driving: number | undefined): LayaOutboundGate => ({
    action: "hold",
    failOpen: false,
    reason: "hold",
    kind: mapped ?? "hold",
    confidence: driving ?? conf,
    demandNoul,
    noiseNoul,
  });

  if (noiseNoulHigh && !demandNoulHigh) return dropGate(noiseNoul);
  if (demandNoulHigh && !noiseNoulHigh) return allowGate(demandNoul);

  if (noiseNoulHigh && demandNoulHigh) {
    if (mapped === "drop") return dropGate(noiseNoul);
    if (mapped === "hold") return holdGate(Math.max(noiseNoul ?? 0, demandNoul ?? 0, conf));
    if (mapped === "allow") return allowGate(demandNoul);
  } else {
    if (mapped === "drop" && choiceHigh) return dropGate(conf);
    if (mapped === "hold" && choiceHigh) return holdGate(conf);
    if (mapped === "allow" && choiceHigh) return allowGate(conf);
  }

  return {
    action: "allow",
    failOpen: true,
    reason: "ambiguous",
    kind: mapped ?? kind?.choice?.toLowerCase(),
    confidence: conf || demandNoul || noiseNoul,
    demandNoul,
    noiseNoul,
  };
}

export type MergeCandidateText = {
  title?: string;
  body?: string;
};

export function interpretMergeAnswers(
  answers: Record<string, LayaAnswer>,
  openItems: OpenItemSnippet[],
  minConfidence = DEFAULT_LAYA_MERGE_MIN_CONFIDENCE,
  candidate?: MergeCandidateText
): LayaMergeGate {
  const mergeFloor = effectiveMergeFloor(minConfidence);
  const action = answers.action;
  const choice = action?.choice?.toLowerCase();
  const conf = action?.confidence ?? answers.target?.confidence ?? 0;
  const sameRequest = answers.same_request?.noul;
  const targetRaw = answers.target?.choice?.trim();
  const targetIsNone = Boolean(targetRaw && targetRaw.toLowerCase() === "none");
  const validTarget =
    targetRaw && !targetIsNone
      ? openItems.find((item) => item.id === targetRaw)?.id
      : undefined;

  // Confidence policy (noul-first):
  // `action` choice calibration is weak in live Laya; `same_request` noul is
  // the reliable duplicate signal. Do not require high action.confidence when
  // noul already clears the merge floor (default / minimum 0.90).
  //
  // Merge (auto, no Desk) when:
  //   same_request >= mergeFloor
  //   AND a real open-item target id (named, or first item if target omitted —
  //       same_request is defined against the best/first open item)
  //   AND action is merge, missing, or low-confidence (same_request dominates)
  //   AND candidate title/topic is not far from the target card title
  //
  // Conservative fail-open when:
  //   same_request high BUT action is high-confidence "new" (conflict)
  //   same_request high BUT target is "none" or a hallucinated id
  //   both signals weak / timeout / Laya down
  //
  // Distinct new (not fail-open) when:
  //   action is high-confidence "new" AND same_request is not high
  //   OR titles/topics are far apart (even if same_request is high)
  const sameHigh = noulClears(sameRequest, mergeFloor);
  const actionHigh = conf >= mergeFloor;
  const actionMerge = choice === "merge";
  const actionNew = choice === "new";
  const highConfNewConflict = sameHigh && actionNew && actionHigh;

  const targetId =
    validTarget ??
    (!targetRaw && (sameHigh || actionMerge) ? openItems[0]?.id : undefined);
  const targetItem = targetId ? openItems.find((item) => item.id === targetId) : undefined;
  const topicOverlap =
    candidate?.title && targetItem?.title
      ? titleTopicOverlap(candidate.title, targetItem.title)
      : undefined;
  const topicFar =
    typeof topicOverlap === "number" && topicOverlap < DEFAULT_LAYA_MERGE_TOPIC_MIN;

  if (highConfNewConflict) {
    return {
      action: "new",
      failOpen: true,
      reason: "ambiguous",
      confidence: conf || sameRequest,
      sameRequest,
      topicOverlap,
      targetId: validTarget,
    };
  }

  const noulMerge = sameHigh && Boolean(targetId) && !targetIsNone;
  const sameOk = typeof sameRequest !== "number" || sameHigh;
  const choiceMerge = actionMerge && actionHigh && sameOk && Boolean(targetId) && !targetIsNone;

  if ((noulMerge || choiceMerge) && targetId) {
    if (topicFar) {
      return {
        action: "new",
        failOpen: false,
        reason: "topic-mismatch",
        confidence: sameRequest ?? conf,
        sameRequest,
        topicOverlap,
        targetId,
      };
    }
    return {
      action: "merge",
      failOpen: false,
      reason: "duplicate",
      confidence: sameRequest ?? conf,
      sameRequest,
      topicOverlap,
      targetId,
    };
  }

  if (actionNew && actionHigh) {
    return {
      action: "new",
      failOpen: false,
      reason: "distinct",
      confidence: conf || sameRequest,
      sameRequest,
      topicOverlap,
      targetId: validTarget,
    };
  }

  return {
    action: "new",
    failOpen: true,
    reason: openItems.length === 0 ? "no-open-items" : "ambiguous",
    confidence: conf || sameRequest,
    sameRequest,
    topicOverlap,
    targetId: validTarget,
  };
}

function scanModelName(raw: unknown): string | undefined {
  const text = JSON.stringify(raw ?? "").toLowerCase();
  if (/\bornith\b/.test(text)) return "ornith";
  if (/\bbonsai\b/.test(text)) return "bonsai";
  return undefined;
}

export function intensityFromLayaModel(model: string | undefined): CodingIntensity {
  const m = (model ?? "").toLowerCase();
  if (!m) return "unknown";
  if (/ornith|heavy|frontier|large/.test(m)) return "heavy";
  if (/bonsai|light|small|flash/.test(m)) return "light";
  return "unknown";
}

export function interpretRouteModel(raw: unknown): LayaModelRoute {
  const root = asRecord(raw) ?? {};
  const answers = parsePredictAnswers(raw);

  const model =
    asString(root.model) ??
    asString(root.choice) ??
    asString(root.route) ??
    asString(root.selected) ??
    answers.model?.choice ??
    answers.route?.choice ??
    answers.intensity?.choice ??
    scanModelName(raw);

  const confidence =
    asNumber(root.confidence) ??
    answers.model?.confidence ??
    answers.route?.confidence ??
    answers.intensity?.confidence;

  let intensity = intensityFromLayaModel(model);
  if (intensity === "unknown") {
    const difficulty = answers.difficulty?.score;
    const domain = answers.domain?.choice?.toLowerCase();
    if (domain === "chitchat") intensity = "light";
    else if (typeof difficulty === "number" && difficulty >= 2) intensity = "heavy";
    else if (typeof difficulty === "number" && difficulty <= 1) intensity = "light";
  }

  if (!model && intensity === "unknown") {
    return { intensity: "unknown", failOpen: true, reason: "ambiguous", confidence };
  }

  const min = DEFAULT_LAYA_MIN_CONFIDENCE;
  if (typeof confidence === "number" && confidence < min) {
    return {
      model,
      intensity,
      confidence,
      failOpen: true,
      reason: "low-confidence",
    };
  }

  return {
    model,
    intensity,
    confidence,
    failOpen: false,
    reason: model ?? intensity,
  };
}

export function layaGateToDetail(gate: LayaCandidateGate): Record<string, unknown> {
  return {
    action: gate.action,
    kind: gate.kind ?? null,
    confidence: gate.confidence ?? null,
    fail_open: gate.failOpen,
    reason: gate.reason,
    demand_noul: gate.demandNoul ?? null,
    noise_noul: gate.noiseNoul ?? null,
  };
}

export function layaOutboundToDetail(gate: LayaOutboundGate): Record<string, unknown> {
  return {
    action: gate.action,
    kind: gate.kind ?? null,
    confidence: gate.confidence ?? null,
    fail_open: gate.failOpen,
    reason: gate.reason,
    demand_noul: gate.demandNoul ?? null,
    noise_noul: gate.noiseNoul ?? null,
  };
}

export function layaMergeToDetail(gate: LayaMergeGate): Record<string, unknown> {
  return {
    action: gate.action,
    fail_open: gate.failOpen,
    reason: gate.reason,
    confidence: gate.confidence ?? null,
    same_request: gate.sameRequest ?? null,
    topic_overlap: gate.topicOverlap ?? null,
    target_id: gate.targetId ?? null,
  };
}

export function layaModelRouteToDetail(route: LayaModelRoute): Record<string, unknown> {
  return {
    model: route.model ?? null,
    intensity: route.intensity,
    confidence: route.confidence ?? null,
    fail_open: route.failOpen,
    reason: route.reason,
  };
}

export class LayaClient {
  readonly url: string;
  readonly enabled: boolean;
  readonly timeoutMs: number;
  readonly minConfidence: number;
  readonly thresholds: LayaGateThresholds;
  private readonly fetchImpl: LayaFetch;
  /**
   * Hard skip for the rest of this extract/run. Set on connection refused,
   * repeated 5xx, or /health down — not on a single AbortError timeout.
   */
  unavailable = false;
  /** Last transport failure, so audit can tell timeout from true unavailability. */
  lastFailReason: LayaTransportFail = "unavailable";
  private consecutive5xx = 0;

  constructor(opts: LayaClientOptions = {}) {
    this.url = (opts.url ?? DEFAULT_LAYA_URL).replace(/\/$/, "");
    this.enabled = opts.enabled !== false;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_LAYA_TIMEOUT_MS;
    this.minConfidence = opts.minConfidence ?? DEFAULT_LAYA_MIN_CONFIDENCE;
    this.thresholds = {
      noise: opts.thresholds?.noise ?? this.minConfidence,
      merge: effectiveMergeFloor(opts.thresholds?.merge),
      outbound: opts.thresholds?.outbound ?? this.minConfidence,
    };
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  static fromEnv(overrides: LayaClientOptions = {}): LayaClient {
    const repoRoot = overrides.repoRoot ?? process.env.ATOM_REPO_ROOT ?? process.cwd();
    const memory = tryLoadPreferenceMemory(repoRoot);
    const envMin = parseNumber(process.env.LAYA_MIN_CONFIDENCE, DEFAULT_LAYA_MIN_CONFIDENCE);
    return new LayaClient({
      url: process.env.LAYA_URL ?? DEFAULT_LAYA_URL,
      enabled: parseEnabled(process.env.LAYA_ENABLED),
      timeoutMs: parseNumber(process.env.LAYA_TIMEOUT_MS, DEFAULT_LAYA_TIMEOUT_MS),
      minConfidence: envMin,
      thresholds: memory?.thresholds,
      ...overrides,
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private endpoint(path: string): string {
    return new URL(path, `${this.url}/`).toString();
  }

  private markUnavailable(): void {
    this.unavailable = true;
    this.lastFailReason = "unavailable";
  }

  private async request(path: string, init?: RequestInit): Promise<Response | null> {
    if (!this.enabled || this.unavailable) {
      this.lastFailReason = "unavailable";
      return null;
    }
    const ctrl = new AbortController();
    const outer = init?.signal;
    if (outer) {
      if (outer.aborted) {
        this.lastFailReason = "timeout";
        return null;
      }
      outer.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.endpoint(path), {
        ...init,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        this.lastFailReason = "unavailable";
        if (res.status >= 500) {
          this.consecutive5xx += 1;
          if (this.consecutive5xx >= LAYA_UNAVAILABLE_AFTER_5XX) this.markUnavailable();
        }
        return null;
      }
      this.consecutive5xx = 0;
      return res;
    } catch (err) {
      if (isAbortError(err)) {
        this.lastFailReason = "timeout";
        return null;
      }
      this.markUnavailable();
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async requestJson(path: string, init?: RequestInit): Promise<unknown | null> {
    const res = await this.request(path, init);
    if (!res) return null;
    try {
      return await res.json();
    } catch {
      this.lastFailReason = "unavailable";
      return null;
    }
  }

  async health(): Promise<boolean> {
    const res = await this.request("/health", { method: "GET" });
    return Boolean(res?.ok);
  }

  async ensureUp(): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.unavailable) return false;
    const ok = await this.health();
    if (!ok) this.markUnavailable();
    return ok;
  }

  async predict(
    state: Record<string, unknown>,
    questions: Record<string, unknown> = CANDIDATE_GATE_QUESTIONS
  ): Promise<LayaPredictResult | null> {
    const raw = await this.requestJson("/v1/predict", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state, questions }),
    });
    if (raw == null) return null;
    return { answers: parsePredictAnswers(raw), raw };
  }

  private transportFail(): LayaTransportFail {
    return this.unavailable ? "unavailable" : this.lastFailReason;
  }

  async routeModel(request: string): Promise<LayaModelRoute> {
    if (!this.enabled) {
      return { intensity: "unknown", failOpen: true, reason: "unavailable" };
    }
    const raw = await this.requestJson("/v1/route-model", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request }),
    });
    if (raw == null) {
      return { intensity: "unknown", failOpen: true, reason: this.transportFail() };
    }
    return interpretRouteModel(raw);
  }

  async gateCandidate(input: { title: string; body?: string }): Promise<LayaCandidateGate> {
    if (!this.enabled) {
      return { action: "suggested", failOpen: true, reason: "unavailable" };
    }
    const predicted = await this.predict({
      title: input.title,
      body: input.body ?? "",
      text: [input.title, input.body].filter(Boolean).join("\n"),
    });
    if (!predicted) {
      return { action: "suggested", failOpen: true, reason: this.transportFail() };
    }
    return interpretCandidateAnswers(predicted.answers, this.thresholds.noise);
  }

  async gateOutbound(input: {
    title: string;
    body?: string;
    kind?: string;
  }): Promise<LayaOutboundGate> {
    if (!this.enabled) {
      return { action: "allow", failOpen: true, reason: "unavailable" };
    }
    const predicted = await this.predict(
      {
        title: input.title,
        body: input.body ?? "",
        text: [input.title, input.body].filter(Boolean).join("\n"),
        payload_kind: input.kind ?? "outbound",
        channel: "outbound",
      },
      OUTBOUND_GATE_QUESTIONS
    );
    if (!predicted) {
      return { action: "allow", failOpen: true, reason: this.transportFail() };
    }
    return interpretOutboundAnswers(predicted.answers, this.thresholds.outbound);
  }

  async gateMerge(input: {
    title: string;
    body?: string;
    openItems: OpenItemSnippet[];
  }): Promise<LayaMergeGate> {
    if (!this.enabled) {
      return { action: "new", failOpen: true, reason: "unavailable" };
    }
    if (!input.openItems.length) {
      return { action: "new", failOpen: false, reason: "no-open-items" };
    }
    const predicted = await this.predict(
      {
        title: input.title,
        body: input.body ?? "",
        text: [input.title, input.body].filter(Boolean).join("\n"),
        open_items: input.openItems,
        best_candidate: input.openItems[0],
      },
      mergeGateQuestions(input.openItems)
    );
    if (!predicted) {
      return { action: "new", failOpen: true, reason: this.transportFail() };
    }
    return interpretMergeAnswers(predicted.answers, input.openItems, this.thresholds.merge, {
      title: input.title,
      body: input.body,
    });
  }
}
