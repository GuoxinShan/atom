import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { LayaClient, type LayaFetch } from "../agents/laya.js";
import { runExtract } from "./extract.js";
import { exportHandoff } from "./handoff.js";
import { openDb } from "../store/db.js";
import { EventStore } from "../store/events.js";
import { projectCandidates } from "../store/candidates.js";
import { newId } from "../schema/ids.js";
import type { CandidateProposal, ExtractAgent } from "../schema/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-laya-"));
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

const ref = { token: "yzj:im:g:1", kind: "im" as const, digest: "msg" };

const chatProposal: CandidateProposal = {
  title: "明天一起吃饭",
  body: "晚上七点，不算工作",
  confidence: 0.7,
  refs: [ref],
  source_message_ids: ["m1"],
};

const demandProposal: CandidateProposal = {
  title: "需要给 ATOM Desk 加上 OAuth 登录",
  body: "必须支持本机登录后才能批候选",
  confidence: 0.85,
  refs: [ref],
  source_message_ids: ["m2"],
};

function stubAgent(proposals: CandidateProposal[]): ExtractAgent {
  return {
    id: "stub-extract",
    async extract() {
      return proposals;
    },
  };
}

describe("extract → Laya candidate gate", () => {
  it("drops chat-like proposals and keeps real demand as suggested", async () => {
    const store = await tempStore();
    const { fetch, calls } = recordingFetch(async (url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const title = String(body.state?.title ?? "");
      if (title.includes("吃饭")) {
        return jsonResponse({
          answers: {
            kind: { choice: "noise", confidence: 0.95 },
            is_chat_noise: { noul: 0.92 },
            is_work_demand: { noul: 0.06 },
          },
        });
      }
      return jsonResponse({
        answers: {
          kind: { choice: "demand", confidence: 0.9 },
          is_work_demand: { noul: 0.88 },
          is_chat_noise: { noul: 0.04 },
        },
      });
    });
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const result = await runExtract(store, stubAgent([chatProposal, demandProposal]), {
      heuristicGate: false,
      laya,
    });

    assert.equal(result.proposed, 1);
    assert.equal(result.noiseDropped, 1);
    const cands = projectCandidates(store);
    assert.equal(cands.length, 1);
    assert.equal(cands[0]?.title, demandProposal.title);
    assert.equal(cands[0]?.status, "suggested");
    assert.equal(
      calls.some((c) => c.url.endsWith("/v1/predict")),
      true
    );
    assert.equal(
      calls.filter((c) => c.url.endsWith("/v1/predict")).length,
      2
    );
  });

  it("fail-opens to suggested when Laya times out", async () => {
    const store = await tempStore();
    const laya = new LayaClient({ fetch: hangFetch(), enabled: true, timeoutMs: 40 });
    const result = await runExtract(store, stubAgent([chatProposal, demandProposal]), {
      heuristicGate: false,
      laya,
    });
    assert.equal(result.proposed, 2);
    assert.equal(result.noiseDropped, 0);
    const statuses = projectCandidates(store).map((c) => c.status);
    assert.deepEqual(statuses, ["suggested", "suggested"]);
  });

  it("drops chat when is_chat_noise noul is high even if kind confidence is low", async () => {
    const store = await tempStore();
    const { fetch } = recordingFetch(async (url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const title = String(body.state?.title ?? "");
      if (title.includes("吃饭")) {
        return jsonResponse({
          answers: {
            kind: { choice: "noise", confidence: 0.19 },
            is_chat_noise: { noul: 0.94 },
            is_work_demand: { noul: 0.11 },
          },
        });
      }
      return jsonResponse({
        answers: {
          kind: { choice: "demand", confidence: 0.21 },
          is_work_demand: { noul: 0.89 },
          is_chat_noise: { noul: 0.06 },
        },
      });
    });
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const result = await runExtract(store, stubAgent([chatProposal, demandProposal]), {
      heuristicGate: false,
      laya,
    });
    assert.equal(result.proposed, 1);
    assert.equal(result.noiseDropped, 1);
    const cands = projectCandidates(store);
    assert.equal(cands.length, 1);
    assert.equal(cands[0]?.title, demandProposal.title);
    const proposedEv = store.list({ type: "candidate_proposed" }).at(-1);
    const detail = JSON.parse(proposedEv!.detail_json) as {
      laya_gate?: { action?: string; fail_open?: boolean; demand_noul?: number };
    };
    assert.equal(detail.laya_gate?.action, "suggested");
    assert.equal(detail.laya_gate?.fail_open, false);
    assert.equal(detail.laya_gate?.demand_noul, 0.89);
  });
});

