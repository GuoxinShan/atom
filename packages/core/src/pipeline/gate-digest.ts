/**
 * Gate acceptance digest — read-only measurement of the Laya evolution loop.
 *
 * Summarizes extract / merge / outbound / Desk / preference-RSI from the
 * event store over a window (default last 24h). Does not send Yunzhijia,
 * retrain Laya, or write thresholds (preference-rsi already does that).
 *
 * Numbers come only from existing audit fields (`laya_*`, `preference_rsi`,
 * `agent_completed`, Desk decisions). Missing audits stay n/a — never invented.
 */

import {
  loadPreferenceMemory,
  type IrrelevantScope,
  type LayaGateThresholds,
  type MutedSource,
} from "../agents/preference-memory.js";
import type { EventRecord } from "../schema/types.js";
import { EventStore } from "../store/events.js";
import { candidatesByStatus } from "../store/candidates.js";

const WINDOW_LIST_LIMIT = 4000;
const LOOKUP_LIST_LIMIT = 8000;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const REL_SINCE = /^(\d+(?:\.\d+)?)(m|h|d)$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class GateDigestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateDigestError";
  }
}

export type GateDigestCountsExtract = {
  proposed: number;
  noise_dropped: number;
  fail_open: number;
  runs: number;
  laya_noise_dropped: number;
  merged: number;
  already_done: number;
  fail_open_candidates: number;
};

export type GateDigestCountsMerge = {
  merged: number;
  open: number;
  fail_open: number;
};

export type GateDigestCountsOutbound = {
  allow: number;
  drop: number;
  hold: number;
  fail_open: number;
  checks: number;
};

export type GateDigestCountsDesk = {
  accepted: number;
  rejected: number;
  suggested: number;
};

export type GateDigestLastRsi = {
  at: string;
  reason: string;
  changed: boolean;
  apply: boolean;
  deltas: LayaGateThresholds;
  before: LayaGateThresholds;
  after: LayaGateThresholds;
};

export type GateDigestPreference = {
  floors: LayaGateThresholds;
  allowlist: string[];
  blocklist: string[];
  irrelevant: IrrelevantScope[];
  muted_sources: MutedSource[];
  last_rsi: GateDigestLastRsi | null;
};

export type GateDigestProxies = {
  auto_rate: number | null;
  auto_handled: number;
  proposed_to_desk: number;
  auto_rate_note: string;
  override_rate: number | null;
  override_rejected: number;
  override_auditable: number;
  override_rate_note: string;
};

export type GateDigestResult = {
  since: string;
  until: string;
  window_hours: number;
  extract: GateDigestCountsExtract;
  merge: GateDigestCountsMerge;
  outbound: GateDigestCountsOutbound;
  desk: GateDigestCountsDesk;
  preference: GateDigestPreference;
  proxies: GateDigestProxies;
  markdown: string;
};

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

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asBool(v: unknown): boolean {
  return v === true;
}

function roundRate(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function roundHours(ms: number): number {
  return Math.round((ms / 3_600_000) * 10) / 10;
}

function fmtFloor(n: number): string {
  return n.toFixed(2);
}

function shanghaiDateTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

/**
 * Parse `--since` / `?since=` / body.since.
 * Accepts relative (`24h`, `7d`, `30m`), a calendar day (`YYYY-MM-DD` = that
 * midnight Asia/Shanghai), or any Date.parse-able timestamp. Default: 24h ago.
 */
export function resolveGateDigestWindow(
  sinceRaw: string | undefined,
  now = new Date()
): { sinceIso: string; untilIso: string; windowMs: number } {
  const until = now;
  const raw = sinceRaw?.trim();
  let since: Date;

  if (!raw) {
    since = new Date(until.getTime() - DEFAULT_WINDOW_MS);
  } else {
    const rel = REL_SINCE.exec(raw);
    if (rel) {
      const n = Number(rel[1]);
      if (!Number.isFinite(n) || n <= 0) {
        throw new GateDigestError(`invalid since: ${raw}`);
      }
      const unit = rel[2]!.toLowerCase();
      const ms = unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000;
      since = new Date(until.getTime() - ms);
    } else if (ISO_DATE.test(raw)) {
      since = new Date(`${raw}T00:00:00+08:00`);
      if (Number.isNaN(since.getTime())) {
        throw new GateDigestError(`invalid since: ${raw}`);
      }
    } else {
      since = new Date(raw);
      if (Number.isNaN(since.getTime())) {
        throw new GateDigestError(`invalid since: ${raw}`);
      }
    }
  }

  if (since.getTime() > until.getTime()) {
    throw new GateDigestError("since is in the future");
  }

  return {
    sinceIso: since.toISOString(),
    untilIso: until.toISOString(),
    windowMs: until.getTime() - since.getTime(),
  };
}

function listWindow(store: EventStore, type: EventRecord["type"], sinceIso: string, untilIso: string) {
  return store.list({ type, since: sinceIso, until: untilIso, limit: WINDOW_LIST_LIMIT });
}

function isExtractCompleted(detail: Record<string, unknown>): boolean {
  return detail.kind === "extract";
}

function isMergeSweepCompleted(detail: Record<string, unknown>): boolean {
  return detail.kind === "merge-sweep";
}

function isDoneSweepCompleted(detail: Record<string, unknown>): boolean {
  return detail.kind === "done-sweep";
}

function isOutboundCheck(detail: Record<string, unknown>): boolean {
  return detail.kind === "outbound-check";
}

function thresholdsOrNull(v: unknown): LayaGateThresholds | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.noise !== "number" || typeof r.merge !== "number" || typeof r.outbound !== "number") {
    return null;
  }
  return { noise: r.noise, merge: r.merge, outbound: r.outbound };
}

