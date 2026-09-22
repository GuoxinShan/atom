import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  defaultPreferenceMemory,
  loadPreferenceMemory,
  parsePreferenceMemory,
  savePreferenceMemory,
} from "../agents/preference-memory.js";
import { newId } from "../schema/ids.js";
import type { CandidateProposal, ExtractAgent, Ref } from "../schema/types.js";
import { openDb } from "../store/db.js";
import { projectCandidates } from "../store/candidates.js";
import { EventStore } from "../store/events.js";
import { rejectCandidate } from "./decisions.js";
import { runExtract } from "./extract.js";
import {
  IRRELEVANT_LABEL,
  MUTED_SOURCE_LABEL,
  NOT_MINE_REASON,
  distinctiveStem,
  isPersonalAsk,
  isUserIrrelevantReason,
  judgeIrrelevant,
  muteSource,
  teachIrrelevantFromReject,
  unmuteSource,
} from "./irrelevant.js";
import { runPreferenceRsi } from "./preference-rsi.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-irr-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  const db = await openDb(path.join(dir, "atom.sqlite"));
  return { store: new EventStore(db), repoRoot: dir };
}

const MCP = "6a4ce0e0e4b0611af90e3087";
const OTHER = "6a9a59d1e4b043b377865acf";

const RELEASE = "明确88环境技能同步到沙箱/预发布/生产的发布流程";

function refFor(group: string, msg: string): Ref {
  return { token: `yzj-ai-advance:im:${group}:${msg}`, kind: "im", digest: msg };
}

