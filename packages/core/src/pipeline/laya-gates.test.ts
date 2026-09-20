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
