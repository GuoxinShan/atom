import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { newId } from "../schema/ids.js";
import type { Ref } from "../schema/types.js";
import { openDb } from "../store/db.js";
import { EventStore } from "../store/events.js";
import {
  GateDigestError,
  resolveGateDigestWindow,
  runGateDigest,
} from "./gate-digest.js";
import {
  defaultPreferenceMemory,
  savePreferenceMemory,
  type PreferenceMemory,
} from "../agents/preference-memory.js";

const tmpDirs: string[] = [];

after(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function tempCtx(): Promise<{ store: EventStore; repoRoot: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-gate-digest-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  const db = await openDb(path.join(dir, "data", "atom.sqlite"));
  return { store: new EventStore(db), repoRoot: dir };
}

const ref: Ref = { token: "yzj:im:g:gd", kind: "im", digest: "gd" };

const NOW = new Date("2026-09-21T03:00:00.000Z");
const IN_WINDOW = "2026-09-21T01:00:00.000Z";
const OLD = "2026-09-19T01:00:00.000Z";

function propose(
  store: EventStore,
  title: string,
  extra?: {
    at?: string;
    failOpen?: boolean;
    mergeFailOpen?: boolean;
  }
): string {
  const id = newId("cand");
  store.append({
    type: "candidate_proposed",
    subject_id: id,
    summary: title,
    detail: {
      title,
      body: title,
      confidence: 0.7,
      cluster_key: id,
      laya_gate: {
        action: "suggested",
        fail_open: extra?.failOpen === true,
        reason: extra?.failOpen ? "timeout" : "demand",
        noise_noul: 0.2,
        demand_noul: 0.8,
      },
      laya_merge: extra?.mergeFailOpen
        ? { action: "new", fail_open: true, reason: "ambiguous", same_request: 0.5 }
        : { action: "new", fail_open: false, reason: "distinct", same_request: 0.1 },
    },
    refs: [ref],
    actor: "test",
    created_at: extra?.at ?? IN_WINDOW,
  });
  return id;
}

function accept(store: EventStore, id: string, title: string, at = IN_WINDOW): void {
  store.append({
    type: "decision_accepted",
    subject_id: id,
    summary: `accepted: ${title}`,
    detail: { note: "" },
    refs: [ref],
    actor: "user:local",
    created_at: at,
  });
}

function reject(store: EventStore, id: string, title: string, at = IN_WINDOW): void {
  store.append({
    type: "decision_rejected",
    subject_id: id,
    summary: `rejected: ${title}`,
    detail: { reason: "noise-heuristic" },
    refs: [ref],
    actor: "user:local",
    created_at: at,
  });
}

function mergeDecision(store: EventStore, id: string, title: string, at = IN_WINDOW): void {
  store.append({
    type: "decision_merged",
    subject_id: id,
    summary: `laya merge: ${title}`,
    detail: {
      merged_into: "cand_survivor",
      merged_ids: [id],
      laya_merge: { action: "merge", fail_open: false, reason: "same_request", same_request: 0.92 },
    },
    refs: [ref],
    actor: "system:laya-merge",
    created_at: at,
  });
}

function extractCompleted(
  store: EventStore,
  stats: {
    proposed: number;
    noise_dropped: number;
    merged?: number;
    laya_noise_dropped?: number;
    laya_fail_open?: boolean;
    at?: string;
  }
): void {
  const runId = newId("agent");
  store.append({
    type: "agent_completed",
    subject_id: runId,
    summary: `extract done: stub proposed=${stats.proposed}`,
    detail: {
      agent_id: "stub",
      kind: "extract",
      proposed: stats.proposed,
      skipped: stats.noise_dropped + (stats.merged ?? 0),
      merged: stats.merged ?? 0,
      noise_dropped: stats.noise_dropped,
      laya_noise_dropped: stats.laya_noise_dropped ?? 0,
      laya_merged: stats.merged ?? 0,
      laya_fail_open: stats.laya_fail_open === true,
      message_count: 10,
      seed_count: 8,
    },
    actor: "agent:stub",
    created_at: stats.at ?? IN_WINDOW,
  });
}

function outboundCheck(
  store: EventStore,
  action: "allow" | "drop" | "hold",
  extra?: { failOpen?: boolean; at?: string }
): void {
  const id = newId("agent");
  store.append({
    type: "agent_completed",
    subject_id: id,
    summary: `outbound-check: ${action}`,
    detail: {
      kind: "outbound-check",
      payload_kind: "digest",
      title: "digest",
      delivered: action === "allow",
      laya_outbound: {
        action,
        fail_open: extra?.failOpen === true,
        reason: extra?.failOpen ? "unavailable" : action,
        noise_noul: action === "drop" ? 0.92 : 0.1,
        demand_noul: action === "drop" ? 0.05 : 0.8,
      },
    },
    actor: "system:laya-outbound",
    created_at: extra?.at ?? IN_WINDOW,
  });
}

function preferenceRsiEvent(
  store: EventStore,
  extra?: {
    at?: string;
    reason?: string;
    changed?: boolean;
    before?: { noise: number; merge: number; outbound: number };
    after?: { noise: number; merge: number; outbound: number };
  }
): void {
  const before = extra?.before ?? { noise: 0.8, merge: 0.8, outbound: 0.8 };
  const after = extra?.after ?? { noise: 0.78, merge: 0.8, outbound: 0.8 };
  store.append({
    type: "preference_rsi",
    subject_id: newId("pref"),
    summary: `preference-rsi ${extra?.reason ?? "adjusted"}: noise ${before.noise}→${after.noise}`,
    detail: {
      kind: "preference_rsi",
      apply: true,
      changed: extra?.changed !== false,
      reason: extra?.reason ?? "adjusted",
      samples: { accepted: 5, rejected: 5, merged: 0, suggested: 0 },
      before,
      after,
      deltas: {
        noise: Math.round((after.noise - before.noise) * 100) / 100,
        merge: Math.round((after.merge - before.merge) * 100) / 100,
        outbound: Math.round((after.outbound - before.outbound) * 100) / 100,
      },
    },
    actor: "system:preference-rsi",
    created_at: extra?.at ?? IN_WINDOW,
  });
}

describe("resolveGateDigestWindow", () => {
  it("defaults to the last 24h", () => {
    const w = resolveGateDigestWindow(undefined, NOW);
    assert.equal(w.untilIso, NOW.toISOString());
    assert.equal(w.sinceIso, new Date(NOW.getTime() - 24 * 3600_000).toISOString());
    assert.equal(w.windowMs, 24 * 3600_000);
  });

  it("parses relative 48h / 7d / 30m", () => {
    assert.equal(
      resolveGateDigestWindow("48h", NOW).sinceIso,
      new Date(NOW.getTime() - 48 * 3600_000).toISOString()
    );
    assert.equal(
      resolveGateDigestWindow("7d", NOW).sinceIso,
      new Date(NOW.getTime() - 7 * 86400_000).toISOString()
    );
    assert.equal(
      resolveGateDigestWindow("30m", NOW).sinceIso,
      new Date(NOW.getTime() - 30 * 60_000).toISOString()
    );
  });

  it("parses a calendar day as Asia/Shanghai midnight", () => {
    const w = resolveGateDigestWindow("2026-09-20", NOW);
    assert.equal(w.sinceIso, new Date("2026-09-20T00:00:00+08:00").toISOString());
  });

  it("rejects junk and future timestamps", () => {
    assert.throws(() => resolveGateDigestWindow("nope", NOW), GateDigestError);
    assert.throws(() => resolveGateDigestWindow("2026-09-22T00:00:00.000Z", NOW), /future/);
  });
});

describe("gate digest", () => {
  it("empty store is zeros / n/a, default floors, no invented RSI", async () => {
    const { store, repoRoot } = await tempCtx();
    const before = store.list({ limit: 50 }).length;
    const result = runGateDigest(store, { now: NOW, repoRoot });

    assert.equal(result.extract.proposed, 0);
    assert.equal(result.extract.noise_dropped, 0);
    assert.equal(result.extract.fail_open, 0);
    assert.equal(result.merge.merged, 0);
    assert.equal(result.merge.open, 0);
    assert.equal(result.outbound.checks, 0);
    assert.equal(result.desk.accepted, 0);
    assert.equal(result.desk.rejected, 0);
    assert.equal(result.desk.suggested, 0);
    assert.equal(result.preference.floors.noise, 0.8);
    assert.equal(result.preference.last_rsi, null);
    assert.equal(result.proxies.auto_rate, null);
    assert.equal(result.proxies.override_rate, null);
    assert.match(result.markdown, /auto_rate: n\/a/);
    assert.match(result.markdown, /override_rate: n\/a/);
    assert.match(result.markdown, /尚未 `preference-rsi --apply`/);
    assert.match(result.markdown, /只读投影/);
    assert.equal(store.list({ limit: 50 }).length, before);
  });

  it("counts fixture extract / merge / outbound / Desk events in the window", async () => {
    const { store, repoRoot } = await tempCtx();

    extractCompleted(store, {
      proposed: 4,
      noise_dropped: 12,
      merged: 2,
      laya_noise_dropped: 8,
      laya_fail_open: true,
    });

    const keep = propose(store, "Desk 需要 OAuth 本机登录");
    const failOpen = propose(store, "日历同步失败要修", { failOpen: true });
    const twin = propose(store, "Desk 需要 OAuth 登录 duplicate", { mergeFailOpen: true });
    propose(store, "上下文图谱单机版");
    mergeDecision(store, twin, "Desk 需要 OAuth 登录 duplicate");
    accept(store, keep, "Desk 需要 OAuth 本机登录");
    reject(store, failOpen, "日历同步失败要修");

    outboundCheck(store, "allow");
    outboundCheck(store, "drop");
    outboundCheck(store, "hold");
    outboundCheck(store, "allow", { failOpen: true });

    store.append({
      type: "agent_completed",
      subject_id: newId("agent"),
      summary: "merge-sweep done: merged=0",
      detail: {
        kind: "merge-sweep",
        apply: true,
        considered: 3,
        compared: 2,
        merged: 0,
        skipped: 2,
        fail_open: true,
      },
      actor: "system:laya-merge",
      created_at: IN_WINDOW,
    });

    const result = runGateDigest(store, { now: NOW, repoRoot });

    assert.equal(result.extract.runs, 1);
    assert.equal(result.extract.proposed, 4);
    assert.equal(result.extract.noise_dropped, 12);
    assert.equal(result.extract.laya_noise_dropped, 8);
    assert.equal(result.extract.fail_open, 1);
    assert.equal(result.extract.fail_open_candidates, 1);
    assert.equal(result.merge.merged, 1);
    assert.equal(result.merge.open, 1);
    assert.equal(result.merge.fail_open, 2);
    assert.equal(result.outbound.allow, 2);
    assert.equal(result.outbound.drop, 1);
    assert.equal(result.outbound.hold, 1);
    assert.equal(result.outbound.fail_open, 1);
    assert.equal(result.outbound.checks, 4);
    assert.equal(result.desk.accepted, 1);
    assert.equal(result.desk.rejected, 1);
    assert.equal(result.desk.suggested, 1);

    // auto_rate = (12 + 1) / (12 + 1 + 4) = 13/17
    assert.equal(result.proxies.auto_handled, 13);
    assert.equal(result.proxies.proposed_to_desk, 4);
    assert.equal(result.proxies.auto_rate, Math.round((13 / 17) * 1000) / 1000);

    // fail-open item was rejected; the accepted item was not auto-ish
    assert.equal(result.proxies.override_auditable, 1);
    assert.equal(result.proxies.override_rejected, 1);
    assert.equal(result.proxies.override_rate, 1);

    assert.match(result.markdown, /# ATOM 门控验收/);
    assert.match(result.markdown, /proposed: 4/);
    assert.match(result.markdown, /noise_dropped: 12（laya 8）/);
    assert.match(result.markdown, /auto_rate: 76%/);
    assert.match(result.markdown, /override_rate: 100%/);
  });

  it("ignores events older than --since", async () => {
    const { store, repoRoot } = await tempCtx();
    extractCompleted(store, { proposed: 9, noise_dropped: 9, at: OLD });
    outboundCheck(store, "drop", { at: OLD });
    const oldId = propose(store, "午饭吃什么好呢", { at: OLD });
    reject(store, oldId, "午饭吃什么好呢", OLD);

    extractCompleted(store, { proposed: 1, noise_dropped: 2, at: IN_WINDOW });
    outboundCheck(store, "allow", { at: IN_WINDOW });

    const result = runGateDigest(store, { now: NOW, repoRoot, since: "24h" });
    assert.equal(result.extract.proposed, 1);
    assert.equal(result.extract.noise_dropped, 2);
    assert.equal(result.extract.runs, 1);
    assert.equal(result.outbound.drop, 0);
    assert.equal(result.outbound.allow, 1);
    assert.equal(result.desk.rejected, 0);
  });

  it("override_rate stays n/a when Desk rejects have no fail_open audit", async () => {
    const { store, repoRoot } = await tempCtx();
    extractCompleted(store, { proposed: 1, noise_dropped: 0 });
    const id = propose(store, "需要给 ATOM 加日报");
    reject(store, id, "需要给 ATOM 加日报");

    const result = runGateDigest(store, { now: NOW, repoRoot });
    assert.equal(result.desk.rejected, 1);
    assert.equal(result.proxies.override_rate, null);
    assert.match(result.proxies.override_rate_note, /no auditable auto-ish/);
    assert.match(result.markdown, /override_rate: n\/a/);
  });

  it("reads current floors and last preference_rsi apply delta", async () => {
    const { store, repoRoot } = await tempCtx();
    const memory: PreferenceMemory = {
      ...defaultPreferenceMemory(),
      updated_at: IN_WINDOW,
      cursor_at: IN_WINDOW,
      thresholds: { noise: 0.78, merge: 0.8, outbound: 0.82 },
      allowlist: ["Desk 需要 OAuth"],
    };
    savePreferenceMemory(repoRoot, memory, store);
    preferenceRsiEvent(store, {
      at: OLD,
      before: { noise: 0.8, merge: 0.8, outbound: 0.8 },
      after: { noise: 0.78, merge: 0.8, outbound: 0.82 },
    });

    const result = runGateDigest(store, { now: NOW, repoRoot });
    assert.equal(result.preference.floors.noise, 0.78);
    assert.equal(result.preference.floors.outbound, 0.82);
    assert.ok(result.preference.last_rsi);
    assert.equal(result.preference.last_rsi?.reason, "adjusted");
    assert.equal(result.preference.last_rsi?.deltas.noise, -0.02);
    assert.equal(result.preference.last_rsi?.after.outbound, 0.82);
    assert.match(result.markdown, /floors: noise 0\.78/);
    assert.match(result.markdown, /Δ -0\.02/);
    assert.match(result.markdown, /allowlist: Desk 需要 OAuth/);
  });

  it("does not append events (read-only)", async () => {
    const { store, repoRoot } = await tempCtx();
    extractCompleted(store, { proposed: 2, noise_dropped: 3 });
    const before = store.list({ limit: 200 }).map((e) => e.id);
    runGateDigest(store, { now: NOW, repoRoot });
    runGateDigest(store, { now: NOW, repoRoot, since: "48h" });
    const after = store.list({ limit: 200 }).map((e) => e.id);
    assert.deepEqual(after, before);
  });
});
