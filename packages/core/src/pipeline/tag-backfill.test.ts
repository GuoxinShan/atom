import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { LayaClient, type LayaFetch } from "../agents/laya.js";
import { openDb } from "../store/db.js";
import { EventStore } from "../store/events.js";
import { projectCandidates } from "../store/candidates.js";
import { groupNeedsYouCandidates } from "../store/needs-groups.js";
import { newId } from "../schema/ids.js";
import type { Ref } from "../schema/types.js";
import { classifyTagBackfill, runTagBackfill } from "./tag-backfill.js";
import { DEFAULT_THEME_VOCABULARY } from "../agents/theme-vocabulary.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-tag-bf-"));
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

function isTagPredict(body: unknown): boolean {
  const q = (body as { questions?: Record<string, unknown> })?.questions;
  return Boolean(q && typeof q === "object" && "theme" in q && "project" in q);
}

const ref: Ref = { token: "yzj:im:g:tag-bf", kind: "im", digest: "tag-bf" };

function seedCandidate(
  store: EventStore,
  title: string,
  extra: Record<string, unknown> = {},
  createdAt?: string
): string {
  const id = newId("cand");
  store.append({
    type: "candidate_proposed",
    subject_id: id,
    summary: title,
    detail: {
      title,
      body: extra.body ?? title,
      confidence: 0.8,
      cluster_key: `existing-${id}`,
      ...extra,
    },
    refs: [ref],
    actor: "test",
    created_at: createdAt,
  });
  return id;
}

function tagAnswers(theme: string, project = "none") {
  return {
    answers: {
      theme: { choice: theme, confidence: 0.93 },
      project: { choice: project, confidence: 0.91 },
    },
  };
}