/** Latest auditable preference_rsi apply/dry-run with before/after floors. */
export function readLastPreferenceRsi(store: EventStore): GateDigestLastRsi | null {
  const events = store.listNewest({ type: "preference_rsi", limit: 20 });
  for (const ev of events) {
    const detail = parseDetail(ev.detail_json);
    const before = thresholdsOrNull(detail.before);
    const after = thresholdsOrNull(detail.after);
    const deltas = thresholdsOrNull(detail.deltas);
    if (!before || !after || !deltas) continue;
    return {
      at: ev.created_at,
      reason: typeof detail.reason === "string" ? detail.reason : "unknown",
      changed: detail.changed === true,
      apply: detail.apply !== false,
      deltas,
      before,
      after,
    };
  }
  return null;
}

type ProposedAudit = {
  id: string;
  failOpenGate: boolean;
  failOpenMerge: boolean;
};

function proposedAudits(store: EventStore): Map<string, ProposedAudit> {
  const map = new Map<string, ProposedAudit>();
  for (const ev of store.listNewest({ type: "candidate_proposed", limit: LOOKUP_LIST_LIMIT })) {
    if (map.has(ev.subject_id)) continue;
    const detail = parseDetail(ev.detail_json);
    const gate = asAudit(detail.laya_gate);
    const merge = asAudit(detail.laya_merge);
    map.set(ev.subject_id, {
      id: ev.subject_id,
      failOpenGate: gate?.fail_open === true,
      failOpenMerge: merge?.fail_open === true,
    });
  }
  return map;
}

function isAutoIsh(row: ProposedAudit | undefined): boolean {
  return Boolean(row && (row.failOpenGate || row.failOpenMerge));
}

