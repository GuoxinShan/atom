import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { openDb } from "../store/db.js";
import { EventStore } from "../store/events.js";
import { projectCandidates } from "../store/candidates.js";
import { newId } from "../schema/ids.js";
import type { Ref } from "../schema/types.js";
import { writeProgressSnapshot } from "./progress-snapshot.js";
import { parseGhList, parseGitLog, runProgressScan, type RunCommand } from "./progress-scan.js";
import { runExtract } from "./extract.js";
import {
  ALREADY_DONE_LABEL,
  ALREADY_DONE_REASON,
  applyDoneGateToSuggested,
  reopenCandidate,
  runDoneSweep,
} from "./done-gate.js";
import type { CandidateProposal, ExtractAgent } from "../schema/types.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-done-"));
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
          path: path.join(dir, "repos", "atom"),
          kind: "personal",
          tags: ["atom"],
          match: ["ATOM", "Desk", "事元产品"],
        },
        {
          id: "yzj",
          machine: "test",
          path: path.join(dir, "missing-yzj"),
          kind: "work",
          tags: ["1023"],
          match: ["云之家", "日历"],
        },
        {
          id: "ai-advance",
          machine: "test",
          path: path.join(dir, "missing-ai"),
          kind: "work",
          tags: ["ai-advance"],
          match: ["AI推进"],
        },
      ],
    })
  );
  const db = await openDb(path.join(dir, "atom.sqlite"));
  return { store: new EventStore(db), repoRoot: dir };
}

const ref: Ref = { token: "yzj:im:g:done", kind: "im", digest: "d" };

function seedSuggested(store: EventStore, title: string, extra: Record<string, unknown> = {}): string {
  const id = extra.id ? String(extra.id) : newId("cand");
  store.append({
    type: "candidate_proposed",
    subject_id: id,
    summary: title,
    detail: { title, body: String(extra.body ?? title), confidence: 0.8, ...extra },
    refs: [ref],
    actor: "test",
  });
  return id;
}

function stubAgent(proposals: CandidateProposal[]): ExtractAgent {
  return {
    id: "stub-extract",
    async extract() {
      return proposals;
    },
  };
}

describe("progress-scan parsers + fail-open", () => {
  it("parses gh pr json and git log records", () => {
    const prs = parseGhList(
      JSON.stringify([
        {
          title: "feat: Desk Done gate",
          body: "close already shipped",
          url: "https://github.com/GuoxinShan/atom/pull/99",
          mergedAt: "2026-09-20T00:00:00Z",
          number: 99,
        },
      ]),
      "pr",
      "atom"
    );
    assert.equal(prs.length, 1);
    assert.equal(prs[0]?.kind, "pr");
    assert.equal(prs[0]?.number, 99);

    const commits = parseGitLog(
      "abc1234\x1f速记迁入灵基 MCP\x1fbody here\x1e\ndef5678\x1ffix calendar\x1f\x1e",
      "yzj"
    );
    assert.equal(commits.length, 2);
    assert.equal(commits[0]?.title, "速记迁入灵基 MCP");
    assert.equal(commits[0]?.workspace_id, "yzj");
  });

  it("marks missing workspace paths fail-open and writes a snapshot", async () => {
    const { repoRoot } = await tempCtx();
    const run: RunCommand = async () => ({ code: 1, stdout: "", stderr: "no", error: "no" });
    const result = await runProgressScan(repoRoot, { run, now: new Date("2026-09-21T00:00:00Z") });
    assert.equal(result.failOpen >= 1, true);
    assert.equal(result.snapshot.workspaces.some((w) => w.id === "yzj" && w.fail_open), true);
    assert.equal(fs.existsSync(path.join(repoRoot, "data/progress-snapshot.json")), true);
  });
});

