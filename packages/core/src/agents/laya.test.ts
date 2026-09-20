import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  LayaClient,
  interpretCandidateAnswers,
  interpretMergeAnswers,
  interpretRouteModel,
  intensityFromLayaModel,
  type LayaFetch,
  type OpenItemSnippet,
} from "./laya.js";

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

type Call = { url: string; method: string; body?: unknown };

function recordingFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: Call[] = [];
  const fetch: LayaFetch = async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
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

describe("interpretCandidateAnswers", () => {
  it("rejects high-confidence chat/noise", () => {
    const gate = interpretCandidateAnswers({
      kind: { choice: "noise", confidence: 0.94 },
      is_chat_noise: { noul: 0.91 },
      is_work_demand: { noul: 0.08 },
    });
    assert.equal(gate.action, "noise");
    assert.equal(gate.failOpen, false);
  });

  it("keeps high-confidence real demand as suggested", () => {
    const gate = interpretCandidateAnswers({
      kind: { choice: "demand", confidence: 0.91 },
      is_work_demand: { noul: 0.88 },
      is_chat_noise: { noul: 0.05 },
    });
    assert.equal(gate.action, "suggested");
    assert.equal(gate.failOpen, false);
    assert.equal(gate.reason, "demand");
  });

  it("fail-opens ambiguous answers to suggested (never auto-approve)", () => {
    const gate = interpretCandidateAnswers({
      kind: { choice: "noise", confidence: 0.41 },
      is_chat_noise: { noul: 0.5 },
      is_work_demand: { noul: 0.48 },
    });
    assert.equal(gate.action, "suggested");
    assert.equal(gate.failOpen, true);
  });
});

const openItems: OpenItemSnippet[] = [
  {
    id: "cand_oauth",
    title: "需要给 ATOM Desk 加上 OAuth 登录",
    snippet: "必须支持本机登录后才能批候选",
  },
  {
    id: "cand_other",
    title: "日历同步失败",
    snippet: "1023 日历拉不到日程",
  },
];

describe("interpretMergeAnswers", () => {
  it("merges high-confidence duplicates into the named open item", () => {
    const gate = interpretMergeAnswers(
      {
        action: { choice: "merge", confidence: 0.94 },
        same_request: { noul: 0.91 },
        target: { choice: "cand_oauth", confidence: 0.9 },
      },
      openItems
    );
    assert.equal(gate.action, "merge");
    assert.equal(gate.failOpen, false);
    assert.equal(gate.targetId, "cand_oauth");
    assert.equal(gate.reason, "duplicate");
  });

  it("creates new when Laya says the request is distinct", () => {
    const gate = interpretMergeAnswers(
      {
        action: { choice: "new", confidence: 0.9 },
        same_request: { noul: 0.08 },
        target: { choice: "none", confidence: 0.88 },
      },
      openItems
    );
    assert.equal(gate.action, "new");
    assert.equal(gate.failOpen, false);
    assert.equal(gate.reason, "distinct");
  });

  it("fail-opens low-confidence merge to new (never auto-approve)", () => {
    const gate = interpretMergeAnswers(
      {
        action: { choice: "merge", confidence: 0.41 },
        same_request: { noul: 0.5 },
      },
      openItems
    );
    assert.equal(gate.action, "new");
    assert.equal(gate.failOpen, true);
  });

  it("fail-opens when same_request is below min confidence", () => {
    const gate = interpretMergeAnswers(
      {
        action: { choice: "merge", confidence: 0.95 },
        same_request: { noul: 0.2 },
        target: { choice: "cand_oauth" },
      },
      openItems
    );
    assert.equal(gate.action, "new");
    assert.equal(gate.failOpen, true);
  });
});

describe("interpretRouteModel", () => {
  it("maps ornith → heavy and bonsai → light", () => {
    const heavy = interpretRouteModel({ model: "ornith", confidence: 0.93 });
    assert.equal(heavy.model, "ornith");
    assert.equal(heavy.intensity, "heavy");
    assert.equal(heavy.failOpen, false);

    const light = interpretRouteModel({
      answers: { model: { choice: "bonsai", confidence: 0.87 } },
    });
    assert.equal(light.model, "bonsai");
    assert.equal(light.intensity, "light");
  });

  it("fail-opens low confidence", () => {
    const route = interpretRouteModel({ model: "ornith", confidence: 0.2 });
    assert.equal(route.failOpen, true);
    assert.equal(route.intensity, "heavy");
  });
});

describe("intensityFromLayaModel", () => {
  it("classifies known names", () => {
    assert.equal(intensityFromLayaModel("ornith"), "heavy");
    assert.equal(intensityFromLayaModel("bonsai"), "light");
    assert.equal(intensityFromLayaModel("unknown-x"), "unknown");
  });
});

