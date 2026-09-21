import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchCandidateToDone, extractLinks, type DoneMatchContext } from "./done-match.js";
import type { ProgressSnapshot } from "./progress-snapshot.js";
import type { WorkspaceEntry } from "../agents/lead.js";

const workspaces: WorkspaceEntry[] = [
  {
    id: "atom",
    machine: "rock-shan",
    path: "/Users/kingdee/dev/personal/atom",
    kind: "personal",
    tags: ["atom", "事元"],
    match: ["ATOM", "需求日报", "事元产品", "Desk"],
  },
  {
    id: "yzj",
    machine: "rock-shan",
    path: "/Users/kingdee/dev/yzj",
    kind: "work",
    tags: ["yunzhijia"],
    match: ["云之家", "1023", "日历", "schedule/mcp"],
  },
  {
    id: "ai-advance",
    machine: "rock-shan",
    path: "/Users/kingdee/dev/ai-advance",
    kind: "work",
    tags: ["ai-advance"],
    match: ["AI推进", "ai-advance", "lingee"],
  },
];

function snapshot(items: ProgressSnapshot["workspaces"][number]["items"], extra?: Partial<ProgressSnapshot["workspaces"][number]>): ProgressSnapshot {
  return {
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
        items,
        ...extra,
      },
      {
        id: "yzj",
        path: "/Users/kingdee/dev/yzj",
        available: false,
        fail_open: true,
        reason: "path missing",
        items: [],
      },
      {
        id: "ai-advance",
        path: "/Users/kingdee/dev/ai-advance",
        available: false,
        fail_open: true,
        reason: "path missing",
        items: [],
      },
    ],
  };
}

describe("done matcher", () => {
  it("hits a title near-dup of a merged PR", () => {
    const ctx: DoneMatchContext = {
      snapshot: snapshot([
        {
          kind: "pr",
          title: "feat: migrate stenography into lingee MCP",
          body: "速记迁入灵基 MCP",
          url: "https://github.com/GuoxinShan/atom/pull/42",
          number: 42,
          workspace_id: "atom",
        },
      ]),
      history: [],
      workspaces,
    };
    const hit = matchCandidateToDone(
      { title: "需要把速记迁入灵基 MCP", body: "群里说 stenography 要进 lingee" },
      ctx
    );
    assert.equal(hit.hit, true);
    if (hit.hit) {
      assert.equal(hit.evidence.kind, "pr");
      assert.match(hit.reason, /PR|提交|标题/);
    }
  });

  it("hits Desk history accepted / rejected / merged", () => {
    const ctx: DoneMatchContext = {
      snapshot: null,
      history: [
        {
          id: "cand_old",
          title: "需要给 ATOM Desk 加上 OAuth 登录",
          body: "本机登录后才能批候选",
          refs: ["yzj:im:g:oauth"],
          status: "accepted",
        },
      ],
      workspaces,
    };
    const hit = matchCandidateToDone(
      {
        id: "cand_new",
        title: "ATOM Desk 需要 OAuth 登录",
        body: "本机登录",
        refs: ["yzj:im:g:oauth-2"],
      },
      ctx
    );
    assert.equal(hit.hit, true);
    if (hit.hit) {
      assert.equal(hit.via, "history");
      assert.equal(hit.evidence.candidate_id, "cand_old");
    }
  });

  it("hits a shared PR / issue URL", () => {
    const url = "https://github.com/GuoxinShan/atom/pull/28";
    const ctx: DoneMatchContext = {
      snapshot: snapshot([
        {
          kind: "pr",
          title: "ui: polish Desk Needs-you",
          url,
          number: 28,
          workspace_id: "atom",
        },
      ]),
      history: [],
      workspaces,
    };
    const hit = matchCandidateToDone(
      { title: "跟一下这个 PR", body: `见 ${url}` },
      ctx
    );
    assert.equal(hit.hit, true);
    if (hit.hit) {
      assert.equal(hit.via, "link");
      assert.equal(hit.evidence.url, url);
    }
  });

  it("stays uncertain (suggested) when titles are unrelated", () => {
    const ctx: DoneMatchContext = {
      snapshot: snapshot([
        {
          kind: "commit",
          title: "chore: bump pnpm lockfile",
          sha: "abc1234deadbeef",
          workspace_id: "atom",
        },
      ]),
      history: [
        {
          id: "cand_cal",
          title: "1023 日历冲突提醒",
          body: "会议重叠要提示",
          refs: ["yzj:im:g:cal"],
          status: "rejected",
        },
      ],
      workspaces,
    };
    const miss = matchCandidateToDone(
      { title: "需要给上下文图谱加单机分发", body: "不要绑云之家账号" },
      ctx
    );
    assert.equal(miss.hit, false);
  });

  it("fail-opens repo matching when snapshot is missing", () => {
    const miss = matchCandidateToDone(
      { title: "随便一个还没做过的需求" },
      { snapshot: null, history: [], workspaces }
    );
    assert.equal(miss.hit, false);
    if (!miss.hit) assert.equal(miss.failOpen, true);
  });

  it("does not drop when the only workspace scan failed and has no items", () => {
    const ctx: DoneMatchContext = {
      snapshot: {
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
      },
      history: [],
      workspaces,
    };
    const miss = matchCandidateToDone({ title: "需要把速记迁入灵基 MCP" }, ctx);
    assert.equal(miss.hit, false);
    if (!miss.hit) assert.equal(miss.failOpen, true);
  });

  it("extracts http links for matching", () => {
    const links = extractLinks("see https://github.com/GuoxinShan/atom/pull/12.");
    assert.equal(links.some((u) => u.includes("github.com/guoxinshan/atom/pull/12")), true);
  });
});