describe("done gate", () => {
  it("fail-opens (keeps suggested) when snapshot is missing", async () => {
    const { store, repoRoot } = await tempCtx();
    const id = seedSuggested(store, "需要给 ATOM Desk 加上空状态文案");
    const result = applyDoneGateToSuggested(store, { apply: true, repoRoot });
    assert.equal(result.closed, 0);
    assert.equal(result.failOpen, true);
    assert.equal(result.snapshotMissing, true);
    assert.equal(projectCandidates(store).find((c) => c.id === id)?.status, "suggested");
  });

  it("fail-opens when docker cannot see git (path missing, empty items)", async () => {
    const { store, repoRoot } = await tempCtx();
    writeProgressSnapshot(repoRoot, {
      version: 1,
      generated_at: "2026-09-21T00:00:00.000Z",
      source: "progress-scan",
      since_days: 90,
      workspaces: [
        {
          id: "atom",
          path: "/Users/kingdee/dev/personal/atom",
          available: false,
          fail_open: true,
          reason: "path missing",
          items: [],
        },
      ],
    });
    const id = seedSuggested(store, "需要把速记迁入灵基 MCP");
    const result = applyDoneGateToSuggested(store, { apply: true, repoRoot });
    assert.equal(result.closed, 0);
    assert.equal(projectCandidates(store).find((c) => c.id === id)?.status, "suggested");
  });

  it("closes a title near-dup to a merged PR as already_done", async () => {
    const { store, repoRoot } = await tempCtx();
    writeProgressSnapshot(repoRoot, {
      version: 1,
      generated_at: "2026-09-21T00:00:00.000Z",
      source: "progress-scan",
      since_days: 90,
      workspaces: [
        {
          id: "atom",
          path: "/Users/kingdee/dev/personal/atom",
          available: true,
          fail_open: false,
          items: [
            {
              kind: "pr",
              title: "feat: migrate stenography into lingee MCP",
              body: "速记迁入灵基 MCP",
              url: "https://github.com/GuoxinShan/atom/pull/42",
              number: 42,
              workspace_id: "atom",
            },
          ],
        },
      ],
    });
    const id = seedSuggested(store, "需要把速记迁入灵基 MCP", {
      body: "群里说 stenography / MCP 要进灵基",
    });
    const result = await runDoneSweep(store, { apply: true, repoRoot });
    assert.equal(result.closed, 1);
    const cand = projectCandidates(store).find((c) => c.id === id);
    assert.equal(cand?.status, "rejected");
    assert.equal(cand?.disposition, "already_done");
    assert.equal(cand?.reject_reason, ALREADY_DONE_REASON);
    assert.equal(cand?.closed_reason, ALREADY_DONE_LABEL);
  });

  it("closes a history hit (previously accepted) as already_done", async () => {
    const { store, repoRoot } = await tempCtx();
    const old = seedSuggested(store, "需要给 ATOM Desk 加上 OAuth 登录", {
      body: "本机登录后才能批候选",
    });
    store.append({
      type: "decision_accepted",
      subject_id: old,
      summary: "accepted",
      actor: "user:local",
    });
    const fresh = seedSuggested(store, "ATOM Desk 需要 OAuth 登录", {
      body: "本机登录才能批候选",
    });
    const result = applyDoneGateToSuggested(store, { apply: true, repoRoot });
    assert.equal(result.closed, 1);
    assert.equal(result.items[0]?.id, fresh);
    assert.equal(projectCandidates(store).find((c) => c.id === fresh)?.disposition, "already_done");
  });

  it("extract live gate closes a near-dup PR and leaves unrelated suggested", async () => {
    const { store, repoRoot } = await tempCtx();
    writeProgressSnapshot(repoRoot, {
      version: 1,
      generated_at: "2026-09-21T00:00:00.000Z",
      source: "progress-scan",
      since_days: 90,
      workspaces: [
        {
          id: "atom",
          path: "/Users/kingdee/dev/personal/atom",
          available: true,
          fail_open: false,
          items: [
            {
              kind: "pr",
              title: "feat: migrate stenography into lingee MCP",
              body: "速记迁入灵基",
              workspace_id: "atom",
            },
          ],
        },
      ],
    });
    const result = await runExtract(
      store,
      stubAgent([
        {
          title: "需要把速记迁入灵基 MCP",
          body: "stenography into lingee",
          confidence: 0.8,
          refs: [ref],
          source_message_ids: ["m1"],
        },
        {
          title: "需要给上下文图谱加单机分发",
          body: "不要绑云之家账号",
          confidence: 0.8,
          refs: [{ token: "yzj:im:g:graph", kind: "im", digest: "g" }],
          source_message_ids: ["m2"],
        },
      ]),
      { heuristicGate: false, laya: false, repoRoot }
    );
    assert.equal(result.alreadyDone, 1);
    assert.equal(result.proposed, 1);
    const cands = projectCandidates(store);
    const done = cands.find((c) => c.title.includes("速记"));
    const open = cands.find((c) => c.title.includes("上下文图谱"));
    assert.equal(done?.status, "rejected");
    assert.equal(done?.disposition, "already_done");
    assert.equal(open?.status, "suggested");
  });

  it("reopen escape puts already_done back on Needs-you and skip later sweeps", async () => {
    const { store, repoRoot } = await tempCtx();
    writeProgressSnapshot(repoRoot, {
      version: 1,
      generated_at: "2026-09-21T00:00:00.000Z",
      source: "progress-scan",
      since_days: 90,
      workspaces: [
        {
          id: "atom",
          path: "/Users/kingdee/dev/personal/atom",
          available: true,
          fail_open: false,
          items: [
            {
              kind: "pr",
              title: "feat: migrate stenography into lingee MCP",
              body: "速记迁入灵基 MCP",
              workspace_id: "atom",
            },
          ],
        },
      ],
    });
    const id = seedSuggested(store, "需要把速记迁入灵基 MCP");
    applyDoneGateToSuggested(store, { apply: true, repoRoot });
    const live = reopenCandidate(store, id, "仍要我跟");
    assert.equal(live.status, "suggested");
    assert.equal(live.keep_open, true);
    const again = applyDoneGateToSuggested(store, { apply: true, repoRoot });
    assert.equal(again.closed, 0);
    assert.equal(projectCandidates(store).find((c) => c.id === id)?.status, "suggested");
  });
});