describe("LayaClient", () => {
  const envKeys = ["LAYA_URL", "LAYA_ENABLED", "LAYA_TIMEOUT_MS"] as const;
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const k of envKeys) {
      if (k in saved) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
        delete saved[k];
      }
    }
  });

  function stash(key: (typeof envKeys)[number]) {
    if (!(key in saved)) saved[key] = process.env[key];
  }

  it("POSTs /v1/predict and gates chat as noise", async () => {
    const { fetch, calls } = recordingFetch(async (url) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      assert.match(url, /\/v1\/predict$/);
      return jsonResponse({
        answers: {
          kind: { type: "choice", choice: "noise", confidence: 0.96 },
          is_chat_noise: { type: "noul", noul: 0.93, confidence: 0.93 },
          is_work_demand: { type: "noul", noul: 0.04, confidence: 0.04 },
        },
      });
    });
    const client = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const gate = await client.gateCandidate({ title: "明天一起吃饭", body: "晚上七点见" });
    assert.equal(gate.action, "noise");
    assert.equal(calls.some((c) => c.url.endsWith("/v1/predict")), true);
    const predict = calls.find((c) => c.url.endsWith("/v1/predict"));
    assert.equal((predict?.body as { state?: { title?: string } }).state?.title, "明天一起吃饭");
  });

  it("POSTs /v1/route-model with the task request", async () => {
    const { fetch, calls } = recordingFetch(async (url) => {
      assert.match(url, /\/v1\/route-model$/);
      return jsonResponse({ model: "ornith", confidence: 0.91 });
    });
    const client = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const route = await client.routeModel("Refactor extract to call Laya predict");
    assert.equal(route.model, "ornith");
    assert.equal(route.intensity, "heavy");
    assert.equal(calls.length, 1);
    assert.equal((calls[0]?.body as { request?: string }).request?.includes("Refactor"), true);
  });

  it("fail-opens predict on timeout", async () => {
    const client = new LayaClient({ fetch: hangFetch(), enabled: true, timeoutMs: 40 });
    const t0 = Date.now();
    const gate = await client.gateCandidate({ title: "需要接入 OAuth 登录" });
    assert.equal(gate.action, "suggested");
    assert.equal(gate.failOpen, true);
    assert.ok(Date.now() - t0 < 500);
    assert.equal(client.unavailable, true);
  });

  it("POSTs /v1/predict merge questions as a dict and merges into the target", async () => {
    const { fetch, calls } = recordingFetch(async (url) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      assert.match(url, /\/v1\/predict$/);
      return jsonResponse({
        answers: {
          action: { type: "choice", choice: "merge", confidence: 0.93 },
          same_request: { type: "noul", noul: 0.9, confidence: 0.9 },
          target: { type: "choice", choice: "cand_oauth", confidence: 0.9 },
        },
      });
    });
    const client = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const gate = await client.gateMerge({
      title: "Desk 需要 OAuth 本机登录",
      body: "同一需求",
      openItems,
    });
    assert.equal(gate.action, "merge");
    assert.equal(gate.targetId, "cand_oauth");
    const predict = calls.find((c) => c.url.endsWith("/v1/predict"));
    assert.ok(predict);
    const questions = (predict?.body as { questions?: Record<string, { type?: string }> }).questions;
    assert.equal(Array.isArray(questions), false);
    assert.equal(questions?.action?.type, "choice");
    assert.equal(questions?.same_request?.type, "noul");
    const state = (predict?.body as { state?: { open_items?: OpenItemSnippet[] } }).state;
    assert.equal(state?.open_items?.length, 2);
  });

  it("fail-opens merge predict on timeout to new", async () => {
    const client = new LayaClient({ fetch: hangFetch(), enabled: true, timeoutMs: 40 });
    const gate = await client.gateMerge({
      title: "Desk 需要 OAuth 本机登录",
      openItems,
    });
    assert.equal(gate.action, "new");
    assert.equal(gate.failOpen, true);
    assert.equal(client.unavailable, true);
  });

  it("fail-opens route-model on timeout", async () => {
    const client = new LayaClient({ fetch: hangFetch(), enabled: true, timeoutMs: 40 });
    const route = await client.routeModel("Implement OAuth");
    assert.equal(route.failOpen, true);
    assert.equal(route.intensity, "unknown");
    assert.equal(route.reason, "unavailable");
  });

  it("skips HTTP when LAYA_ENABLED=0", async () => {
    stash("LAYA_ENABLED");
    process.env.LAYA_ENABLED = "0";
    let called = 0;
    const fetch: LayaFetch = async () => {
      called += 1;
      return jsonResponse({ ok: true });
    };
    const client = LayaClient.fromEnv({ fetch });
    assert.equal(client.isEnabled(), false);
    const gate = await client.gateCandidate({ title: "明天一起吃饭" });
    assert.equal(gate.action, "suggested");
    assert.equal(gate.failOpen, true);
    assert.equal(called, 0);
  });
});