describe("lead dispatch → Laya route-model", () => {
  async function seedSpec(store: EventStore): Promise<string> {
    const candId = newId("cand");
    const specId = newId("spec");
    store.append({
      type: "candidate_proposed",
      subject_id: candId,
      summary: "Add OAuth login",
      detail: {
        title: "Add OAuth login",
        body: "Desk must support local sign-in",
        confidence: 0.9,
      },
      refs: [ref],
      actor: "test",
    });
    store.append({
      type: "decision_accepted",
      subject_id: candId,
      summary: "accepted",
      actor: "test",
    });
    store.append({
      type: "spec_drafted",
      subject_id: specId,
      summary: "spec draft",
      detail: {
        candidate_id: candId,
        title: "Add OAuth login",
        body: "Implement OAuth for ATOM Desk",
        acceptance_criteria: ["User can sign in locally"],
      },
      refs: [ref],
      actor: "test",
    });
    return specId;
  }

  it("calls /v1/route-model on the lead handoff path and records ornith", async () => {
    const store = await tempStore();
    const specId = await seedSpec(store);
    const { fetch, calls } = recordingFetch(async (url) => {
      assert.match(url, /\/v1\/route-model$/);
      return jsonResponse({ model: "ornith", confidence: 0.92 });
    });
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const pack = await exportHandoff(store, repoRoot, specId, undefined, {
      target: "file",
      laya,
    });
    assert.ok(pack.id);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url.endsWith("/v1/route-model"), true);
    assert.equal(
      String((calls[0]?.body as { request?: string }).request ?? "").includes("OAuth"),
      true
    );
    const ev = store.list({ type: "handoff_exported" }).at(-1);
    assert.ok(ev);
    const detail = JSON.parse(ev!.detail_json) as {
      laya_model_route?: { model?: string; intensity?: string; fail_open?: boolean };
    };
    assert.equal(detail.laya_model_route?.model, "ornith");
    assert.equal(detail.laya_model_route?.intensity, "heavy");
    assert.equal(detail.laya_model_route?.fail_open, false);
  });

  it("fail-opens handoff when route-model times out", async () => {
    const store = await tempStore();
    const specId = await seedSpec(store);
    const laya = new LayaClient({ fetch: hangFetch(), enabled: true, timeoutMs: 40 });
    const pack = await exportHandoff(store, repoRoot, specId, undefined, {
      target: "file",
      laya,
    });
    assert.ok(pack.path);
    const ev = store.list({ type: "handoff_exported" }).at(-1);
    const detail = JSON.parse(ev!.detail_json) as {
      laya_model_route?: { fail_open?: boolean; intensity?: string };
    };
    assert.equal(detail.laya_model_route?.fail_open, true);
    assert.equal(detail.laya_model_route?.intensity, "unknown");
  });
});

function isMergePredict(body: unknown): boolean {
  const q = (body as { questions?: Record<string, unknown> })?.questions;
  return Boolean(q && typeof q === "object" && !Array.isArray(q) && "action" in q && "same_request" in q);
}

function demandAnswers() {
  return {
    answers: {
      kind: { choice: "demand", confidence: 0.9 },
      is_work_demand: { noul: 0.88 },
      is_chat_noise: { noul: 0.04 },
    },
  };
}

const dupRef = { token: "yzj:im:g:dup", kind: "im" as const, digest: "oauth-dup" };

const duplicateProposal: CandidateProposal = {
  title: "Desk 需要 OAuth 本机登录",
  body: "必须支持登录后才能批候选，和已有建议是同一需求",
  confidence: 0.84,
  cluster_key: "oauth-desk-dup",
  refs: [dupRef],
  source_message_ids: ["m9"],
};

const distinctProposal: CandidateProposal = {
  title: "需要给 1023 日历加上日程冲突提醒",
  body: "用户希望在两个会议重叠时收到提醒",
  confidence: 0.86,
  cluster_key: "calendar-conflict",
  refs: [{ token: "yzj:im:g:cal", kind: "im" as const, digest: "cal" }],
  source_message_ids: ["m10"],
};

function seedSuggested(store: EventStore, title: string, body: string): string {
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
    refs: [ref],
    actor: "test",
  });
  return id;
}

