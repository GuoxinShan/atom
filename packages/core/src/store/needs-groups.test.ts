import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceEntry } from "../agents/lead.js";
import type { CandidateView, Ref } from "../schema/types.js";
import {
  groupNeedsYouCandidates,
  matchWorkspace,
  titleStem,
} from "../store/needs-groups.js";

const ref: Ref = { token: "yzj:im:g:1", kind: "im", digest: "x" };

const workspaces: WorkspaceEntry[] = [
  {
    id: "atom",
    machine: "rock-shan",
    path: "/atom",
    kind: "personal",
    tags: ["atom", "事元"],
    match: ["ATOM", "需求日报", "事元产品"],
  },
  {
    id: "yzj",
    machine: "rock-shan",
    path: "/yzj",
    kind: "work",
    tags: ["yunzhijia", "1023"],
    match: ["云之家", "1023", "日历"],
  },
];

function cand(
  id: string,
  title: string,
  extra: Partial<CandidateView> = {}
): CandidateView {
  return {
    id,
    title,
    body: extra.body ?? title,
    confidence: 0.8,
    status: extra.status ?? "suggested",
    refs: extra.refs ?? [ref],
    updated_at: extra.updated_at ?? "2026-09-21T01:00:00.000Z",
    cluster_key: extra.cluster_key,
    theme: extra.theme,
    project: extra.project,
    tags: extra.tags,
  };
}

