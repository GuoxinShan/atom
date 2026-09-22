import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DONE_TITLE_MIN,
  distinctiveSharedStems,
  doneTopicOverlap,
  extractLinks,
  matchCandidateToDone,
  type DoneMatchContext,
} from "./done-match.js";
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

const WS_PATH: Record<string, string> = {
  atom: "/Users/kingdee/dev/personal/atom",
  yzj: "/Users/kingdee/dev/yzj",
  "ai-advance": "/Users/kingdee/dev/ai-advance",
};

function snapshot(
  items: ProgressSnapshot["workspaces"][number]["items"],
  extra?: Partial<ProgressSnapshot["workspaces"][number]>,
  workspaceId: "atom" | "yzj" | "ai-advance" = "atom"
): ProgressSnapshot {
  const ids = ["atom", "yzj", "ai-advance"] as const;
  return {
    version: 1,
    generated_at: "2026-09-21T00:00:00.000Z",
    source: "progress-scan",
    since_days: 90,
    workspaces: ids.map((id) => {
      if (id !== workspaceId) {
        return {
          id,
          path: WS_PATH[id],
          available: false,
          fail_open: true,
          reason: "path missing",
          items: [],
        };
      }
      return {
        id,
        path: WS_PATH[id],
        available: true,
        fail_open: false,
        items,
        ...extra,
      };
    }),
  };
}

const ATOM_CHORE_PR = {
  kind: "pr" as const,
  title: "Tighten Desk-history Done matching across themes",
  body: "After #30 dogfood on Rock-Shan, Done closed Needs-you 33→2, but Desk history same-topic matching could false-positive across themes (速记 vs 日程). Cross-theme near-dups do not already_done from history alone — 速记 vs 日程/会议, 产品缺陷 vs 发布与发布流程. Repo PR title near-dup still works.",
  url: "https://github.com/GuoxinShan/atom/pull/31",
  number: 31,
  workspace_id: "atom",
};