describe("extract → Laya duplicate merge gate", () => {
  it("merges a high-confidence duplicate into the existing Needs-you item", async () => {
    const store = await tempStore();
    const existingId = seedSuggested(
      store,
      demandProposal.title,
      demandProposal.body
    );
    const { fetch, calls } = recordingFetch(async (url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (isMergePredict(body)) {
        const questions = body.questions as Record<string, unknown>;
        assert.equal(Array.isArray(questions), false);
        return jsonResponse({
          answers: {
            action: { choice: "merge", confidence: 0.94 },
            same_request: { noul: 0.92 },
            target: { choice: existingId, confidence: 0.93 },
          },
        });
      }
      return jsonResponse(demandAnswers());
    });
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const result = await runExtract(store, stubAgent([duplicateProposal]), {
      heuristicGate: false,
      laya,
    });

    assert.equal(result.proposed, 0);
    assert.equal(result.merged, 1);
    const suggested = projectCandidates(store).filter((c) => c.status === "suggested");
    assert.equal(suggested.length, 1);
    assert.equal(suggested[0]?.id, existingId);
    assert.equal(
      suggested[0]?.refs.some((r) => r.token === dupRef.token),
      true
    );
    const merged = projectCandidates(store).filter((c) => c.status === "merged");
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.title, duplicateProposal.title);
    const proposedEv = store.list({ type: "candidate_proposed" }).at(-1);
    const detail = JSON.parse(proposedEv!.detail_json) as {
      laya_merge?: { action?: string; target_id?: string; fail_open?: boolean };
    };
    assert.equal(detail.laya_merge?.action, "merge");
    assert.equal(detail.laya_merge?.target_id, existingId);
    assert.equal(detail.laya_merge?.fail_open, false);
    assert.equal(
      calls.filter((c) => c.url.endsWith("/v1/predict") && isMergePredict(c.body)).length,
      1
    );
  });

  it("creates a new suggested ticket when Laya says the request is distinct", async () => {
    const store = await tempStore();
    const existingId = seedSuggested(
      store,
      demandProposal.title,
      demandProposal.body
    );
    const { fetch } = recordingFetch(async (url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (isMergePredict(body)) {
        return jsonResponse({
          answers: {
            action: { choice: "new", confidence: 0.91 },
            same_request: { noul: 0.07 },
            target: { choice: "none", confidence: 0.9 },
          },
        });
      }
      return jsonResponse(demandAnswers());
    });
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const result = await runExtract(store, stubAgent([distinctProposal]), {
      heuristicGate: false,
      laya,
    });

    assert.equal(result.proposed, 1);
    assert.equal(result.merged, 0);
    const suggested = projectCandidates(store).filter((c) => c.status === "suggested");
    assert.equal(suggested.length, 2);
    assert.equal(
      suggested.some((c) => c.id === existingId),
      true
    );
    assert.equal(
      suggested.some((c) => c.title === distinctProposal.title),
      true
    );
    const proposedEv = store
      .list({ type: "candidate_proposed" })
      .find((e) => e.summary === distinctProposal.title);
    const detail = JSON.parse(proposedEv!.detail_json) as {
      laya_merge?: { action?: string; fail_open?: boolean };
    };
    assert.equal(detail.laya_merge?.action, "new");
    assert.equal(detail.laya_merge?.fail_open, false);
  });

  it("fail-opens to a new suggested ticket when merge predict times out", async () => {
    const store = await tempStore();
    seedSuggested(store, demandProposal.title, demandProposal.body);
    const { fetch } = recordingFetch(async (url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (isMergePredict(body)) {
        return hangFetch()(url, init);
      }
      return jsonResponse(demandAnswers());
    });
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 40 });
    const result = await runExtract(store, stubAgent([duplicateProposal]), {
      heuristicGate: false,
      laya,
    });

    assert.equal(result.proposed, 1);
    assert.equal(result.merged, 0);
    const suggested = projectCandidates(store).filter((c) => c.status === "suggested");
    assert.equal(suggested.length, 2);
    assert.equal(
      suggested.some((c) => c.title === duplicateProposal.title),
      true
    );
    const proposedEv = store
      .list({ type: "candidate_proposed" })
      .find((e) => e.summary === duplicateProposal.title);
    const detail = JSON.parse(proposedEv!.detail_json) as {
      laya_merge?: { action?: string; fail_open?: boolean };
    };
    assert.equal(detail.laya_merge?.action, "new");
    assert.equal(detail.laya_merge?.fail_open, true);
  });

  it("merges when same_request noul is high even if action confidence is low", async () => {
    const store = await tempStore();
    const existingId = seedSuggested(
      store,
      demandProposal.title,
      demandProposal.body
    );
    const { fetch } = recordingFetch(async (url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (isMergePredict(body)) {
        return jsonResponse({
          answers: {
            action: { choice: "merge", confidence: 0.18 },
            same_request: { noul: 0.98 },
            target: { choice: existingId, confidence: 0.2 },
          },
        });
      }
      return jsonResponse(demandAnswers());
    });
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const result = await runExtract(store, stubAgent([duplicateProposal]), {
      heuristicGate: false,
      laya,
    });

    assert.equal(result.proposed, 0);
    assert.equal(result.merged, 1);
    const suggested = projectCandidates(store).filter((c) => c.status === "suggested");
    assert.equal(suggested.length, 1);
    assert.equal(suggested[0]?.id, existingId);
    const proposedEv = store.list({ type: "candidate_proposed" }).at(-1);
    const detail = JSON.parse(proposedEv!.detail_json) as {
      laya_merge?: {
        action?: string;
        target_id?: string;
        fail_open?: boolean;
        same_request?: number;
        confidence?: number;
      };
    };
    assert.equal(detail.laya_merge?.action, "merge");
    assert.equal(detail.laya_merge?.target_id, existingId);
    assert.equal(detail.laya_merge?.fail_open, false);
    assert.equal(detail.laya_merge?.same_request, 0.98);
    assert.equal(detail.laya_merge?.confidence, 0.98);
  });
});