describe("Needs-you display grouping", () => {
  it("groups by stored theme tags and keeps cards distinct", () => {
    const groups = groupNeedsYouCandidates(
      [
        cand("a", "Desk OAuth login", { theme: "产品缺陷" }),
        cand("b", "OAuth refresh expiry", { tags: { theme: "产品缺陷" } }),
        cand("c", "日历冲突", { theme: "日程/会议" }),
      ],
      workspaces
    );
    const bugs = groups.find((g) => g.kind === "theme" && g.title === "产品缺陷");
    const cal = groups.find((g) => g.kind === "theme" && g.title === "日程/会议");
    assert.ok(bugs);
    assert.deepEqual(bugs?.candidate_ids.sort(), ["a", "b"]);
    assert.deepEqual(cal?.candidate_ids, ["c"]);
    assert.equal(groups.reduce((n, g) => n + g.candidate_ids.length, 0), 3);
  });

  it("uses project when theme is missing", () => {
    const groups = groupNeedsYouCandidates(
      [
        cand("a", "one", { project: "ATOM" }),
        cand("b", "two", { tags: { project: "事元" } }),
      ],
      workspaces
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.kind, "project");
    assert.equal(groups[0]?.title, "事元");
    assert.deepEqual(groups[0]?.candidate_ids.sort(), ["a", "b"]);
  });

  it("prefers stored Chinese theme over workspace heuristic", () => {
    const groups = groupNeedsYouCandidates(
      [cand("a", "需要给 1023 日历加上 schedule/mcp 超时修复", { theme: "AI推进" })],
      workspaces
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.kind, "theme");
    assert.equal(groups[0]?.title, "AI推进");
    assert.deepEqual(groups[0]?.candidate_ids, ["a"]);
  });

  it("prefers theme over project on the same card", () => {
    const groups = groupNeedsYouCandidates(
      [cand("a", "x", { theme: "产品缺陷", project: "ATOM" })],
      workspaces
    );
    assert.equal(groups[0]?.kind, "theme");
    assert.equal(groups[0]?.title, "产品缺陷");
  });

  it("maps kebab slugs and unknown titles onto the Chinese allowlist", () => {
    const groups = groupNeedsYouCandidates(
      [
        cand("a", "ship checklist", { theme: "release-process" }),
        cand("b", "rollout notes", { tags: { theme: "release_process" } }),
        cand("c", "crash on save", { theme: "product-bug" }),
        cand("d", "oauth leftover", { theme: "OAuth" }),
        cand("e", "also unknown", { tags: { theme: "foo-bar-baz" } }),
        cand("f", "old calendar tag", { theme: "日历" }),
      ],
      workspaces
    );
    const titles = groups.map((g) => g.title).sort();
    assert.deepEqual(titles, ["其他", "发布与发布流程", "产品缺陷", "日程/会议"].sort());
    const release = groups.find((g) => g.title === "发布与发布流程");
    const bugs = groups.find((g) => g.title === "产品缺陷");
    const other = groups.find((g) => g.title === "其他");
    const cal = groups.find((g) => g.title === "日程/会议");
    assert.deepEqual(release?.candidate_ids.sort(), ["a", "b"]);
    assert.deepEqual(bugs?.candidate_ids, ["c"]);
    assert.deepEqual(other?.candidate_ids.sort(), ["d", "e"]);
    assert.deepEqual(cal?.candidate_ids, ["f"]);
    assert.ok(groups.every((g) => g.kind === "theme"));
    assert.ok(groups.length <= 4);
  });

  it("diverts untagged 速记 / 日程 cards out of 其他 into the closed vocabulary", () => {
    const groups = groupNeedsYouCandidates(
      [
        cand("a", "速记迁入灵基鉴权", { theme: "其他" }),
        cand("b", "评估速记迁入灵基并重做lingee壳鉴权"),
        cand("c", "修复日程 MCP 云之家授权失败"),
        cand("d", "leftover freeform ticket xyz", { theme: "OAuth" }),
      ],
      workspaces
    );
    const shorthand = groups.find((g) => g.title === "速记");
    const cal = groups.find((g) => g.title === "日程/会议");
    const other = groups.find((g) => g.title === "其他");
    assert.ok(shorthand);
    assert.deepEqual(shorthand?.candidate_ids.sort(), ["a", "b"]);
    assert.equal(shorthand?.kind, "theme");
    assert.deepEqual(cal?.candidate_ids, ["c"]);
    assert.deepEqual(other?.candidate_ids, ["d"]);
    assert.equal(groups.filter((g) => g.title === "其他").length, 1);
    assert.equal(
      groups.some((g) => g.title === "迁移方案" || g.key.startsWith("heuristic:")),
      false
    );
  });

  it("folds heuristic AI推进 leftovers into the canonical theme bucket", () => {
    const groups = groupNeedsYouCandidates(
      [
        cand("a", "推进五态任务拆解", { theme: "AI推进" }),
        cand("b", "Task Ui 交互", {
          body: "lingee 推进五态 Task Ui",
          cluster_key: "task-ui",
        }),
        cand("c", "AI推进 · 鉴权壳", { body: "lingee 壳鉴权" }),
      ],
      [
        {
          id: "ai-advance",
          machine: "rock-shan",
          path: "/ai-advance",
          kind: "work",
          tags: ["ai-advance", "lingee"],
          match: ["AI推进", "lingee", "推进五态"],
        },
      ]
    );
    const ai = groups.filter((g) => g.title === "AI推进");
    assert.equal(ai.length, 1);
    assert.equal(ai[0]?.kind, "theme");
    assert.deepEqual(ai[0]?.candidate_ids.sort(), ["a", "b", "c"]);
    assert.equal(groups.some((g) => g.kind === "heuristic"), false);
  });

  it("diverts untagged workspace-looking cards onto allowlist theme/project", () => {
    const groups = groupNeedsYouCandidates(
      [
        cand("a", "需要给 ATOM Desk 加上 OAuth 登录", { cluster_key: "existing-cand_aaa111" }),
        cand("b", "Desk 需要 OAuth 本机登录"),
        cand("c", "需要给 1023 日历加上日程冲突提醒"),
        cand("d", "日历 MCP 超时"),
      ],
      workspaces
    );
    assert.ok(groups.length >= 2, `expected split groups, got ${groups.map((g) => g.title).join(",")}`);
    const atom = groups.find((g) => g.candidate_ids.includes("a") && g.candidate_ids.includes("b"));
    const cal = groups.find((g) => g.candidate_ids.includes("c") || g.candidate_ids.includes("d"));
    assert.ok(atom, `missing ATOM/事元 group: ${JSON.stringify(groups)}`);
    assert.ok(cal, `missing calendar/云之家 group: ${JSON.stringify(groups)}`);
    assert.equal(atom?.kind, "project");
    assert.equal(atom?.title, "事元");
    assert.equal(cal?.kind, "theme");
    assert.equal(["日程/会议", "云之家"].includes(cal?.title ?? ""), true);
    assert.equal(groups.some((g) => g.kind === "heuristic"), false);
  });

  it("clusters untagged cards sharing a title stem / cluster_key", () => {
    const byTitle = groupNeedsYouCandidates(
      [cand("a", "导出 CSV 乱码"), cand("b", "导出 PDF 分页")],
      []
    );
    assert.equal(byTitle.length, 1);
    assert.equal(byTitle[0]?.kind, "heuristic");
    assert.deepEqual(byTitle[0]?.candidate_ids.sort(), ["a", "b"]);
    assert.match(byTitle[0]?.title ?? "", /导出/);

    const byKey = groupNeedsYouCandidates(
      [
        cand("a", "login timeout", { cluster_key: "oauth-desk-login" }),
        cand("b", "refresh token", { cluster_key: "oauth-desk-timeout" }),
      ],
      []
    );
    assert.equal(byKey.length, 1);
    assert.deepEqual(byKey[0]?.candidate_ids.sort(), ["a", "b"]);
    assert.match(byKey[0]?.title ?? "", /OAuth Desk/i);
  });

  it("ignores accepted cards and technical cluster_key ids", () => {
    const groups = groupNeedsYouCandidates(
      [
        cand("a", "已通过", { status: "accepted", theme: "产品缺陷" }),
        cand("b", "剩下的", { cluster_key: "cand_zzzzzz" }),
      ],
      workspaces
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.key, "heuristic:other");
    assert.deepEqual(groups[0]?.candidate_ids, ["b"]);
  });

  it("matchWorkspace does not default unsure cards to atom", () => {
    assert.equal(matchWorkspace(cand("x", "随便写个导出"), workspaces), undefined);
    assert.equal(matchWorkspace(cand("y", "ATOM Desk empty state"), workspaces)?.id, "atom");
    assert.equal(titleStem("feat: 导出 CSV 乱码"), "导出");
  });
});
