import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { LayaClient } from "../agents/laya.js";
import {
  RSI_DEFAULT_THRESHOLD,
  RSI_MAX_THRESHOLD,
  RSI_MIN_SAMPLES,
  RSI_MIN_THRESHOLD,
  defaultPreferenceMemory,
  loadPreferenceMemory,
  matchesAllowlist,
  matchesBlocklist,
  preferenceMemoryPath,
  savePreferenceMemory,
  type PreferenceMemory,
} from "../agents/preference-memory.js";
import { newId } from "../schema/ids.js";
import type { Ref } from "../schema/types.js";
import { openDb } from "../store/db.js";
import { EventStore } from "../store/events.js";
import { runPreferenceRsi } from "./preference-rsi.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-rsi-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  const db = await openDb(path.join(dir, "data", "atom.sqlite"));
  return { store: new EventStore(db), repoRoot: dir };
}

const ref: Ref = { token: "yzj:im:g:rsi", kind: "im", digest: "rsi" };

function propose(
  store: EventStore,
  title: string,
  extra?: {
    body?: string;
    failOpen?: boolean;
    mergeFailOpen?: boolean;
    noiseNoul?: number;
  }
): string {
  const id = newId("cand");
  store.append({
    type: "candidate_proposed",
    subject_id: id,
    summary: title,
    detail: {
      title,
      body: extra?.body ?? title,
      confidence: 0.7,
      cluster_key: id,
      laya_gate: {
        action: "suggested",
        fail_open: extra?.failOpen === true,
        reason: extra?.failOpen ? "ambiguous" : "demand",
        noise_noul: extra?.noiseNoul ?? 0.4,
        demand_noul: 0.5,
      },
      laya_merge: extra?.mergeFailOpen
        ? { action: "new", fail_open: true, reason: "ambiguous", same_request: 0.72 }
        : undefined,
    },
    refs: [ref],
    actor: "test",
  });
  return id;
}

function reject(store: EventStore, id: string, title: string, reason: string): void {
  store.append({
    type: "decision_rejected",
    subject_id: id,
    summary: `rejected: ${title}`,
    detail: { reason },
    refs: [ref],
    actor: "user:local",
  });
}

function accept(store: EventStore, id: string, title: string): void {
  store.append({
    type: "decision_accepted",
    subject_id: id,
    summary: `accepted: ${title}`,
    detail: { note: "" },
    refs: [ref],
    actor: "user:local",
  });
}

function merge(store: EventStore, id: string, title: string): void {
  store.append({
    type: "decision_merged",
    subject_id: id,
    summary: `laya merge: ${title}`,
    detail: { merged_into: "cand_survivor", merged_ids: [id] },
    refs: [ref],
    actor: "system:laya-merge",
  });
}

function seedNoiseRejects(store: EventStore, n: number): void {
  for (let i = 0; i < n; i++) {
    const title = `午饭吃什么好呢 ${i} 天气不错`;
    const id = propose(store, title);
    reject(store, id, title, "noise-heuristic");
  }
}

function seedFailOpenAccepts(store: EventStore, n: number): void {
  for (let i = 0; i < n; i++) {
    const title = `需要给 ATOM Desk 加上 OAuth 登录 ${i}`;
    const id = propose(store, title, { failOpen: true, noiseNoul: 0.55 });
    accept(store, id, title);
  }
}

function seedMergeFailOpens(store: EventStore, n: number): void {
  for (let i = 0; i < n; i++) {
    const title = `Desk 需要 OAuth 本机登录 duplicate ${i}`;
    const id = propose(store, title, { mergeFailOpen: true });
    merge(store, id, title);
  }
}

