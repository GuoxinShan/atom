import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  DEFAULT_LAYA_TIMEOUT_MS,
  LAYA_UNAVAILABLE_AFTER_5XX,
  LayaClient,
  interpretCandidateAnswers,
  interpretMergeAnswers,
  interpretOutboundAnswers,
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

  it("drops noise when is_chat_noise noul is high even if kind confidence is low", () => {
    const gate = interpretCandidateAnswers({
      kind: { choice: "noise", confidence: 0.22 },
      is_chat_noise: { noul: 0.93 },
      is_work_demand: { noul: 0.12 },
    });
    assert.equal(gate.action, "noise");
    assert.equal(gate.failOpen, false);
    assert.equal(gate.confidence, 0.93);
  });

  it("prefers high is_chat_noise noul over a low-confidence kind=demand", () => {
    const gate = interpretCandidateAnswers({
      kind: { choice: "demand", confidence: 0.3 },
      is_chat_noise: { noul: 0.92 },
      is_work_demand: { noul: 0.14 },
    });
    assert.equal(gate.action, "noise");
    assert.equal(gate.failOpen, false);
  });

  it("keeps demand when is_work_demand noul is high even if kind confidence is low", () => {
    const gate = interpretCandidateAnswers({
      kind: { choice: "demand", confidence: 0.18 },
      is_work_demand: { noul: 0.9 },
      is_chat_noise: { noul: 0.08 },
    });
    assert.equal(gate.action, "suggested");
    assert.equal(gate.failOpen, false);
    assert.equal(gate.reason, "demand");
  });
});

