import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { LayaClient, type LayaFetch } from "../agents/laya.js";
import { openDb } from "../store/db.js";
import { EventStore } from "../store/events.js";
import { projectCandidates } from "../store/candidates.js";
import { newId } from "../schema/ids.js";
import type { Ref } from "../schema/types.js";
import { runMergeSweep } from "./merge-sweep.js";

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

async function tempStore(): Promise<EventStore> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-sweep-"));
  tmpDirs.push(dir);
  const db = await openDb(path.join(dir, "atom.sqlite"));
  return new EventStore(db);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function abortErr(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

type Call = { url: string; body?: unknown };

function recordingFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: Call[] = [];
  const fetch: LayaFetch = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (init?.signal?.aborted) throw abortErr();
    return impl(url, init);
  };
  return { fetch, calls };
}

function hangFetch(): LayaFetch {
  return async (_url, init) => {
    await new Promise<never>((_, reject) => {
      const s = init?.signal;
      if (!s) return;
      if (s.aborted) {
        reject(abortErr());
        return;
      }
      s.addEventListener("abort", () => reject(abortErr()), { once: true });
    });
    throw new Error("unreachable");
  };
}

function isMergePredict(body: unknown): boolean {
  const q = (body as { questions?: Record<string, unknown> })?.questions;
  return Boolean(q && typeof q === "object" && !Array.isArray(q) && "action" in q && "same_request" in q);
}

const oauthRef: Ref = { token: "yzj:im:g:oauth", kind: "im", digest: "oauth" };
const oauthDupRef: Ref = { token: "yzj:im:g:oauth-dup", kind: "im", digest: "oauth-dup" };
const calRef: Ref = { token: "yzj:im:g:cal", kind: "im", digest: "cal" };

function seedSuggested(
  store: EventStore,
  title: string,
  body: string,
  refs: Ref[] = [oauthRef],
  createdAt?: string
): string {
  const id = newId("cand");
  store.append({
    type: "candidate_proposed",
    subject_id: id,
    summary: title,
    detail: {
      title,
      body,
      confidence: 0.8,
      cluster_key: `existing-${id}`,
    },
    refs,
    actor: "test",
    created_at: createdAt,
  });
  return id;
}

function mergeAnswers(targetId: string) {
  return {
    answers: {
      action: { choice: "merge", confidence: 0.94 },
      same_request: { noul: 0.92 },
      target: { choice: targetId, confidence: 0.93 },
    },
  };
}

function distinctAnswers() {
  return {
    answers: {
      action: { choice: "new", confidence: 0.91 },
      same_request: { noul: 0.07 },
      target: { choice: "none", confidence: 0.9 },
    },
  };
}