describe("preference RSI", () => {
  it("enough feedback lowers the noise floor within clamps", async () => {
    const { store, repoRoot } = await tempCtx();
    seedNoiseRejects(store, RSI_MIN_SAMPLES);
    const result = runPreferenceRsi(store, { apply: true, repoRoot });

    assert.equal(result.reason, "adjusted");
    assert.equal(result.changed, true);
    assert.equal(result.apply, true);
    assert.equal(result.samples.noise_rejects, RSI_MIN_SAMPLES);
    assert.equal(result.before.noise, RSI_DEFAULT_THRESHOLD);
    assert.equal(result.after.noise, 0.78);
    assert.ok(result.after.noise >= RSI_MIN_THRESHOLD);
    assert.ok(result.after.noise <= RSI_MAX_THRESHOLD);
    assert.equal(result.after.merge, RSI_DEFAULT_THRESHOLD);
    assert.ok(result.eventId);
    assert.ok(result.path);
    assert.equal(fs.existsSync(preferenceMemoryPath(repoRoot)), true);

    const loaded = loadPreferenceMemory(repoRoot, store);
    assert.equal(loaded.thresholds.noise, 0.78);

    const ev = store.list({ type: "preference_rsi" }).at(-1);
    assert.ok(ev);
    const detail = JSON.parse(ev!.detail_json) as {
      reason?: string;
      samples?: { noise_rejects?: number };
      before?: { noise?: number };
      after?: { noise?: number };
    };
    assert.equal(detail.reason, "adjusted");
    assert.equal(detail.samples?.noise_rejects, RSI_MIN_SAMPLES);
    assert.equal(detail.before?.noise, RSI_DEFAULT_THRESHOLD);
    assert.equal(detail.after?.noise, 0.78);
  });

  it("enough fail-open accepts raise the noise floor (harder to drop)", async () => {
    const { store, repoRoot } = await tempCtx();
    seedFailOpenAccepts(store, RSI_MIN_SAMPLES);
    const result = runPreferenceRsi(store, { apply: true, repoRoot });
    assert.equal(result.reason, "adjusted");
    assert.equal(result.after.noise, 0.82);
    assert.ok(result.after.noise <= RSI_MAX_THRESHOLD);
    assert.ok(result.added_allowlist.length >= 1);
  });

  it("enough later-merged fail-opens lower the merge floor", async () => {
    const { store, repoRoot } = await tempCtx();
    seedMergeFailOpens(store, RSI_MIN_SAMPLES);
    const result = runPreferenceRsi(store, { apply: true, repoRoot });
    assert.equal(result.reason, "adjusted");
    assert.equal(result.samples.merge_fail_open_merged, RSI_MIN_SAMPLES);
    assert.equal(result.after.merge, 0.78);
    assert.equal(result.after.noise, RSI_DEFAULT_THRESHOLD);
  });

  it("clamps so a low floor cannot fall below the minimum", async () => {
    const { store, repoRoot } = await tempCtx();
    const current: PreferenceMemory = {
      ...defaultPreferenceMemory(),
      thresholds: {
        noise: RSI_MIN_THRESHOLD,
        merge: RSI_MIN_THRESHOLD,
        outbound: RSI_MIN_THRESHOLD,
      },
    };
    seedNoiseRejects(store, RSI_MIN_SAMPLES);
    const result = runPreferenceRsi(store, { apply: true, repoRoot, current });
    assert.equal(result.after.noise, RSI_MIN_THRESHOLD);
    assert.ok(result.after.noise >= RSI_MIN_THRESHOLD);
  });

  it("sparse feedback is a no-op", async () => {
    const { store, repoRoot } = await tempCtx();
    seedNoiseRejects(store, 2);
    const result = runPreferenceRsi(store, { apply: true, repoRoot });
    assert.equal(result.reason, "sparse");
    assert.equal(result.changed, false);
    assert.equal(result.after.noise, RSI_DEFAULT_THRESHOLD);
    assert.deepEqual(result.after, result.before);
    assert.equal(result.deltas.noise, 0);
    assert.equal(fs.existsSync(preferenceMemoryPath(repoRoot)), false);
    assert.equal(store.getMeta("preference_memory"), null);
    // apply still audits the no-op
    assert.ok(result.eventId);
    assert.equal(store.list({ type: "preference_rsi" }).length, 1);
  });

  it("dry-run does not write memory, meta, or a preference_rsi event", async () => {
    const { store, repoRoot } = await tempCtx();
    seedNoiseRejects(store, RSI_MIN_SAMPLES);
    const result = runPreferenceRsi(store, { apply: false, repoRoot });

    assert.equal(result.apply, false);
    assert.equal(result.changed, true);
    assert.equal(result.reason, "adjusted");
    assert.equal(result.after.noise, 0.78);
    assert.equal(result.path, null);
    assert.equal(result.eventId, null);
    assert.equal(fs.existsSync(preferenceMemoryPath(repoRoot)), false);
    assert.equal(store.getMeta("preference_memory"), null);
    assert.equal(store.list({ type: "preference_rsi" }).length, 0);

    const again = loadPreferenceMemory(repoRoot, store);
    assert.equal(again.thresholds.noise, RSI_DEFAULT_THRESHOLD);
  });
});

describe("preference memory → Laya callers", () => {
  it("LayaClient.fromEnv loads tuned per-gate floors from data/", async () => {
    const { repoRoot } = await tempCtx();
    savePreferenceMemory(repoRoot, {
      ...defaultPreferenceMemory(),
      updated_at: new Date().toISOString(),
      thresholds: { noise: 0.74, merge: 0.82, outbound: 0.9 },
    });
    const client = LayaClient.fromEnv({ repoRoot, enabled: false });
    assert.equal(client.thresholds.noise, 0.74);
    assert.equal(client.thresholds.merge, 0.82);
    assert.equal(client.thresholds.outbound, 0.9);
  });

  it("allowlist / blocklist match title stems", () => {
    const memory: PreferenceMemory = {
      ...defaultPreferenceMemory(),
      allowlist: ["Desk 需要 OAuth"],
      blocklist: ["午饭吃什么"],
    };
    assert.equal(matchesAllowlist("Desk 需要 OAuth 本机登录", "", memory), true);
    assert.equal(matchesBlocklist("午饭吃什么好呢 0 天气不错", "", memory), true);
    assert.equal(matchesAllowlist("日历同步失败", "", memory), false);
  });
});