function formatMarkdown(result: Omit<GateDigestResult, "markdown">): string {
  const hoursLabel = String(result.window_hours);
  const extractLaya =
    result.extract.laya_noise_dropped > 0
      ? `（laya ${result.extract.laya_noise_dropped}）`
      : "";
  const extractFail =
    result.extract.fail_open_candidates > 0
      ? `${result.extract.fail_open}（candidates with laya_gate.fail_open: ${result.extract.fail_open_candidates}）`
      : String(result.extract.fail_open);

  const rsi = result.preference.last_rsi;
  let rsiLine: string;
  if (!rsi) {
    rsiLine = "- last RSI apply: （无 — 尚未 `preference-rsi --apply`）";
  } else {
    const d = rsi.deltas;
    const deltaBits = `noise ${fmtFloor(rsi.before.noise)}→${fmtFloor(rsi.after.noise)}（Δ ${d.noise}） · merge ${fmtFloor(rsi.before.merge)}→${fmtFloor(rsi.after.merge)} · outbound ${fmtFloor(rsi.before.outbound)}→${fmtFloor(rsi.after.outbound)}`;
    rsiLine = `- last RSI apply: ${shanghaiDateTime(rsi.at)} reason=${rsi.reason} changed=${rsi.changed} ${deltaBits}`;
  }

  const floors = result.preference.floors;
  const lists: string[] = [];
  if (result.preference.allowlist.length) {
    lists.push(`- allowlist: ${result.preference.allowlist.join(" | ")}`);
  }
  if (result.preference.blocklist.length) {
    lists.push(`- blocklist: ${result.preference.blocklist.join(" | ")}`);
  }
  if (result.preference.irrelevant.length) {
    const bits = result.preference.irrelevant.map((s) =>
      [s.theme, s.stem, s.source].filter(Boolean).join("/")
    );
    lists.push(`- irrelevant (跟我无关): ${bits.join(" | ")}`);
  }
  if (result.preference.muted_sources.length) {
    const bits = result.preference.muted_sources.map((s) => s.label || s.source);
    lists.push(`- muted sources (来源静音): ${bits.join(" | ")}`);
  }

  const autoDenom = result.proxies.auto_handled + result.proxies.proposed_to_desk;
  const autoPct =
    autoDenom === 0 ? null : Math.round((100 * result.proxies.auto_handled) / autoDenom);
  const auto =
    autoPct == null
      ? `- auto_rate: n/a — ${result.proxies.auto_rate_note}`
      : `- auto_rate: ${autoPct}%  (${result.proxies.auto_handled}/${autoDenom}) = (noise_dropped + merged + already_done) / (those + proposed_to_desk)`;

  const override =
    result.proxies.override_auditable === 0
      ? `- override_rate: n/a — ${result.proxies.override_rate_note}`
      : `- override_rate: ${Math.round((100 * result.proxies.override_rejected) / result.proxies.override_auditable)}%  (${result.proxies.override_rejected}/${result.proxies.override_auditable}) Desk rejects of auto-ish (fail_open) items / auditable auto-ish Desk decisions`;

  return [
    `# ATOM 门控验收 · 最近 ${hoursLabel}h`,
    "",
    `窗口：${shanghaiDateTime(result.since)} → ${shanghaiDateTime(result.until)} (CST)`,
    "",
    "## Extract",
    "",
    `- proposed: ${result.extract.proposed}`,
    `- noise_dropped: ${result.extract.noise_dropped}${extractLaya}`,
    `- already_done: ${result.extract.already_done}`,
    `- fail_open: ${extractFail}`,
    "",
    "## Merge",
    "",
    `- merged: ${result.merge.merged}`,
    `- open (Needs you): ${result.merge.open}`,
    `- fail_open: ${result.merge.fail_open}`,
    "",
    "## Outbound",
    "",
    `- allow: ${result.outbound.allow}`,
    `- drop: ${result.outbound.drop}`,
    `- hold: ${result.outbound.hold}`,
    `- fail_open: ${result.outbound.fail_open}`,
    "",
    "## Desk",
    "",
    `- accepted: ${result.desk.accepted}`,
    `- rejected: ${result.desk.rejected}`,
    `- suggested (Needs you): ${result.desk.suggested}`,
    "",
    "## Preference memory",
    "",
    `- floors: noise ${fmtFloor(floors.noise)} · merge ${fmtFloor(floors.merge)} · outbound ${fmtFloor(floors.outbound)}`,
    rsiLine,
    ...lists,
    "",
    "## 验收代理",
    "",
    auto,
    override,
    "",
    "_只读投影；未发送云之家、未改阈值、未训练 Laya。SQLite events remain source of truth._",
    "",
  ].join("\n");
}

/**
 * Read-only windowed summary. No events, no preference writes, no Laya HTTP.
 */
