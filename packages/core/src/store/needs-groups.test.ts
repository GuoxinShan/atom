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
        cand("a", "Desk OAuth login", { theme: "OAuth" }),
        cand("b", "OAuth refresh expiry", { tags: { theme: "OAuth" } }),
        cand("c", "日历冲突", { theme: "日历" }),
      ],
      workspaces
    );
    const oauth = groups.find((g) => g.kind === "theme" && g.title === "OAuth");
    const cal = groups.find((g) => g.kind === "theme" && g.title === "日历");
    assert.ok(oauth);
    assert.deepEqual(oauth?.candidate_ids.sort(), ["a", "b"]);
    assert.deepEqual(cal?.candidate_ids, ["c"]);
    assert.equal(groups.reduce((n, g) => n + g.candidate_ids.length, 0), 3);
  });

  it("uses project when theme is missing", () => {
    const groups = groupNeedsYouCandidates(
      [
        cand("a", "one", { project: "ATOM" }),
        cand("b", "two", { tags: { project: "ATOM" } }),
      ],
      workspaces
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.kind, "project");
    assert.equal(groups[0]?.title, "ATOM");
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
      [cand("a", "x", { theme: "OAuth", project: "ATOM" })],
      workspaces
    );
    assert.equal(groups[0]?.kind, "theme");
    assert.equal(groups[0]?.title, "OAuth");
  });

  it("clusters untagged cards by workspace instead of one flat list", () => {
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
    const yzj = groups.find((g) => g.candidate_ids.includes("c") && g.candidate_ids.includes("d"));
    assert.ok(atom, `missing ATOM group: ${JSON.stringify(groups)}`);
    assert.ok(yzj, `missing yzj group: ${JSON.stringify(groups)}`);
    assert.equal(atom?.kind, "heuristic");
    assert.equal(yzj?.kind, "heuristic");
    assert.match(atom?.key ?? "", /^heuristic:ws:atom/);
    assert.match(yzj?.key ?? "", /^heuristic:ws:yzj/);
    assert.match(atom?.title ?? "", /ATOM/);
    assert.match(yzj?.title ?? "", /云之家|日历/);
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
        cand("a", "已通过", { status: "accepted", theme: "OAuth" }),
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
