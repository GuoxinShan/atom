import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { LayaClient, type LayaFetch } from "../agents/laya.js";
import { runExtract } from "./extract.js";
import { groupNeedsYouCandidates } from "../store/needs-groups.js";
import { exportHandoff } from "./handoff.js";
import {
  evaluateOutboundGate,
  publishOutbound,
  shouldDeliverOutbound,
} from "./laya-outbound.js";
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
      3
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
      laya_merge?: { action?: string; fail_open?: boolean; reason?: string };
    };
    assert.equal(detail.laya_merge?.action, "new");
    assert.equal(detail.laya_merge?.fail_open, true);
    assert.equal(detail.laya_merge?.reason, "timeout");
    assert.equal(laya.unavailable, false);
  });

  it("still merge-gates later candidates after one merge predict times out", async () => {
    const store = await tempStore();
    seedSuggested(store, demandProposal.title, demandProposal.body);
    let mergeAttempts = 0;
    const { fetch } = recordingFetch(async (url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (isMergePredict(body)) {
        mergeAttempts += 1;
        if (mergeAttempts === 1) return hangFetch()(url, init);
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
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 40 });
    const result = await runExtract(
      store,
      stubAgent([duplicateProposal, distinctProposal]),
      { heuristicGate: false, laya }
    );

    assert.equal(mergeAttempts, 2);
    assert.equal(laya.unavailable, false);
    assert.equal(result.proposed, 2);
    assert.equal(result.merged, 0);
    const timedOut = store
      .list({ type: "candidate_proposed" })
      .find((e) => e.summary === duplicateProposal.title);
    const later = store
      .list({ type: "candidate_proposed" })
      .find((e) => e.summary === distinctProposal.title);
    const timedOutDetail = JSON.parse(timedOut!.detail_json) as {
      laya_merge?: { fail_open?: boolean; reason?: string };
    };
    const laterDetail = JSON.parse(later!.detail_json) as {
      laya_merge?: { fail_open?: boolean; reason?: string; action?: string };
    };
    assert.equal(timedOutDetail.laya_merge?.fail_open, true);
    assert.equal(timedOutDetail.laya_merge?.reason, "timeout");
    assert.equal(laterDetail.laya_merge?.fail_open, false);
    assert.equal(laterDetail.laya_merge?.action, "new");
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

  it("does not merge high same_request when titles are a different topic (速记 vs 日程 MCP)", async () => {
    const store = await tempStore();
    const existingId = seedSuggested(
      store,
      "修复日程 MCP 云之家授权失败",
      "云之家授权失败导致日程 MCP 拉不下来"
    );
    const shorthand: CandidateProposal = {
      title: "评估速记迁入灵基并重做lingee壳鉴权",
      body: "速记迁入灵基，重做 lingee 壳鉴权",
      confidence: 0.84,
      cluster_key: "shorthand-lingee",
      refs: [dupRef],
      source_message_ids: ["m-shorthand"],
    };
    const { fetch } = recordingFetch(async (url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (isMergePredict(body)) {
        return jsonResponse({
          answers: {
            action: { choice: "merge", confidence: 0.2 },
            same_request: { noul: 0.97 },
            target: { choice: existingId, confidence: 0.2 },
          },
        });
      }
      return jsonResponse(demandAnswers());
    });
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const result = await runExtract(store, stubAgent([shorthand]), {
      heuristicGate: false,
      laya,
    });

    assert.equal(result.proposed, 1);
    assert.equal(result.merged, 0);
    const suggested = projectCandidates(store).filter((c) => c.status === "suggested");
    assert.equal(suggested.length, 2);
    const proposedEv = store.list({ type: "candidate_proposed" }).at(-1);
    const detail = JSON.parse(proposedEv!.detail_json) as {
      laya_merge?: { action?: string; reason?: string; fail_open?: boolean; same_request?: number };
    };
    assert.equal(detail.laya_merge?.action, "new");
    assert.equal(detail.laya_merge?.reason, "topic-mismatch");
    assert.equal(detail.laya_merge?.fail_open, false);
    assert.equal(detail.laya_merge?.same_request, 0.97);
  });
});

function isTagPredict(body: unknown): boolean {
  const q = (body as { questions?: Record<string, unknown> })?.questions;
  return Boolean(q && typeof q === "object" && "theme" in q && "project" in q);
}

function tagAnswers(theme: string, project?: string) {
  return {
    answers: {
      theme: { choice: theme, confidence: 0.93 },
      project: { choice: project ?? theme, confidence: 0.91 },
    },
  };
}

const tagProposal: CandidateProposal = {
  title: "Schedule Mcp 授权失败",
  body: "AI推进里的日程 MCP 拉不下来",
  confidence: 0.86,
  cluster_key: "schedule-mcp-auth",
  refs: [{ token: "yzj:im:g:tag", kind: "im" as const, digest: "tag" }],
  source_message_ids: ["m-tag"],
};

describe("extract → Laya theme/project tags", () => {
  it("persists Chinese theme/project on suggested candidates", async () => {
    const store = await tempStore();
    const { fetch, calls } = recordingFetch(async (url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (isTagPredict(body)) return jsonResponse(tagAnswers("AI推进"));
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
    const result = await runExtract(store, stubAgent([tagProposal]), {
      heuristicGate: false,
      laya,
      repoRoot,
    });

    assert.equal(result.proposed, 1);
    const cands = projectCandidates(store);
    assert.equal(cands.length, 1);
    assert.equal(cands[0]?.theme, "AI推进");
    assert.equal(cands[0]?.project, "AI推进");
    assert.equal(cands[0]?.tags?.theme, "AI推进");
    const proposedEv = store.list({ type: "candidate_proposed" }).at(-1);
    const detail = JSON.parse(proposedEv!.detail_json) as {
      theme?: string;
      laya_tags?: { theme?: string; fail_open?: boolean; reason?: string };
    };
    assert.equal(detail.theme, "AI推进");
    assert.equal(detail.laya_tags?.fail_open, false);
    assert.equal(detail.laya_tags?.reason, "tagged");
    assert.equal(
      calls.filter((c) => c.url.endsWith("/v1/predict") && isTagPredict(c.body)).length,
      1
    );
    const questions = (
      calls.find((c) => isTagPredict(c.body))?.body as {
        questions?: { theme?: { criteria?: Record<string, string> } };
      }
    ).questions;
    assert.equal("AI推进" in (questions?.theme?.criteria ?? {}), true);

    const groups = groupNeedsYouCandidates(cands, []);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.kind, "theme");
    assert.equal(groups[0]?.title, "AI推进");
  });

  it("fail-opens tagging on timeout and keeps the untagged candidate", async () => {
    const store = await tempStore();
    const { fetch } = recordingFetch(async (url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (isTagPredict(body)) return hangFetch()(url, init);
      return jsonResponse(demandAnswers());
    });
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 40 });
    const result = await runExtract(store, stubAgent([tagProposal]), {
      heuristicGate: false,
      laya,
    });

    assert.equal(result.proposed, 1);
    assert.equal(laya.unavailable, false);
    const cand = projectCandidates(store)[0];
    assert.equal(cand?.status, "suggested");
    assert.equal(cand?.theme, undefined);
    assert.equal(cand?.project, undefined);
    const proposedEv = store.list({ type: "candidate_proposed" }).at(-1);
    const detail = JSON.parse(proposedEv!.detail_json) as {
      laya_tags?: { fail_open?: boolean; reason?: string };
    };
    assert.equal(detail.laya_tags?.fail_open, true);
    assert.equal(detail.laya_tags?.reason, "timeout");
  });

  it("keeps extract-provided tags when Laya parse-fails", async () => {
    const store = await tempStore();
    const tagged: CandidateProposal = {
      ...tagProposal,
      theme: "OAuth",
      tags: { theme: "OAuth" },
    };
    const { fetch } = recordingFetch(async (url) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      return jsonResponse(demandAnswers());
    });
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const result = await runExtract(store, stubAgent([tagged]), {
      heuristicGate: false,
      laya,
    });
    assert.equal(result.proposed, 1);
    const cand = projectCandidates(store)[0];
    assert.equal(cand?.theme, "OAuth");
    const groups = groupNeedsYouCandidates(projectCandidates(store), []);
    assert.equal(groups[0]?.kind, "theme");
    assert.equal(groups[0]?.title, "OAuth");
  });

  it("does not tag a candidate that was auto-merged", async () => {
    const store = await tempStore();
    const existingId = seedSuggested(store, demandProposal.title, demandProposal.body);
    let tagCalls = 0;
    const { fetch } = recordingFetch(async (url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (isTagPredict(body)) {
        tagCalls += 1;
        return jsonResponse(tagAnswers("ATOM"));
      }
      if (isMergePredict(body)) {
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
    assert.equal(result.merged, 1);
    assert.equal(result.proposed, 0);
    assert.equal(tagCalls, 0);
  });
});

function isOutboundPredict(body: unknown): boolean {
  const state = (body as { state?: { channel?: string } })?.state;
  const q = (body as { questions?: Record<string, unknown> })?.questions;
  return Boolean(
    state?.channel === "outbound" ||
      (q && typeof q === "object" && !Array.isArray(q) && "kind" in q && !("action" in q))
  );
}

function outboundNoiseAnswers() {
  return {
    answers: {
      kind: { choice: "drop", confidence: 0.95 },
      is_chat_noise: { noul: 0.92 },
      is_work_demand: { noul: 0.06 },
    },
  };
}

function outboundDemandAnswers() {
  return {
    answers: {
      kind: { choice: "allow", confidence: 0.9 },
      is_work_demand: { noul: 0.88 },
      is_chat_noise: { noul: 0.04 },
    },
  };
}

describe("outbound / pre-post Laya gate", () => {
  it("drops high-confidence noise and does not deliver", async () => {
    const store = await tempStore();
    const { fetch, calls } = recordingFetch(async (url) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      return jsonResponse(outboundNoiseAnswers());
    });
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    let delivered = 0;
    const result = await publishOutbound(
      repoRoot,
      { kind: "digest", text: "明天一起吃饭，晚上七点不算工作" },
      {
        store,
        laya,
        deliver: async () => {
          delivered += 1;
        },
      }
    );

    assert.equal(result.gate.action, "drop");
    assert.equal(result.gate.failOpen, false);
    assert.equal(result.delivered, false);
    assert.equal(delivered, 0);
    assert.equal(shouldDeliverOutbound(result.gate), false);
    assert.equal(
      calls.some((c) => c.url.endsWith("/v1/predict") && isOutboundPredict(c.body)),
      true
    );
    const ev = store.list({ type: "agent_completed" }).at(-1);
    assert.ok(ev);
    const detail = JSON.parse(ev!.detail_json) as {
      kind?: string;
      delivered?: boolean;
      laya_outbound?: {
        action?: string;
        fail_open?: boolean;
        noise_noul?: number;
        reason?: string;
      };
    };
    assert.equal(detail.kind, "outbound-check");
    assert.equal(detail.delivered, false);
    assert.equal(detail.laya_outbound?.action, "drop");
    assert.equal(detail.laya_outbound?.fail_open, false);
    assert.equal(detail.laya_outbound?.noise_noul, 0.92);
  });

  it("fail-opens low/ambiguous answers and delivers", async () => {
    const store = await tempStore();
    const { fetch } = recordingFetch(async () =>
      jsonResponse({
        answers: {
          kind: { choice: "drop", confidence: 0.41 },
          is_chat_noise: { noul: 0.5 },
          is_work_demand: { noul: 0.48 },
        },
      })
    );
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    let delivered = 0;
    const result = await publishOutbound(
      repoRoot,
      { kind: "digest", text: "maybe a work digest?" },
      {
        store,
        laya,
        deliver: async () => {
          delivered += 1;
        },
      }
    );
    assert.equal(result.gate.action, "allow");
    assert.equal(result.gate.failOpen, true);
    assert.equal(result.delivered, true);
    assert.equal(delivered, 1);
    const ev = store.list({ type: "agent_completed" }).at(-1);
    const detail = JSON.parse(ev!.detail_json) as {
      delivered?: boolean;
      laya_outbound?: { action?: string; fail_open?: boolean; reason?: string };
    };
    assert.equal(detail.delivered, true);
    assert.equal(detail.laya_outbound?.action, "allow");
    assert.equal(detail.laya_outbound?.fail_open, true);
    assert.equal(detail.laya_outbound?.reason, "ambiguous");
  });

  it("fail-opens timeout, delivers, and does not poison later outbound checks", async () => {
    const store = await tempStore();
    let n = 0;
    const { fetch } = recordingFetch(async (url, init) => {
      n += 1;
      if (n === 1) return hangFetch()(url, init);
      return jsonResponse(outboundNoiseAnswers());
    });
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 40 });
    let delivered = 0;
    const first = await publishOutbound(
      repoRoot,
      { kind: "digest", text: "明天一起吃饭" },
      {
        store,
        laya,
        deliver: async () => {
          delivered += 1;
        },
      }
    );
    assert.equal(first.gate.action, "allow");
    assert.equal(first.gate.failOpen, true);
    assert.equal(first.gate.reason, "timeout");
    assert.equal(first.delivered, true);
    assert.equal(delivered, 1);
    assert.equal(laya.unavailable, false);

    const second = await publishOutbound(
      repoRoot,
      { kind: "digest", text: "明天一起吃饭" },
      {
        store,
        laya,
        deliver: async () => {
          delivered += 1;
        },
      }
    );
    assert.equal(second.gate.action, "drop");
    assert.equal(second.gate.failOpen, false);
    assert.equal(second.delivered, false);
    assert.equal(delivered, 1);
    assert.equal(n, 2);
    assert.equal(laya.unavailable, false);
  });

  it("evaluateOutboundGate records laya_outbound and never delivers", async () => {
    const store = await tempStore();
    const { fetch } = recordingFetch(async () => jsonResponse(outboundDemandAnswers()));
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const result = await evaluateOutboundGate(
      {
        title: "ATOM 需求日报",
        body: "Suggested：Desk OAuth 登录",
        kind: "digest",
      },
      { store, laya }
    );
    assert.equal(result.gate.action, "allow");
    assert.equal(result.gate.failOpen, false);
    assert.equal(result.delivered, false);
    assert.equal(result.kind, "digest");
    const ev = store.list({ type: "agent_completed" }).find((e) =>
      e.summary.startsWith("outbound-check:")
    );
    assert.ok(ev);
    const detail = JSON.parse(ev!.detail_json) as {
      laya_outbound?: { action?: string; demand_noul?: number; fail_open?: boolean };
      delivered?: boolean;
    };
    assert.equal(detail.delivered, false);
    assert.equal(detail.laya_outbound?.action, "allow");
    assert.equal(detail.laya_outbound?.fail_open, false);
    assert.equal(detail.laya_outbound?.demand_noul, 0.88);
  });

  it("fail-opens when Laya is unavailable and still delivers", async () => {
    const store = await tempStore();
    const fetch: LayaFetch = async () => {
      const err = new TypeError("fetch failed");
      (err as TypeError & { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
      throw err;
    };
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    let delivered = 0;
    const result = await publishOutbound(
      repoRoot,
      { kind: "digest", text: "Suggested: Desk OAuth" },
      {
        store,
        laya,
        deliver: async () => {
          delivered += 1;
        },
      }
    );
    assert.equal(result.gate.action, "allow");
    assert.equal(result.gate.failOpen, true);
    assert.equal(result.gate.reason, "unavailable");
    assert.equal(result.delivered, true);
    assert.equal(delivered, 1);
  });
});