describe("done matcher", () => {
  it("hits a title near-dup of a merged PR in ai-advance", () => {
    const ctx: DoneMatchContext = {
      snapshot: snapshot(
        [
          {
            kind: "pr",
            title: "feat: migrate stenography into lingee MCP",
            body: "速记迁入灵基 MCP",
            url: "https://github.com/kingdee/ai-advance/pull/42",
            number: 42,
            workspace_id: "ai-advance",
          },
        ],
        undefined,
        "ai-advance"
      ),
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
      assert.equal(hit.evidence.workspace_id, "ai-advance");
      assert.match(hit.reason, /PR|提交|标题/);
    }
  });

  it("does not close 发布与发布流程 business cards against atom chore PR titles", () => {
    const ctx: DoneMatchContext = {
      snapshot: snapshot([ATOM_CHORE_PR]),
      history: [],
      workspaces,
    };
    const skill = matchCandidateToDone(
      {
        title: "明确88技能同步发布流程",
        body: "需要明确 88 技能同步到发布流程",
        theme: "发布与发布流程",
        tags: { theme: "发布与发布流程" },
      },
      ctx
    );
    const pipeline = matchCandidateToDone(
      {
        title: "流水线审核还没过",
        body: "发布与发布流程里流水线审核卡住",
        theme: "发布与发布流程",
        tags: { theme: "发布与发布流程" },
      },
      ctx
    );
    assert.equal(skill.hit, false);
    assert.equal(pipeline.hit, false);
  });

  it("closes 发布与发布流程 card against same-workspace yzj PR title", () => {
    const ctx: DoneMatchContext = {
      snapshot: snapshot(
        [
          {
            kind: "pr",
            title: "feat: 明确88技能同步发布流程",
            body: "同步 88 技能到发布流水线",
            url: "https://code.yzjop.com/yzj/yzj/pull/88",
            number: 88,
            workspace_id: "yzj",
          },
        ],
        undefined,
        "yzj"
      ),
      history: [],
      workspaces,
    };
    const hit = matchCandidateToDone(
      {
        title: "明确88技能同步发布流程",
        body: "需要明确 88 技能同步发布流程",
        theme: "发布与发布流程",
        tags: { theme: "发布与发布流程" },
      },
      ctx
    );
    assert.equal(hit.hit, true);
    if (hit.hit) {
      assert.equal(hit.via, "title");
      assert.equal(hit.evidence.workspace_id, "yzj");
    }
  });

  it("closes ATOM Desk card against atom repo PR", () => {
    const ctx: DoneMatchContext = {
      snapshot: snapshot([
        {
          kind: "pr",
          title: "feat: ATOM Desk OAuth login",
          body: "本机登录后才能批候选",
          url: "https://github.com/GuoxinShan/atom/pull/9",
          number: 9,
          workspace_id: "atom",
        },
      ]),
      history: [],
      workspaces,
    };
    const hit = matchCandidateToDone(
      { title: "需要给 ATOM Desk 加上 OAuth 登录", body: "本机登录后才能批候选" },
      ctx
    );
    assert.equal(hit.hit, true);
    if (hit.hit) {
      assert.equal(hit.evidence.workspace_id, "atom");
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

  it("hits same-theme Desk history (速记 paraphrase)", () => {
    const ctx: DoneMatchContext = {
      snapshot: null,
      history: [
        {
          id: "cand_steno_old",
          title: "评估速记迁入灵基并重做lingee壳鉴权",
          body: "速记迁入灵基，重做 lingee 壳鉴权",
          refs: ["yzj:im:g:steno"],
          status: "accepted",
          theme: "速记",
        },
      ],
      workspaces,
    };
    const hit = matchCandidateToDone(
      {
        id: "cand_steno_new",
        title: "速记迁入灵基鉴权",
        body: "评估速记迁入灵基并重做鉴权",
        refs: ["yzj:im:g:steno-2"],
        theme: "速记",
      },
      ctx
    );
    assert.equal(hit.hit, true);
    if (hit.hit) {
      assert.equal(hit.via, "history");
      assert.equal(hit.evidence.candidate_id, "cand_steno_old");
    }
  });

  it("does not close 速记 against 日程 accepted history (shared refs / MCP near-dup)", () => {
    const ctx: DoneMatchContext = {
      snapshot: null,
      history: [
        {
          id: "cand_cal",
          title: "修复日程 MCP 云之家鉴权失败",
          body: "云之家授权失败导致日程 MCP 拉不下来",
          refs: ["yzj:im:g:mcp"],
          status: "accepted",
          theme: "日程/会议",
        },
      ],
      workspaces,
    };
    const miss = matchCandidateToDone(
      {
        id: "cand_steno",
        title: "修复速记 MCP 云之家鉴权失败",
        body: "云之家授权失败导致速记 MCP 拉不下来",
        refs: ["yzj:im:g:mcp"],
        theme: "速记",
      },
      ctx
    );
    assert.equal(miss.hit, false);
  });

  it("does not close untagged 速记 title against untagged 日程 history (divert)", () => {
    const ctx: DoneMatchContext = {
      snapshot: null,
      history: [
        {
          id: "cand_cal",
          title: "修复日程 MCP 云之家授权失败",
          body: "云之家授权失败导致日程 MCP 拉不下来",
          refs: ["yzj:im:g:cal"],
          status: "accepted",
        },
      ],
      workspaces,
    };
    const miss = matchCandidateToDone(
      {
        id: "cand_steno",
        title: "评估速记迁入灵基并重做lingee壳鉴权",
        body: "速记迁入灵基，重做 lingee 壳鉴权",
        refs: ["yzj:im:g:cal"],
      },
      ctx
    );
    assert.equal(miss.hit, false);
  });

  it("does not close 产品缺陷 against 发布与发布流程 history", () => {
    const ctx: DoneMatchContext = {
      snapshot: null,
      history: [
        {
          id: "cand_release",
          title: "发布按钮点了没反应",
          body: "发布与发布流程里点发布没有反馈",
          refs: ["yzj:im:g:ship"],
          status: "rejected",
          theme: "发布与发布流程",
        },
      ],
      workspaces,
    };
    const miss = matchCandidateToDone(
      {
        id: "cand_bug",
        title: "发布按钮点了没反应",
        body: "产品缺陷：点发布没有反馈",
        refs: ["yzj:im:g:ship"],
        theme: "产品缺陷",
      },
      ctx
    );
    assert.equal(miss.hit, false);
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

  it("does not close 会议 MCP 注入失败 against an unrelated networkId/云之家 commit", () => {
    const card = {
      id: "cand_muca7rf5",
      title: "修复内置会议 MCP 默认注入失败",
      body: "内置会议 MCP 默认没有注入，云之家会议拉不起来",
    };
    const commitTitle = "feat: networkId 解析失败落 warn，附云之家原始响应摘要";
    const commitBody = "networkId 解析失败时打 warn，并附上云之家原始响应摘要";
    const stems = distinctiveSharedStems(`${card.title} ${card.body}`, `${commitTitle} ${commitBody}`);
    assert.equal(stems.includes("失败"), false);
    assert.equal(stems.includes("云之"), false);
    assert.equal(stems.includes("之家"), false);
    assert.deepEqual(stems, ["云之家"]);

    const commit = {
      kind: "commit" as const,
      title: commitTitle,
      body: commitBody,
      sha: "a1b2c3d4e5f67890",
    };
    const ai = matchCandidateToDone(card, {
      snapshot: snapshot([{ ...commit, workspace_id: "ai-advance" }], undefined, "ai-advance"),
      history: [],
      workspaces,
    });
    assert.equal(ai.hit, false);

    // 云之家 in the card affines yzj, but that keyword is not the same work.
    const yzj = matchCandidateToDone(card, {
      snapshot: snapshot([{ ...commit, workspace_id: "yzj" }], undefined, "yzj"),
      history: [],
      workspaces,
    });
    assert.equal(yzj.hit, false);
  });

  it("still closes 会议 MCP 注入失败 when the commit is the same work", () => {
    const hit = matchCandidateToDone(
      {
        title: "修复内置会议 MCP 默认注入失败",
        body: "内置会议 MCP 默认没有注入",
      },
      {
        snapshot: snapshot(
          [
            {
              kind: "commit",
              title: "fix: 修复内置会议 MCP 默认注入失败",
              body: "补上内置会议 MCP 的默认注入",
              sha: "deadbeefcafebabe",
              workspace_id: "yzj",
            },
          ],
          undefined,
          "yzj"
        ),
        history: [],
        workspaces,
      }
    );
    assert.equal(hit.hit, true);
    if (hit.hit) {
      assert.equal(hit.via, "title");
      assert.match(hit.evidence.title, /会议 MCP/);
    }
  });

  it("still closes on distinctive stems plus workspace affinity below the title floor", () => {
    const candTitle = "速记迁入灵基 MCP";
    const candBody = "AI推进这边要处理。甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥";
    const itemTitle = "chore: refresh worker notes";
    const itemBody =
      "速记迁入灵基 MCP. alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray";
    const overlap = Math.max(
      doneTopicOverlap(candTitle, itemTitle),
      doneTopicOverlap(`${candTitle} ${candBody}`, `${itemTitle} ${itemBody}`)
    );
    assert.ok(overlap < DONE_TITLE_MIN, `expected overlap below ${DONE_TITLE_MIN}, got ${overlap}`);
    const stems = distinctiveSharedStems(`${candTitle} ${candBody}`, `${itemTitle} ${itemBody}`);
    assert.ok(stems.includes("速记") && stems.includes("灵基") && stems.includes("迁入"));
    assert.ok(stems.length >= 3);
    const hit = matchCandidateToDone(
      { title: candTitle, body: candBody },
      {
        snapshot: snapshot(
          [
            {
              kind: "commit",
              title: itemTitle,
              body: itemBody,
              sha: "bbbbbbbccccccc1",
              workspace_id: "ai-advance",
            },
          ],
          undefined,
          "ai-advance"
        ),
        history: [],
        workspaces,
      }
    );
    assert.equal(hit.hit, true);
    if (hit.hit) assert.equal(hit.evidence.workspace_id, "ai-advance");
  });
});