export function runGateDigest(
  store: EventStore,
  opts?: {
    since?: string;
    now?: Date;
    repoRoot?: string;
  }
): GateDigestResult {
  const now = opts?.now ?? new Date();
  const { sinceIso, untilIso, windowMs } = resolveGateDigestWindow(opts?.since, now);
  const repoRoot = opts?.repoRoot ?? process.env.ATOM_REPO_ROOT ?? process.cwd();

  const extractEvents = listWindow(store, "agent_completed", sinceIso, untilIso);
  const proposedEvents = listWindow(store, "candidate_proposed", sinceIso, untilIso);
  const acceptedEvents = listWindow(store, "decision_accepted", sinceIso, untilIso);
  const rejectedEvents = listWindow(store, "decision_rejected", sinceIso, untilIso);
  const mergedEvents = listWindow(store, "decision_merged", sinceIso, untilIso);

  const extract: GateDigestCountsExtract = {
    proposed: 0,
    noise_dropped: 0,
    fail_open: 0,
    runs: 0,
    laya_noise_dropped: 0,
    merged: 0,
    already_done: 0,
    fail_open_candidates: 0,
  };

  for (const ev of extractEvents) {
    const detail = parseDetail(ev.detail_json);
    if (isExtractCompleted(detail)) {
      extract.runs += 1;
      extract.proposed += asNumber(detail.proposed);
      extract.noise_dropped += asNumber(detail.noise_dropped);
      extract.laya_noise_dropped += asNumber(detail.laya_noise_dropped);
      extract.merged += asNumber(detail.merged);
      extract.already_done += asNumber(detail.already_done);
      if (asBool(detail.laya_fail_open)) extract.fail_open += 1;
    } else if (isDoneSweepCompleted(detail)) {
      extract.already_done += asNumber(detail.closed);
    }
  }

  let mergeFailOpenProposed = 0;
  for (const ev of proposedEvents) {
    const detail = parseDetail(ev.detail_json);
    const gate = asAudit(detail.laya_gate);
    const merge = asAudit(detail.laya_merge);
    if (gate?.fail_open === true) extract.fail_open_candidates += 1;
    if (merge?.fail_open === true) mergeFailOpenProposed += 1;
  }

  const mergeSweepFailOpen = extractEvents.filter((ev) => {
    const detail = parseDetail(ev.detail_json);
    return isMergeSweepCompleted(detail) && asBool(detail.fail_open);
  }).length;

  const merge: GateDigestCountsMerge = {
    merged: mergedEvents.length,
    open: candidatesByStatus(store, "suggested").length,
    fail_open: mergeFailOpenProposed + mergeSweepFailOpen,
  };

  const outbound: GateDigestCountsOutbound = {
    allow: 0,
    drop: 0,
    hold: 0,
    fail_open: 0,
    checks: 0,
  };

  for (const ev of extractEvents) {
    const detail = parseDetail(ev.detail_json);
    if (!isOutboundCheck(detail)) continue;
    outbound.checks += 1;
    const gate = asAudit(detail.laya_outbound);
    const action = typeof gate?.action === "string" ? gate.action : "";
    if (action === "allow") outbound.allow += 1;
    else if (action === "drop") outbound.drop += 1;
    else if (action === "hold") outbound.hold += 1;
    if (gate?.fail_open === true) outbound.fail_open += 1;
  }

  const autoClosedRejects = rejectedEvents.filter((ev) => {
    const detail = parseDetail(ev.detail_json);
    const reason = String(detail.reason ?? "");
    return (
      reason === "already_done" ||
      reason === "irrelevant" ||
      reason === "muted_source" ||
      ev.actor === "system:done-gate" ||
      ev.actor === "system:irrelevant" ||
      ev.actor === "system:muted"
    );
  }).length;

  const desk: GateDigestCountsDesk = {
    accepted: acceptedEvents.length,
    rejected: rejectedEvents.length - autoClosedRejects,
    suggested: merge.open,
  };

  const memory = loadPreferenceMemory(repoRoot, store);
  const preference: GateDigestPreference = {
    floors: { ...memory.thresholds },
    allowlist: [...memory.allowlist],
    blocklist: [...memory.blocklist],
    irrelevant: memory.irrelevant.map((s) => ({ ...s })),
    muted_sources: (memory.muted_sources ?? []).map((s) => ({ ...s })),
    last_rsi: readLastPreferenceRsi(store),
  };

  const autoHandled = extract.noise_dropped + merge.merged + extract.already_done;
  const proposedToDesk = extract.proposed;
  const autoDenom = autoHandled + proposedToDesk;
  let autoRate: number | null = null;
  let autoNote: string;
  if (autoDenom === 0) {
    autoNote = "no extract proposals or auto-handled items in this window";
  } else {
    autoRate = roundRate(autoHandled / autoDenom);
    autoNote = `(noise_dropped ${extract.noise_dropped} + merged ${merge.merged} + already_done ${extract.already_done}) / (those + proposed_to_desk ${proposedToDesk})`;
  }

  const audits = proposedAudits(store);
  let overrideRejected = 0;
  let overrideAuditable = 0;
  for (const ev of [...acceptedEvents, ...rejectedEvents]) {
    if (ev.actor === "system:done-gate" || ev.actor === "system:irrelevant" || ev.actor === "system:muted") continue;
    const row = audits.get(ev.subject_id);
    if (!isAutoIsh(row)) continue;
    overrideAuditable += 1;
    if (ev.type === "decision_rejected") overrideRejected += 1;
  }

  let overrideRate: number | null = null;
  let overrideNote: string;
  if (overrideAuditable === 0) {
    overrideNote =
      "no auditable auto-ish Desk decisions in this window (need laya_gate.fail_open or laya_merge.fail_open on the propose, then accept/reject)";
  } else {
    overrideRate = roundRate(overrideRejected / overrideAuditable);
    overrideNote = `Desk rejects of fail_open (auto-passed) items / ${overrideAuditable} auditable auto-ish decisions`;
  }

  const proxies: GateDigestProxies = {
    auto_rate: autoRate,
    auto_handled: autoHandled,
    proposed_to_desk: proposedToDesk,
    auto_rate_note: autoNote,
    override_rate: overrideRate,
    override_rejected: overrideRejected,
    override_auditable: overrideAuditable,
    override_rate_note: overrideNote,
  };

  const body: Omit<GateDigestResult, "markdown"> = {
    since: sinceIso,
    until: untilIso,
    window_hours: roundHours(windowMs),
    extract,
    merge,
    outbound,
    desk,
    preference,
    proxies,
  };

  return { ...body, markdown: formatMarkdown(body) };
}