describe("interpretOutboundAnswers", () => {
  it("drops high-confidence chat/noise", () => {
    const gate = interpretOutboundAnswers({
      kind: { choice: "drop", confidence: 0.94 },
      is_chat_noise: { noul: 0.91 },
      is_work_demand: { noul: 0.08 },
    });
    assert.equal(gate.action, "drop");
    assert.equal(gate.failOpen, false);
  });

  it("maps extract-style kind=noise onto drop", () => {
    const gate = interpretOutboundAnswers({
      kind: { choice: "noise", confidence: 0.22 },
      is_chat_noise: { noul: 0.93 },
      is_work_demand: { noul: 0.12 },
    });
    assert.equal(gate.action, "drop");
    assert.equal(gate.failOpen, false);
    assert.equal(gate.confidence, 0.93);
  });

  it("allows high-confidence real work posts", () => {
    const gate = interpretOutboundAnswers({
      kind: { choice: "allow", confidence: 0.9 },
      is_work_demand: { noul: 0.88 },
      is_chat_noise: { noul: 0.05 },
    });
    assert.equal(gate.action, "allow");
    assert.equal(gate.failOpen, false);
    assert.equal(gate.reason, "demand");
  });

  it("holds when Laya is high-confidence hold", () => {
    const gate = interpretOutboundAnswers({
      kind: { choice: "hold", confidence: 0.91 },
      is_chat_noise: { noul: 0.4 },
      is_work_demand: { noul: 0.42 },
    });
    assert.equal(gate.action, "hold");
    assert.equal(gate.failOpen, false);
    assert.equal(gate.reason, "hold");
  });

  it("fail-opens ambiguous answers to allow (never auto-send)", () => {
    const gate = interpretOutboundAnswers({
      kind: { choice: "drop", confidence: 0.41 },
      is_chat_noise: { noul: 0.5 },
      is_work_demand: { noul: 0.48 },
    });
    assert.equal(gate.action, "allow");
    assert.equal(gate.failOpen, true);
  });

  it("allows when is_work_demand noul is high even if kind confidence is low", () => {
    const gate = interpretOutboundAnswers({
      kind: { choice: "allow", confidence: 0.18 },
      is_work_demand: { noul: 0.9 },
      is_chat_noise: { noul: 0.08 },
    });
    assert.equal(gate.action, "allow");
    assert.equal(gate.failOpen, false);
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

  it("merges when same_request noul is high even if action confidence is low", () => {
    const gate = interpretMergeAnswers(
      {
        action: { choice: "merge", confidence: 0.21 },
        same_request: { noul: 0.98 },
        target: { choice: "cand_oauth", confidence: 0.19 },
      },
      openItems
    );
    assert.equal(gate.action, "merge");
    assert.equal(gate.failOpen, false);
    assert.equal(gate.targetId, "cand_oauth");
    assert.equal(gate.reason, "duplicate");
    assert.equal(gate.confidence, 0.98);
  });

  it("lets high same_request dominate a low-confidence action=new when target is valid", () => {
    const gate = interpretMergeAnswers(
      {
        action: { choice: "new", confidence: 0.24 },
        same_request: { noul: 0.96 },
        target: { choice: "cand_oauth" },
      },
      openItems
    );
    assert.equal(gate.action, "merge");
    assert.equal(gate.failOpen, false);
    assert.equal(gate.targetId, "cand_oauth");
  });

  it("fail-opens when same_request is high but high-confidence action=new conflicts", () => {
    const gate = interpretMergeAnswers(
      {
        action: { choice: "new", confidence: 0.91 },
        same_request: { noul: 0.97 },
        target: { choice: "none", confidence: 0.88 },
      },
      openItems
    );
    assert.equal(gate.action, "new");
    assert.equal(gate.failOpen, true);
    assert.equal(gate.reason, "ambiguous");
  });

  it("merges into the first open item when same_request is high and target is omitted", () => {
    const gate = interpretMergeAnswers(
      {
        action: { choice: "merge", confidence: 0.2 },
        same_request: { noul: 0.94 },
      },
      openItems
    );
    assert.equal(gate.action, "merge");
    assert.equal(gate.failOpen, false);
    assert.equal(gate.targetId, "cand_oauth");
  });

  it("fail-opens when same_request is high but target is not a real open item id", () => {
    const gate = interpretMergeAnswers(
      {
        action: { choice: "merge", confidence: 0.2 },
        same_request: { noul: 0.95 },
        target: { choice: "cand_not_open" },
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

  it("defaults LAYA_TIMEOUT_MS to 10s for Mac CPU open-list predict", () => {
    stash("LAYA_TIMEOUT_MS");
    delete process.env.LAYA_TIMEOUT_MS;
    const client = LayaClient.fromEnv({
      fetch: async () => jsonResponse({ ok: true }),
    });
    assert.equal(client.timeoutMs, 10_000);
    assert.equal(DEFAULT_LAYA_TIMEOUT_MS, 10_000);
  });

  it("fail-opens predict on timeout without marking the client unavailable", async () => {
    let n = 0;
    const fetch: LayaFetch = async (url, init) => {
      n += 1;
      if (n === 1) return hangFetch()(url, init);
      return jsonResponse({
        answers: {
          kind: { type: "choice", choice: "demand", confidence: 0.9 },
          is_work_demand: { type: "noul", noul: 0.88, confidence: 0.88 },
          is_chat_noise: { type: "noul", noul: 0.04, confidence: 0.04 },
        },
      });
    };
    const client = new LayaClient({ fetch, enabled: true, timeoutMs: 40 });
    const t0 = Date.now();
    const first = await client.gateCandidate({ title: "需要接入 OAuth 登录" });
    assert.equal(first.action, "suggested");
    assert.equal(first.failOpen, true);
    assert.equal(first.reason, "timeout");
    assert.ok(Date.now() - t0 < 500);
    assert.equal(client.unavailable, false);

    const second = await client.gateCandidate({ title: "需要接入 OAuth 登录" });
    assert.equal(second.failOpen, false);
    assert.equal(second.action, "suggested");
    assert.equal(second.reason, "demand");
    assert.equal(n, 2);
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

  it("fail-opens merge predict on timeout to new without marking unavailable", async () => {
    let n = 0;
    const fetch: LayaFetch = async (url, init) => {
      n += 1;
      if (n === 1) return hangFetch()(url, init);
      return jsonResponse({
        answers: {
          action: { type: "choice", choice: "merge", confidence: 0.93 },
          same_request: { type: "noul", noul: 0.9, confidence: 0.9 },
          target: { type: "choice", choice: "cand_oauth", confidence: 0.9 },
        },
      });
    };
    const client = new LayaClient({ fetch, enabled: true, timeoutMs: 40 });
    const first = await client.gateMerge({
      title: "Desk 需要 OAuth 本机登录",
      openItems,
    });
    assert.equal(first.action, "new");
    assert.equal(first.failOpen, true);
    assert.equal(first.reason, "timeout");
    assert.equal(client.unavailable, false);

    const second = await client.gateMerge({
      title: "Desk 需要 OAuth 本机登录",
      openItems,
    });
    assert.equal(second.action, "merge");
    assert.equal(second.failOpen, false);
    assert.equal(second.targetId, "cand_oauth");
    assert.equal(n, 2);
  });

  it("POSTs /v1/predict outbound questions and drops chat", async () => {
    const { fetch, calls } = recordingFetch(async (url) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      assert.match(url, /\/v1\/predict$/);
      return jsonResponse({
        answers: {
          kind: { type: "choice", choice: "drop", confidence: 0.96 },
          is_chat_noise: { type: "noul", noul: 0.93, confidence: 0.93 },
          is_work_demand: { type: "noul", noul: 0.04, confidence: 0.04 },
        },
      });
    });
    const client = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const gate = await client.gateOutbound({
      title: "明天一起吃饭",
      body: "晚上七点见",
      kind: "digest",
    });
    assert.equal(gate.action, "drop");
    const predict = calls.find((c) => c.url.endsWith("/v1/predict"));
    assert.ok(predict);
    const questions = (predict?.body as { questions?: Record<string, { type?: string }> }).questions;
    assert.equal(questions?.kind?.type, "choice");
    assert.equal(questions?.is_chat_noise?.type, "noul");
    const state = (predict?.body as { state?: { channel?: string; payload_kind?: string } }).state;
    assert.equal(state?.channel, "outbound");
    assert.equal(state?.payload_kind, "digest");
  });

  it("fail-opens outbound predict on timeout without marking unavailable", async () => {
    let n = 0;
    const fetch: LayaFetch = async (url, init) => {
      n += 1;
      if (n === 1) return hangFetch()(url, init);
      return jsonResponse({
        answers: {
          kind: { type: "choice", choice: "drop", confidence: 0.96 },
          is_chat_noise: { type: "noul", noul: 0.93 },
          is_work_demand: { type: "noul", noul: 0.04 },
        },
      });
    };
    const client = new LayaClient({ fetch, enabled: true, timeoutMs: 40 });
    const first = await client.gateOutbound({ title: "明天一起吃饭", kind: "digest" });
    assert.equal(first.action, "allow");
    assert.equal(first.failOpen, true);
    assert.equal(first.reason, "timeout");
    assert.equal(client.unavailable, false);

    const second = await client.gateOutbound({ title: "明天一起吃饭", kind: "digest" });
    assert.equal(second.action, "drop");
    assert.equal(second.failOpen, false);
    assert.equal(n, 2);
  });

  it("fail-opens route-model on timeout without marking unavailable", async () => {
    let n = 0;
    const fetch: LayaFetch = async (url, init) => {
      n += 1;
      if (n === 1) return hangFetch()(url, init);
      return jsonResponse({ model: "ornith", confidence: 0.91 });
    };
    const client = new LayaClient({ fetch, enabled: true, timeoutMs: 40 });
    const first = await client.routeModel("Implement OAuth");
    assert.equal(first.failOpen, true);
    assert.equal(first.intensity, "unknown");
    assert.equal(first.reason, "timeout");
    assert.equal(client.unavailable, false);

    const second = await client.routeModel("Implement OAuth");
    assert.equal(second.failOpen, false);
    assert.equal(second.model, "ornith");
    assert.equal(n, 2);
  });

  it("marks unavailable on connection refused, not timeout", async () => {
    const fetch: LayaFetch = async () => {
      const err = new TypeError("fetch failed");
      (err as TypeError & { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
      throw err;
    };
    const client = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const gate = await client.gateCandidate({ title: "需要接入 OAuth 登录" });
    assert.equal(gate.failOpen, true);
    assert.equal(gate.reason, "unavailable");
    assert.equal(client.unavailable, true);
  });

  it("does not mark unavailable on a single 5xx; next predict still runs", async () => {
    let n = 0;
    const fetch: LayaFetch = async () => {
      n += 1;
      if (n === 1) return jsonResponse({ error: "boom" }, 503);
      return jsonResponse({
        answers: {
          kind: { type: "choice", choice: "demand", confidence: 0.9 },
          is_work_demand: { type: "noul", noul: 0.88 },
          is_chat_noise: { type: "noul", noul: 0.04 },
        },
      });
    };
    const client = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const first = await client.gateCandidate({ title: "需要接入 OAuth 登录" });
    assert.equal(first.failOpen, true);
    assert.equal(first.reason, "unavailable");
    assert.equal(client.unavailable, false);

    const second = await client.gateCandidate({ title: "需要接入 OAuth 登录" });
    assert.equal(second.failOpen, false);
    assert.equal(second.reason, "demand");
    assert.equal(n, 2);
  });

  it("marks unavailable after repeated 5xx and skips further HTTP", async () => {
    let n = 0;
    const fetch: LayaFetch = async () => {
      n += 1;
      return jsonResponse({ error: "boom" }, 503);
    };
    const client = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    for (let i = 0; i < LAYA_UNAVAILABLE_AFTER_5XX; i++) {
      const gate = await client.gateCandidate({ title: "需要接入 OAuth 登录" });
      assert.equal(gate.reason, "unavailable");
    }
    assert.equal(client.unavailable, true);
    const after = await client.gateCandidate({ title: "later sibling" });
    assert.equal(after.reason, "unavailable");
    assert.equal(n, LAYA_UNAVAILABLE_AFTER_5XX);
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