describe("merge-sweep dry-run vs apply", () => {
  it("dry-run (default) prints a high-confidence merge and writes nothing", async () => {
    const store = await tempStore();
    const older = seedSuggested(
      store,
      "需要给 ATOM Desk 加上 OAuth 登录",
      "必须支持本机登录后才能批候选",
      [oauthRef],
      "2026-09-20T10:00:00.000Z"
    );
    const newer = seedSuggested(
      store,
      "Desk 需要 OAuth 本机登录",
      "必须支持登录后才能批候选，和已有建议是同一需求",
      [oauthDupRef],
      "2026-09-20T11:00:00.000Z"
    );
    const { fetch, calls } = recordingFetch(async (url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      assert.equal(isMergePredict(body), true);
      return jsonResponse(mergeAnswers(older));
    });
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const result = await runMergeSweep(store, { laya });

    assert.equal(result.apply, false);
    assert.equal(result.considered, 2);
    assert.equal(result.merged, 1);
    assert.equal(result.pairs[0]?.loserId, newer);
    assert.equal(result.pairs[0]?.survivorId, older);
    assert.equal(result.pairs[0]?.sameRequest, 0.92);
    assert.equal(store.list({ type: "decision_merged" }).length, 0);
    assert.equal(store.list({ type: "agent_started" }).length, 0);
    const suggested = projectCandidates(store).filter((c) => c.status === "suggested");
    assert.equal(suggested.length, 2);
    assert.equal(
      calls.filter((c) => c.url.endsWith("/v1/predict")).length,
      1
    );
  });

  it("apply writes decision_merged on the loser and attaches refs to the survivor", async () => {
    const store = await tempStore();
    const older = seedSuggested(
      store,
      "需要给 ATOM Desk 加上 OAuth 登录",
      "必须支持本机登录后才能批候选",
      [oauthRef],
      "2026-09-20T10:00:00.000Z"
    );
    const newer = seedSuggested(
      store,
      "Desk 需要 OAuth 本机登录",
      "必须支持登录后才能批候选，和已有建议是同一需求",
      [oauthDupRef],
      "2026-09-20T11:00:00.000Z"
    );
    const { fetch } = recordingFetch(async (url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (isMergePredict(body)) return jsonResponse(mergeAnswers(older));
      return jsonResponse(distinctAnswers());
    });
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const result = await runMergeSweep(store, { apply: true, laya });

    assert.equal(result.apply, true);
    assert.equal(result.merged, 1);
    const suggested = projectCandidates(store).filter((c) => c.status === "suggested");
    assert.equal(suggested.length, 1);
    assert.equal(suggested[0]?.id, older);
    assert.equal(
      suggested[0]?.refs.some((r) => r.token === oauthDupRef.token),
      true
    );
    const merged = projectCandidates(store).filter((c) => c.status === "merged");
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.id, newer);
    const ev = store.list({ type: "decision_merged" }).at(-1);
    assert.ok(ev);
    assert.equal(ev!.subject_id, newer);
    assert.equal(ev!.actor, "system:laya-merge");
    const detail = JSON.parse(ev!.detail_json) as {
      merged_into?: string;
      merged_ids?: string[];
      laya_merge?: { action?: string; target_id?: string; fail_open?: boolean; same_request?: number };
    };
    assert.equal(detail.merged_into, older);
    assert.deepEqual(detail.merged_ids, [newer]);
    assert.equal(detail.laya_merge?.action, "merge");
    assert.equal(detail.laya_merge?.target_id, older);
    assert.equal(detail.laya_merge?.fail_open, false);
    assert.equal(detail.laya_merge?.same_request, 0.92);
    const proposedCount = store.list({ type: "candidate_proposed" }).length;
    assert.equal(proposedCount, 2);
  });

  it("apply is idempotent — already-merged twins are skipped", async () => {
    const store = await tempStore();
    const older = seedSuggested(
      store,
      "需要给 ATOM Desk 加上 OAuth 登录",
      "必须支持本机登录后才能批候选",
      [oauthRef],
      "2026-09-20T10:00:00.000Z"
    );
    seedSuggested(
      store,
      "Desk 需要 OAuth 本机登录",
      "必须支持登录后才能批候选",
      [oauthDupRef],
      "2026-09-20T11:00:00.000Z"
    );
    const { fetch } = recordingFetch(async (url) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      return jsonResponse(mergeAnswers(older));
    });
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const first = await runMergeSweep(store, { apply: true, laya });
    assert.equal(first.merged, 1);
    const second = await runMergeSweep(store, { apply: true, laya });
    assert.equal(second.considered, 1);
    assert.equal(second.merged, 0);
    assert.equal(store.list({ type: "decision_merged" }).length, 1);
  });

  it("never merges into a rejected or accepted item", async () => {
    const store = await tempStore();
    const rejectedId = seedSuggested(
      store,
      "需要给 ATOM Desk 加上 OAuth 登录",
      "必须支持本机登录后才能批候选",
      [oauthRef],
      "2026-09-20T10:00:00.000Z"
    );
    store.append({
      type: "decision_rejected",
      subject_id: rejectedId,
      summary: "rejected",
      actor: "test",
      created_at: "2026-09-20T10:30:00.000Z",
    });
    const openId = seedSuggested(
      store,
      "Desk 需要 OAuth 本机登录",
      "必须支持登录后才能批候选",
      [oauthDupRef],
      "2026-09-20T11:00:00.000Z"
    );
    const other = seedSuggested(
      store,
      "需要给 1023 日历加上日程冲突提醒",
      "用户希望在两个会议重叠时收到提醒",
      [calRef],
      "2026-09-20T12:00:00.000Z"
    );
    const { fetch, calls } = recordingFetch(async (url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const items = (body.state as { open_items?: Array<{ id: string }> })?.open_items ?? [];
      assert.equal(
        items.some((i) => i.id === rejectedId),
        false
      );
      return jsonResponse(distinctAnswers());
    });
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const result = await runMergeSweep(store, { apply: true, laya });
    assert.equal(result.merged, 0);
    const byId = Object.fromEntries(projectCandidates(store).map((c) => [c.id, c.status]));
    assert.equal(byId[rejectedId], "rejected");
    assert.equal(byId[openId], "suggested");
    assert.equal(byId[other], "suggested");
    assert.equal(store.list({ type: "decision_merged" }).length, 0);
    assert.equal(calls.some((c) => c.url.endsWith("/v1/predict")), true);
  });

  it("fail-opens a timed-out pair without poisoning later compares", async () => {
    const store = await tempStore();
    const older = seedSuggested(
      store,
      "需要给 ATOM Desk 加上 OAuth 登录",
      "必须支持本机登录后才能批候选",
      [oauthRef],
      "2026-09-20T10:00:00.000Z"
    );
    seedSuggested(
      store,
      "明天把周报发一下",
      "群里催一下周报，不是同一需求",
      [{ token: "yzj:im:g:weekly", kind: "im", digest: "weekly" }],
      "2026-09-20T11:00:00.000Z"
    );
    const newest = seedSuggested(
      store,
      "Desk 需要 OAuth 本机登录",
      "必须支持登录后才能批候选，和已有建议是同一需求",
      [oauthDupRef],
      "2026-09-20T12:00:00.000Z"
    );
    let mergeAttempts = 0;
    const { fetch } = recordingFetch(async (url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      mergeAttempts += 1;
      if (mergeAttempts === 1) return hangFetch()(url, init);
      return jsonResponse(mergeAnswers(older));
    });
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 40 });
    const result = await runMergeSweep(store, { apply: true, laya });

    assert.equal(mergeAttempts, 2);
    assert.equal(laya.unavailable, false);
    assert.equal(result.failOpen, true);
    assert.equal(result.merged, 1);
    assert.equal(result.pairs[0]?.loserId, newest);
    assert.equal(result.pairs[0]?.survivorId, older);
    const statuses = Object.fromEntries(projectCandidates(store).map((c) => [c.id, c.status]));
    assert.equal(statuses[older], "suggested");
    assert.equal(statuses[newest], "merged");
  });

  it("does not merge when Laya fail-opens a conflict", async () => {
    const store = await tempStore();
    seedSuggested(
      store,
      "需要给 ATOM Desk 加上 OAuth 登录",
      "必须支持本机登录后才能批候选",
      [oauthRef],
      "2026-09-20T10:00:00.000Z"
    );
    seedSuggested(
      store,
      "Desk 需要 OAuth 本机登录",
      "必须支持登录后才能批候选",
      [oauthDupRef],
      "2026-09-20T11:00:00.000Z"
    );
    const { fetch } = recordingFetch(async (url) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      return jsonResponse({
        answers: {
          action: { choice: "new", confidence: 0.91 },
          same_request: { noul: 0.97 },
          target: { choice: "none", confidence: 0.88 },
        },
      });
    });
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const result = await runMergeSweep(store, { apply: true, laya });
    assert.equal(result.merged, 0);
    assert.equal(result.failOpen, true);
    assert.equal(store.list({ type: "decision_merged" }).length, 0);
    assert.equal(projectCandidates(store).filter((c) => c.status === "suggested").length, 2);
  });

  it("merges when same_request noul is high even if action confidence is low", async () => {
    const store = await tempStore();
    const older = seedSuggested(
      store,
      "需要给 ATOM Desk 加上 OAuth 登录",
      "必须支持本机登录后才能批候选",
      [oauthRef],
      "2026-09-20T10:00:00.000Z"
    );
    const newer = seedSuggested(
      store,
      "Desk 需要 OAuth 本机登录",
      "必须支持登录后才能批候选",
      [oauthDupRef],
      "2026-09-20T11:00:00.000Z"
    );
    const { fetch } = recordingFetch(async (url) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      return jsonResponse({
        answers: {
          action: { choice: "merge", confidence: 0.18 },
          same_request: { noul: 0.98 },
          target: { choice: older, confidence: 0.2 },
        },
      });
    });
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const result = await runMergeSweep(store, { apply: true, laya });
    assert.equal(result.merged, 1);
    assert.equal(result.pairs[0]?.loserId, newer);
    assert.equal(result.pairs[0]?.sameRequest, 0.98);
    const ev = store.list({ type: "decision_merged" }).at(-1);
    const detail = JSON.parse(ev!.detail_json) as {
      laya_merge?: { same_request?: number; confidence?: number; fail_open?: boolean };
    };
    assert.equal(detail.laya_merge?.same_request, 0.98);
    assert.equal(detail.laya_merge?.confidence, 0.98);
    assert.equal(detail.laya_merge?.fail_open, false);
  });

  it("fail-opens the whole sweep when Laya is down and writes nothing", async () => {
    const store = await tempStore();
    seedSuggested(
      store,
      "需要给 ATOM Desk 加上 OAuth 登录",
      "必须支持本机登录后才能批候选",
      [oauthRef],
      "2026-09-20T10:00:00.000Z"
    );
    seedSuggested(
      store,
      "Desk 需要 OAuth 本机登录",
      "必须支持登录后才能批候选",
      [oauthDupRef],
      "2026-09-20T11:00:00.000Z"
    );
    const laya = new LayaClient({
      fetch: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      },
      enabled: true,
      timeoutMs: 40,
    });
    const result = await runMergeSweep(store, { apply: true, laya });
    assert.equal(result.merged, 0);
    assert.equal(result.failOpen, true);
    assert.equal(result.layaAvailable, false);
    assert.equal(result.reason, "laya-unavailable");
    assert.equal(store.list({ type: "decision_merged" }).length, 0);
    assert.equal(store.list({ type: "agent_started" }).length, 0);
  });
});