function seed(
  store: EventStore,
  title: string,
  group: string,
  extra: { body?: string; confidence?: number; theme?: string } = {}
): string {
  const id = newId("cand");
  store.append({
    type: "candidate_proposed",
    subject_id: id,
    summary: title,
    detail: {
      title,
      body: extra.body ?? title,
      confidence: extra.confidence ?? 0.8,
      ...(extra.theme ? { theme: extra.theme, tags: { theme: extra.theme } } : {}),
    },
    refs: [refFor(group, id)],
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

describe("跟我无关 preference", () => {
  it("maps a local 拒绝 onto a source+theme scope and leaves system reasons alone", () => {
    assert.equal(isUserIrrelevantReason(undefined), true);
    assert.equal(isUserIrrelevantReason(""), true);
    assert.equal(isUserIrrelevantReason("跟我无关"), true);
    assert.equal(isUserIrrelevantReason(NOT_MINE_REASON), true);
    assert.equal(isUserIrrelevantReason("noise-heuristic"), false);
    assert.equal(isUserIrrelevantReason("already_done"), false);
    assert.equal(isUserIrrelevantReason("irrelevant"), false);
    assert.match(distinctiveStem(RELEASE), /技能同步/);
    assert.equal(isPersonalAsk("单国鑫请你确认发布流程", "", 0.4), true);
    assert.equal(isPersonalAsk(RELEASE, "群里在对流程", 0.95), false);
  });

  it("reject writes preference; next extract drops the same source+theme and keeps a personal ask", async () => {
    const { store, repoRoot } = await tempCtx();
    const id = seed(store, RELEASE, MCP, {
      body: "mcpApp开发群在对 88 环境技能同步的发布流程",
      confidence: 0.82,
    });
    rejectCandidate(store, id, NOT_MINE_REASON, "user:local");
    const taught = teachIrrelevantFromReject(store, repoRoot, id);
    assert.equal(taught.learned, true);
    assert.equal(taught.scope?.source, MCP);
    assert.equal(taught.scope?.theme, "发布与发布流程");

    const memory = loadPreferenceMemory(repoRoot, store);
    assert.equal(memory.irrelevant.length, 1);
    assert.equal(memory.irrelevant[0]?.source, MCP);
    assert.equal(memory.irrelevant[0]?.theme, "发布与发布流程");
    assert.match(memory.irrelevant[0]?.stem ?? "", /技能同步/);
    assert.equal(memory.cursor_at, null);

    const near: CandidateProposal = {
      title: "再明确88环境技能同步到沙箱的发布流程",
      body: "还是 mcpApp 技能同步发布流程",
      confidence: 0.95,
      refs: [refFor(MCP, "near")],
      source_message_ids: ["near"],
    };
    const personal: CandidateProposal = {
      title: "单国鑫请你确认88环境技能同步到生产的发布流程",
      body: "需要你拍板这次是否上预发布",
      confidence: 0.93,
      refs: [refFor(MCP, "personal")],
      source_message_ids: ["personal"],
    };
    const otherGroup: CandidateProposal = {
      title: "需要给 ATOM Desk 加上 OAuth 登录",
      body: "必须支持本机登录后才能批候选",
      confidence: 0.9,
      refs: [refFor(OTHER, "oauth")],
      source_message_ids: ["oauth"],
    };
    const weak: CandidateProposal = {
      title: "今天对一下发布",
      body: "没有具体流程",
      confidence: 0.7,
      refs: [refFor(MCP, "weak")],
      source_message_ids: ["weak"],
    };

    const result = await runExtract(store, stubAgent([near, personal, otherGroup, weak]), {
      heuristicGate: false,
      laya: false,
      repoRoot,
    });

    assert.equal(result.irrelevant >= 1, true);
    assert.equal(result.proposed, 3);
    const cands = projectCandidates(store);
    const nearRow = cands.find((c) => c.title === near.title);
    const personalRow = cands.find((c) => c.title === personal.title);
    const otherRow = cands.find((c) => c.title === otherGroup.title);
    const weakRow = cands.find((c) => c.title === weak.title);
    assert.equal(nearRow?.status, "rejected");
    assert.equal(nearRow?.disposition, "irrelevant");
    assert.equal(nearRow?.closed_reason, IRRELEVANT_LABEL);
    assert.equal(personalRow?.status, "suggested");
    assert.equal(otherRow?.status, "suggested");
    assert.equal(weakRow?.status, "suggested");
    assert.equal(weakRow?.disposition, undefined);

    const uncertain = judgeIrrelevant(
      { title: weak.title, body: weak.body, refs: weak.refs, confidence: 0.7 },
      memory
    );
    assert.equal(uncertain.action, "keep");
    assert.equal(uncertain.uncertain, true);
  });

  it("a sibling already on Needs you is diverted, and a different theme in the same group stays", async () => {
    const { store, repoRoot } = await tempCtx();
    const id = seed(store, RELEASE, MCP);
    const sibling = seed(store, "跟进88环境技能同步到预发布的发布流程", MCP, { confidence: 0.84 });
    const bug = seed(store, "修复 mcpApp 登录后会话丢失", MCP, {
      body: "会话丢失，跟发布流程无关",
      theme: "产品缺陷",
    });
    rejectCandidate(store, id, NOT_MINE_REASON);
    const taught = teachIrrelevantFromReject(store, repoRoot, id);
    assert.equal(taught.diverted.includes(sibling), true);
    const rows = projectCandidates(store);
    assert.equal(rows.find((c) => c.id === sibling)?.disposition, "irrelevant");
    assert.equal(rows.find((c) => c.id === bug)?.status, "suggested");
  });

  it("RSI apply keeps 跟我无关 scopes and can record one from not_mine feedback", async () => {
    const { store, repoRoot } = await tempCtx();
    const kept = {
      ...defaultPreferenceMemory(),
      irrelevant: [{ source: "group-kept", theme: "日程/会议", stem: "日历同步" }],
      muted_sources: [{ source: MCP, label: "mcpApp开发群" }],
    };
    savePreferenceMemory(repoRoot, kept);

    for (let i = 0; i < 4; i++) {
      const id = newId("cand");
      store.append({
        type: "candidate_proposed",
        subject_id: id,
        summary: `接受事项 ${i} 需要落地`,
        detail: { title: `接受事项 ${i} 需要落地`, body: "需求", confidence: 0.7 },
        refs: [refFor(OTHER, `acc-${i}`)],
        actor: "test",
      });
      store.append({
        type: "decision_accepted",
        subject_id: id,
        summary: "accepted",
        detail: {},
        actor: "user:local",
      });
    }
    const rejected = seed(store, "补一版技能同步到沙箱的发布流程", MCP, {
      body: "mcpApp 发布流程",
    });
    store.append({
      type: "decision_rejected",
      subject_id: rejected,
      summary: "rejected",
      detail: { reason: NOT_MINE_REASON },
      refs: [refFor(MCP, rejected)],
      actor: "user:local",
    });

    const applied = runPreferenceRsi(store, { apply: true, repoRoot });
    assert.equal(applied.reason, "adjusted");
    const memory = loadPreferenceMemory(repoRoot, store);
    assert.equal(
      memory.irrelevant.some((s) => s.source === "group-kept" && s.theme === "日程/会议"),
      true
    );
    assert.equal(
      memory.irrelevant.some((s) => s.source === MCP && s.theme === "发布与发布流程"),
      true
    );
    assert.equal(
      memory.muted_sources.some((s) => s.source === MCP && s.label === "mcpApp开发群"),
      true
    );
  });

  it("mutes a group so new cards stay off Needs you, and unmute lets the next extract through", async () => {
    const { store, repoRoot } = await tempCtx();
    const open = seed(store, "群里对一下技能包版本", MCP, { confidence: 0.7 });
    const personalOpen = seed(store, "单国鑫请你看一下这个技能包", MCP, {
      body: "需要你确认",
      confidence: 0.9,
    });
    const muted = muteSource(store, repoRoot, MCP, "mcpApp开发群");
    assert.equal(muted.ok, true);
    assert.equal(muted.diverted.includes(open), true);
    const swept = projectCandidates(store);
    assert.equal(swept.find((c) => c.id === open)?.status, "rejected");
    assert.equal(swept.find((c) => c.id === open)?.disposition, "muted_source");
    assert.equal(swept.find((c) => c.id === open)?.closed_reason, MUTED_SOURCE_LABEL);
    assert.equal(swept.find((c) => c.id === personalOpen)?.status, "suggested");

    const memory = loadPreferenceMemory(repoRoot, store);
    assert.equal(memory.muted_sources.length, 1);
    assert.equal(memory.muted_sources[0]?.source, MCP);
    assert.equal(memory.cursor_at, null);

    const chatter: CandidateProposal = {
      title: "再明确一下沙箱环境的技能同步节奏",
      body: "mcpApp开发群日常对节奏",
      confidence: 0.88,
      refs: [refFor(MCP, "chatter")],
      source_message_ids: ["chatter"],
    };
    const otherGroup: CandidateProposal = {
      title: "需要给 ATOM Desk 加上 OAuth 登录",
      body: "必须支持本机登录后才能批候选",
      confidence: 0.9,
      refs: [refFor(OTHER, "oauth")],
      source_message_ids: ["oauth"],
    };
    const personal: CandidateProposal = {
      title: "单国鑫请你确认今天的日程冲突",
      body: "需要你拍板这次冲突",
      confidence: 0.91,
      refs: [refFor(MCP, "ask")],
      source_message_ids: ["ask"],
    };

    const hidden = await runExtract(store, stubAgent([chatter, otherGroup, personal]), {
      heuristicGate: false,
      laya: false,
      repoRoot,
    });
    assert.equal(hidden.irrelevant >= 1, true);
    assert.equal(hidden.proposed, 2);
    const rows = projectCandidates(store);
    const chatterRow = rows.find((c) => c.title === chatter.title);
    assert.equal(chatterRow?.status, "rejected");
    assert.equal(chatterRow?.disposition, "muted_source");
    assert.equal(chatterRow?.closed_reason, MUTED_SOURCE_LABEL);
    assert.equal(rows.find((c) => c.title === otherGroup.title)?.status, "suggested");
    assert.equal(rows.find((c) => c.title === personal.title)?.status, "suggested");

    const cleared = unmuteSource(store, repoRoot, MCP);
    assert.equal(cleared.changed, true);
    assert.equal(loadPreferenceMemory(repoRoot, store).muted_sources.length, 0);
    assert.equal(projectCandidates(store).find((c) => c.title === chatter.title)?.status, "rejected");

    const restored: CandidateProposal = {
      title: "下周技能包要不要进预发布环境",
      body: "mcpApp开发群新话题",
      confidence: 0.86,
      refs: [refFor(MCP, "restored")],
      source_message_ids: ["restored"],
    };
    const again = await runExtract(store, stubAgent([restored]), {
      heuristicGate: false,
      laya: false,
      repoRoot,
    });
    assert.equal(again.proposed, 1);
    assert.equal(
      projectCandidates(store).find((c) => c.title === restored.title)?.status,
      "suggested"
    );
  });

  it("parses a preference file that has no irrelevant field", () => {
    const parsed = parsePreferenceMemory({
      version: 1,
      thresholds: { noise: 0.8, merge: 0.9, outbound: 0.8 },
      blocklist: ["午饭闲聊"],
    });
    assert.deepEqual(parsed.irrelevant, []);
    assert.deepEqual(parsed.muted_sources, []);
    assert.deepEqual(parsed.blocklist, ["午饭闲聊"]);
  });
});
