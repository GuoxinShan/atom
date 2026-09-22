import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { openDb } from "../store/db.js";
import { EventStore } from "../store/events.js";
import { newId } from "../schema/ids.js";
import type { CodingAgent, Ref } from "../schema/types.js";
import { approveCandidate } from "./decisions.js";
import { exportHandoff, listSpecDrafts } from "./handoff.js";
import {
  approveSpec,
  dispatchToLead,
  HANDOFF_LIMITATION_FILE,
  HANDOFF_LIMITATION_REUSED,
  returnSpec,
  SpecReviewError,
  specsAwaitingReview,
} from "./spec-review.js";

const tmpDirs: string[] = [];
const prevLaya = process.env.LAYA_ENABLED;

after(() => {
  if (prevLaya == null) delete process.env.LAYA_ENABLED;
  else process.env.LAYA_ENABLED = prevLaya;
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

const ref: Ref = { token: "yzj:im:g:spec-review", kind: "im", digest: "desk-oauth" };

async function tempRepo(): Promise<{ store: EventStore; repoRoot: string }> {
  process.env.LAYA_ENABLED = "0";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-spec-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "data/workspaces.json"),
    JSON.stringify({
      version: 1,
      defaultMachine: "test",
      machines: {},
      workspaces: [
        {
          id: "atom",
          machine: "test",
          path: "/tmp/atom",
          kind: "personal",
          tags: ["atom", "desk"],
          match: ["ATOM", "Desk", "OAuth"],
        },
      ],
    })
  );
  fs.writeFileSync(path.join(dir, "data/user-context.md"), "test user");
  const db = await openDb(path.join(dir, "data/atom.sqlite"));
  return { store: new EventStore(db), repoRoot: dir };
}

function seedSuggested(store: EventStore, title = "Desk 需要 OAuth 本机登录"): string {
  const id = newId("cand");
  store.append({
    type: "candidate_proposed",
    subject_id: id,
    summary: title,
    detail: { title, body: "必须支持登录后才能批候选", confidence: 0.9 },
    refs: [ref],
    actor: "test",
  });
  return id;
}

function countingCoding(): { agent: CodingAgent; calls: number } {
  const box = { calls: 0 };
  const agent: CodingAgent = {
    id: "test-coding",
    async handoff(spec) {
      box.calls += 1;
      return {
        id: newId("handoff"),
        spec_id: spec.id,
        candidate_id: spec.candidate_id,
        path: "/tmp/never.md",
        target: "grok-cli",
      };
    },
  };
  return {
    agent,
    get calls() {
      return box.calls;
    },
  };
}

describe("spec review → explicit Lead handoff", () => {
  it("accept creates one spec draft and does not dispatch", async () => {
    const { store, repoRoot } = await tempRepo();
    const coding = countingCoding();
    const candId = seedSuggested(store);
    const first = approveCandidate(store, candId);
    const second = approveCandidate(store, candId);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.specId, first.specId);

    const specs = listSpecDrafts(store);
    assert.equal(specs.length, 1);
    assert.equal(specs[0]?.id, first.specId);
    assert.equal(specs[0]?.candidate_id, candId);
    assert.equal(specs[0]?.review_status, "pending");
    assert.equal(specs[0]?.stage_label, "spec 待审");
    assert.ok(specs[0]?.acceptance_criteria.length);
    assert.equal(specsAwaitingReview(store).length, 1);

    assert.equal(store.list({ type: "handoff_exported" }).length, 0);
    assert.equal(store.list({ type: "agent_started" }).length, 0);
    assert.equal(coding.calls, 0);

    await assert.rejects(
      () => dispatchToLead(store, repoRoot, first.specId, coding.agent, { laya: false }),
      (err: unknown) => err instanceof SpecReviewError && err.code === "not_approved"
    );
    assert.equal(coding.calls, 0);
    assert.equal(store.list({ type: "handoff_exported" }).length, 0);
  });

  it("approve / return transitions, then explicit handoff is idempotent", async () => {
    const { store, repoRoot } = await tempRepo();
    const candId = seedSuggested(store);
    const { specId } = approveCandidate(store, candId);

    const returned = returnSpec(store, specId, {
      title: "Desk OAuth 本机登录",
      body: "登录后才能批候选。",
      acceptance_criteria: ["本机可登录", "会话保持"],
      note: "收紧标题",
    });
    assert.equal(returned.review_status, "returned");
    assert.equal(returned.stage_label, "spec 待审");
    assert.equal(returned.title, "Desk OAuth 本机登录");
    assert.deepEqual(returned.acceptance_criteria, ["本机可登录", "会话保持"]);

    const approved = approveSpec(store, specId);
    assert.equal(approved.review_status, "approved");
    assert.equal(approved.stage_label, "已批准");
    const again = approveSpec(store, specId);
    assert.equal(again.review_status, "approved");
    assert.equal(store.list({ type: "spec_approved" }).length, 1);

    const coding = countingCoding();
    const first = await dispatchToLead(store, repoRoot, specId, coding.agent, {
      target: "file",
      laya: false,
    });
    assert.equal(first.reused, false);
    assert.equal(first.ran, false);
    assert.equal(first.limitation, HANDOFF_LIMITATION_FILE);
    assert.equal(first.spec.review_status, "handed_off");
    assert.equal(first.spec.stage_label, "已派 Lead");
    assert.ok(first.pack.path.includes(`${path.sep}out${path.sep}handoffs${path.sep}`));
    assert.equal(fs.existsSync(first.pack.path), true);
    const md = fs.readFileSync(first.pack.path, "utf8");
    assert.match(md, /Lead agent briefing/);
    assert.match(md, /Desk OAuth/);
    assert.equal(coding.calls, 0);

    const second = await dispatchToLead(store, repoRoot, specId, coding.agent, {
      target: "file",
      run: true,
      laya: false,
    });
    assert.equal(second.reused, true);
    assert.equal(second.pack.id, first.pack.id);
    assert.equal(second.limitation, HANDOFF_LIMITATION_REUSED);
    assert.equal(coding.calls, 0);
    assert.equal(store.list({ type: "handoff_exported" }).length, 1);

    assert.throws(
      () => returnSpec(store, specId, { note: "too late" }),
      (err: unknown) => err instanceof SpecReviewError && err.code === "not_editable"
    );
    assert.equal(specsAwaitingReview(store).length, 0);
  });

  it("low-level exportHandoff does not duplicate packs", async () => {
    const { store, repoRoot } = await tempRepo();
    const candId = seedSuggested(store);
    const { specId } = approveCandidate(store, candId);
    approveSpec(store, specId);
    const a = await exportHandoff(store, repoRoot, specId, undefined, { target: "file", laya: false });
    const b = await exportHandoff(store, repoRoot, specId, undefined, { target: "file", laya: false });
    assert.equal(a.id, b.id);
    assert.equal(store.list({ type: "handoff_exported" }).length, 1);
  });
});
