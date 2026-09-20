/**
 * Laya System-1 HTTP client (typed decisions only — never text generation).
 *
 * ATOM uses two endpoints:
 * - POST /v1/predict  — extract → candidate gate (demand vs chat/noise)
 * - POST /v1/route-model — lead handoff → ornith (heavy) vs bonsai (light)
 *
 * Fail-open: timeout, 5xx, or low confidence never blocks the pipeline.
 */

import { LAYA_NOISE_REJECT_REASON } from "./noise.js";

export const DEFAULT_LAYA_URL = "http://127.0.0.1:8790";
export const DEFAULT_LAYA_TIMEOUT_MS = 1500;
export const DEFAULT_LAYA_MIN_CONFIDENCE = 0.8;
export const LAYA_NOISE_REASON = LAYA_NOISE_REJECT_REASON;

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

export function interpretCandidateAnswers(
  answers: Record<string, LayaAnswer>,
  minConfidence = DEFAULT_LAYA_MIN_CONFIDENCE
): LayaCandidateGate {
  const kind = answers.kind;
  const choice = kind?.choice?.toLowerCase();
  const conf = kind?.confidence ?? 0;
  const demandNoul = answers.is_work_demand?.noul;
  const noiseNoul = answers.is_chat_noise?.noul;

  const highNoise =
    (choice === "noise" && conf >= minConfidence) ||
    (typeof noiseNoul === "number" &&
      noiseNoul >= minConfidence &&
      (demandNoul ?? 0) < 0.5);
  const highDemand =
    (choice === "demand" && conf >= minConfidence) ||
    (typeof demandNoul === "number" &&
      demandNoul >= minConfidence &&
      (noiseNoul ?? 0) < 0.5);

  if (highNoise && !highDemand) {
    return {
      action: "noise",
      failOpen: false,
      reason: LAYA_NOISE_REASON,
      kind: choice ?? "noise",
      confidence: conf || noiseNoul,
      demandNoul,
      noiseNoul,
    };
  }
  if (highDemand && !highNoise) {
    return {
      action: "suggested",
      failOpen: false,
      reason: "demand",
      kind: choice ?? "demand",
      confidence: conf || demandNoul,
      demandNoul,
      noiseNoul,
    };
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
  private readonly fetchImpl: LayaFetch;
  /** After timeout / 5xx / network error, skip further calls this run. */
  unavailable = false;

  constructor(opts: LayaClientOptions = {}) {
    this.url = (opts.url ?? DEFAULT_LAYA_URL).replace(/\/$/, "");
    this.enabled = opts.enabled !== false;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_LAYA_TIMEOUT_MS;
    this.minConfidence = opts.minConfidence ?? DEFAULT_LAYA_MIN_CONFIDENCE;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  static fromEnv(overrides: LayaClientOptions = {}): LayaClient {
    return new LayaClient({
      url: process.env.LAYA_URL ?? DEFAULT_LAYA_URL,
      enabled: parseEnabled(process.env.LAYA_ENABLED),
      timeoutMs: parseNumber(process.env.LAYA_TIMEOUT_MS, DEFAULT_LAYA_TIMEOUT_MS),
      minConfidence: parseNumber(process.env.LAYA_MIN_CONFIDENCE, DEFAULT_LAYA_MIN_CONFIDENCE),
      ...overrides,
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private endpoint(path: string): string {
    return new URL(path, `${this.url}/`).toString();
  }

  private async request(path: string, init?: RequestInit): Promise<Response | null> {
    if (!this.enabled || this.unavailable) return null;
    const ctrl = new AbortController();
    const outer = init?.signal;
    if (outer) {
      if (outer.aborted) {
        this.unavailable = true;
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
        if (res.status >= 500) this.unavailable = true;
        return null;
      }
      return res;
    } catch {
      this.unavailable = true;
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
      this.unavailable = true;
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
    if (!ok) this.unavailable = true;
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

  async routeModel(request: string): Promise<LayaModelRoute> {
    const fail: LayaModelRoute = {
      intensity: "unknown",
      failOpen: true,
      reason: "unavailable",
    };
    if (!this.enabled) return fail;
    const raw = await this.requestJson("/v1/route-model", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request }),
    });
    if (raw == null) return fail;
    return interpretRouteModel(raw);
  }

  async gateCandidate(input: { title: string; body?: string }): Promise<LayaCandidateGate> {
    const fail: LayaCandidateGate = {
      action: "suggested",
      failOpen: true,
      reason: "unavailable",
    };
    if (!this.enabled) return fail;
    const predicted = await this.predict({
      title: input.title,
      body: input.body ?? "",
      text: [input.title, input.body].filter(Boolean).join("\n"),
    });
    if (!predicted) return fail;
    return interpretCandidateAnswers(predicted.answers, this.minConfidence);
  }
}