describe("tag-backfill", () => {
  it("applies Laya tags and maps kebab slugs onto the Chinese allowlist", async () => {
    const store = await tempStore();
    const untagged = seedCandidate(
      store,
      "leftover freeform ticket xyz",
      { body: "free-form leftover" },
      "2026-09-20T10:00:00.000Z"
    );
    const kebab = seedCandidate(
      store,
      "发布 checklist 卡住",
      { theme: "release-process", tags: { theme: "release-process" } },
      "2026-09-20T11:00:00.000Z"
    );
    const alias = seedCandidate(
      store,
      "旧日历标签",
      { theme: "日历" },
      "2026-09-20T12:00:00.000Z"
    );
    const { fetch, calls } = recordingFetch(async (url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      assert.equal(isTagPredict(body), true);
      const title = String((body as { state?: { title?: string } }).state?.title ?? "");
      if (title.includes("leftover")) return jsonResponse(tagAnswers("速记", "AI推进"));
      return jsonResponse(tagAnswers("Schedule Mcp", "none"));
    });
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const result = await runTagBackfill(store, { apply: true, laya });

    assert.equal(result.apply, true);
    assert.equal(result.considered, 3);
    assert.equal(result.tagged, 3);
    const byId = Object.fromEntries(projectCandidates(store).map((c) => [c.id, c]));
    assert.equal(byId[untagged]?.theme, "速记");
    assert.equal(byId[untagged]?.project, "AI推进");
    assert.equal(byId[untagged]?.tags?.theme, "速记");
    assert.equal(byId[kebab]?.theme, "发布与发布流程");
    assert.equal(byId[alias]?.theme, "日程/会议");
    assert.equal(
      calls.filter((c) => c.url.endsWith("/v1/predict")).length,
      1,
      "kebab/alias remaps must not call Laya"
    );
    const taggedEv = store.list({ type: "candidate_tagged" });
    assert.equal(taggedEv.length, 3);
    assert.equal(taggedEv.every((e) => e.actor === "system:laya-tags"), true);
    const layaDetail = JSON.parse(
      taggedEv.find((e) => e.subject_id === untagged)!.detail_json
    ) as { via?: string; laya_tags?: { theme?: string; fail_open?: boolean } };
    assert.equal(layaDetail.via, "laya");
    assert.equal(layaDetail.laya_tags?.theme, "速记");
    assert.equal(layaDetail.laya_tags?.fail_open, false);
    const kebabDetail = JSON.parse(
      taggedEv.find((e) => e.subject_id === kebab)!.detail_json
    ) as { via?: string; theme?: string };
    assert.equal(kebabDetail.via, "allowlist");
    assert.equal(kebabDetail.theme, "发布与发布流程");

    const groups = groupNeedsYouCandidates(projectCandidates(store), []);
    assert.equal(groups.some((g) => g.kind === "heuristic"), false);
    assert.ok(groups.some((g) => g.kind === "theme" && g.title === "速记"));
    assert.ok(groups.some((g) => g.kind === "theme" && g.title === "发布与发布流程"));
    assert.ok(groups.some((g) => g.kind === "theme" && g.title === "日程/会议"));
    assert.equal(
      groups.some((g) => g.title === "release-process" || g.title === "Schedule Mcp"),
      false
    );

    const again = await runTagBackfill(store, { apply: true, laya });
    assert.equal(again.tagged, 0);
    assert.equal(store.list({ type: "candidate_tagged" }).length, 3);
  });

  it("fail-opens a timed-out card and leaves it unchanged", async () => {
    const store = await tempStore();
    const timedOut = seedCandidate(
      store,
      "leftover freeform ticket xyz",
      { body: "must login before triage" },
      "2026-09-20T10:00:00.000Z"
    );
    const later = seedCandidate(
      store,
      "Need a login refresh token leftover",
      { body: "free-form leftover sibling" },
      "2026-09-20T11:00:00.000Z"
    );
    let tagAttempts = 0;
    const { fetch } = recordingFetch(async (url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      tagAttempts += 1;
      if (tagAttempts === 1) return hangFetch()(url, init);
      return jsonResponse(tagAnswers("速记", "AI推进"));
    });
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 40 });
    const result = await runTagBackfill(store, { apply: true, laya });

    assert.equal(tagAttempts, 2);
    assert.equal(laya.unavailable, false);
    assert.equal(result.failOpen, true);
    assert.equal(result.tagged, 1);
    const byId = Object.fromEntries(projectCandidates(store).map((c) => [c.id, c]));
    assert.equal(byId[timedOut]?.status, "suggested");
    assert.equal(byId[timedOut]?.theme, undefined);
    assert.equal(byId[later]?.theme, "速记");
    assert.equal(store.list({ type: "candidate_tagged" }).length, 1);
    assert.equal(
      store.list({ type: "candidate_tagged" }).some((e) => e.subject_id === timedOut),
      false
    );
  });

  it("skips accepted, rejected, and merged cards", async () => {
    const store = await tempStore();
    const accepted = seedCandidate(
      store,
      "已通过的速记需求",
      {},
      "2026-09-20T10:00:00.000Z"
    );
    store.append({
      type: "decision_accepted",
      subject_id: accepted,
      summary: "accepted",
      actor: "test",
      created_at: "2026-09-20T10:30:00.000Z",
    });
    const rejected = seedCandidate(
      store,
      "Rejected schedule mcp leftover",
      { theme: "release-process" },
      "2026-09-20T11:00:00.000Z"
    );
    store.append({
      type: "decision_rejected",
      subject_id: rejected,
      summary: "rejected",
      actor: "test",
      created_at: "2026-09-20T11:30:00.000Z",
    });
    const merged = seedCandidate(
      store,
      "Merged twin",
      {},
      "2026-09-20T12:00:00.000Z"
    );
    store.append({
      type: "decision_merged",
      subject_id: merged,
      summary: "merged",
      detail: { merged_ids: [merged] },
      actor: "test",
      created_at: "2026-09-20T12:30:00.000Z",
    });
    const open = seedCandidate(
      store,
      "开放卡片 leftover",
      {},
      "2026-09-20T13:00:00.000Z"
    );

    const { fetch, calls } = recordingFetch(async (url) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      return jsonResponse(tagAnswers("速记", "none"));
    });
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const result = await runTagBackfill(store, { apply: true, laya });

    assert.equal(result.considered, 1);
    assert.equal(result.tagged, 1);
    assert.equal(result.items[0]?.id, open);
    const byId = Object.fromEntries(projectCandidates(store).map((c) => [c.id, c]));
    assert.equal(byId[accepted]?.status, "accepted");
    assert.equal(byId[accepted]?.theme, undefined);
    assert.equal(byId[rejected]?.status, "rejected");
    assert.equal(byId[rejected]?.theme, "release-process");
    assert.equal(byId[merged]?.status, "merged");
    assert.equal(byId[merged]?.theme, undefined);
    assert.equal(byId[open]?.status, "suggested");
    assert.equal(byId[open]?.theme, "速记");
    assert.equal(
      calls.filter((c) => c.url.endsWith("/v1/predict")).length,
      1
    );
    assert.equal(store.list({ type: "candidate_tagged" }).length, 1);
    assert.equal(store.list({ type: "candidate_tagged" })[0]?.subject_id, open);
    assert.equal(classifyTagBackfill(byId[accepted]!, DEFAULT_THEME_VOCABULARY), "skip");
    assert.equal(classifyTagBackfill(byId[rejected]!, DEFAULT_THEME_VOCABULARY), "skip");
    assert.equal(classifyTagBackfill(byId[merged]!, DEFAULT_THEME_VOCABULARY), "skip");
  });

  it("dry-run prints mapped tags and writes nothing", async () => {
    const store = await tempStore();
    seedCandidate(store, "发布 checklist", { theme: "release-process" });
    seedCandidate(store, "速记迁入灵基");
    const { fetch } = recordingFetch(async (url) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      return jsonResponse(tagAnswers("速记"));
    });
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const result = await runTagBackfill(store, { laya });
    assert.equal(result.apply, false);
    assert.equal(result.tagged, 2);
    assert.equal(store.list({ type: "candidate_tagged" }).length, 0);
    assert.equal(store.list({ type: "agent_started" }).length, 0);
    const suggested = projectCandidates(store).filter((c) => c.status === "suggested");
    assert.equal(suggested.some((c) => c.theme === "速记"), false);
    assert.equal(suggested.some((c) => c.theme === "发布与发布流程"), false);
  });

  it("fail-opens Laya-down cards and still remaps kebab without calling predict", async () => {
    const store = await tempStore();
    const kebab = seedCandidate(store, "release notes", { theme: "product-bug" });
    const divert = seedCandidate(store, "速记迁入灵基");
    const leftover = seedCandidate(store, "leftover freeform ticket xyz");
    const laya = new LayaClient({
      fetch: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      },
      enabled: true,
      timeoutMs: 40,
    });
    const result = await runTagBackfill(store, { apply: true, laya });
    assert.equal(result.failOpen, true);
    assert.equal(result.layaAvailable, false);
    assert.equal(result.reason, "laya-unavailable");
    assert.equal(result.tagged, 2);
    const byId = Object.fromEntries(projectCandidates(store).map((c) => [c.id, c]));
    assert.equal(byId[kebab]?.theme, "产品缺陷");
    assert.equal(byId[divert]?.theme, "速记");
    assert.equal(byId[leftover]?.theme, undefined);
    assert.equal(store.list({ type: "agent_started" }).length, 0);
  });

  it("diverts 「其他」 / untagged cards onto the closed vocabulary without new labels", async () => {
    const store = await tempStore();
    const other = seedCandidate(
      store,
      "速记迁入灵基鉴权",
      { theme: "其他", tags: { theme: "其他" } },
      "2026-09-20T10:00:00.000Z"
    );
    const untagged = seedCandidate(
      store,
      "修复日程 MCP 云之家授权失败",
      {},
      "2026-09-20T11:00:00.000Z"
    );
    const canonical = seedCandidate(
      store,
      "already tagged",
      { theme: "产品缺陷" },
      "2026-09-20T12:00:00.000Z"
    );
    let predictCalls = 0;
    const { fetch } = recordingFetch(async (url) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      predictCalls += 1;
      return jsonResponse(tagAnswers("其他"));
    });
    const laya = new LayaClient({ fetch, enabled: true, timeoutMs: 200 });
    const result = await runTagBackfill(store, { apply: true, laya });
    assert.equal(result.tagged, 2);
    assert.equal(predictCalls, 0, "text divert must not call Laya or add vocabulary");
    const byId = Object.fromEntries(projectCandidates(store).map((c) => [c.id, c]));
    assert.equal(byId[other]?.theme, "速记");
    assert.equal(byId[untagged]?.theme, "日程/会议");
    assert.equal(byId[canonical]?.theme, "产品缺陷");
    assert.equal(
      result.items.every((i) => i.via === "divert"),
      true
    );
    const groups = groupNeedsYouCandidates(projectCandidates(store), []);
    assert.ok(groups.some((g) => g.title === "速记"));
    assert.ok(groups.some((g) => g.title === "日程/会议"));
    assert.equal(groups.some((g) => g.title === "其他"), false);
    const vocabTitles = DEFAULT_THEME_VOCABULARY.themes.map((l) => l.title);
    assert.equal(vocabTitles.includes("OAuth"), false);
    assert.equal(vocabTitles.includes("Task Ui"), false);
  });
});
