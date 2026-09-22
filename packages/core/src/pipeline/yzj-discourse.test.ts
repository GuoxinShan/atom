import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { openDb } from "../store/db.js";
import { EventStore } from "../store/events.js";
import { projectCandidates } from "../store/candidates.js";
import { newId } from "../schema/ids.js";
import type { Ref } from "../schema/types.js";
import { loadProgressSnapshot, writeProgressSnapshot, type ProgressSnapshot } from "./progress-snapshot.js";
import { runProgressScan, type RunCommand } from "./progress-scan.js";
import { matchCandidateToDone, type DoneMatchContext } from "./done-match.js";
import {
  ALREADY_DONE_LABEL,
  YZJ_ALREADY_DONE_LABEL,
  applyDoneGateToSuggested,
  reopenCandidate,
} from "./done-gate.js";
import {
  buildYzjDiscourse,
  completionFromClause,
  completionsFromText,
  discourseItemsFromMessages,
  foldYzjDiscourse,
  type DiscourseMessage,
} from "./yzj-discourse.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(path.join(here, "fixtures/yzj-completions.json"), "utf8")
) as {
  hit: DiscourseMessage;
  weak: DiscourseMessage[];
  theme_mismatch: DiscourseMessage;
  other_source: DiscourseMessage;
};

const NOW = new Date("2026-09-22T00:00:00.000Z");
const CARD = "上下文图谱 CLI 单机分发";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-yzj-done-"));
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
          path: path.join(dir, "missing-atom"),
          kind: "personal",
          tags: ["atom"],
          match: ["ATOM"],
        },
        {
          id: "yzj",
          machine: "test",
          path: path.join(dir, "missing-yzj"),
          kind: "work",
          tags: ["1023"],
          match: ["云之家"],
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

function ingest(store: EventStore, msg: DiscourseMessage): void {
  store.append({
    type: "message_ingested",
    subject_id: msg.id,
    summary: msg.text.slice(0, 80),
    detail: {
      source: msg.source,
      groupId: msg.groupId,
      text: msg.text,
      ts: msg.ts,
      adapter_id: msg.source,
    },
    actor: "test",
    created_at: msg.ts,
  });
}

function seedSuggested(
  store: EventStore,
  title: string,
  extra: Record<string, unknown> = {}
): string {
  const id = newId("cand");
  const refs: Ref[] = [{ token: "yzj:im:g:card", kind: "im", digest: title.slice(0, 40) }];
  store.append({
    type: "candidate_proposed",
    subject_id: id,
    summary: title,
    detail: { title, body: String(extra.body ?? title), confidence: 0.8, ...extra },
    refs,
    actor: "test",
  });
  return id;
}

function ctxFrom(snapshot: ProgressSnapshot | null): DoneMatchContext {
  return { snapshot, history: [], workspaces: [] };
}

describe("云之家 completion phrases", () => {
  it("treats an assertive 已上线 line as a progress item", () => {
    const hit = completionFromClause(fixture.hit.text);
    assert.ok(hit);
    assert.match(hit!.phrase, /上线/);
    assert.match(hit!.subject, /上下文图谱/);
    assert.match(hit!.subject, /单机分发/);
    const items = discourseItemsFromMessages([fixture.hit], { now: NOW });
    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, "yzj");
    assert.equal(items[0]?.message_id, fixture.hit.id);
    assert.match(items[0]?.title ?? "", /上下文图谱 CLI 单机分发/);
    const bareDone = completionFromClause("上下文图谱 CLI 单机分发搞定");
    assert.equal(bareDone?.phrase, "搞定");
    assert.equal(completionFromClause("帮我把上下文图谱 CLI 单机分发搞定"), null);
  });

  it("ignores weak, negated, future, and question chat", () => {
    for (const msg of fixture.weak) {
      const hits = completionsFromText(msg.text);
      assert.equal(hits.length, 0, msg.text);
    }
    const items = discourseItemsFromMessages(fixture.weak, { now: NOW });
    assert.equal(items.length, 0);
  });

  it("does not treat a non-yzj source as 云之家 progress", () => {
    const items = discourseItemsFromMessages([fixture.other_source, fixture.hit], { now: NOW });
    assert.equal(items.length, 1);
    assert.equal(items[0]?.message_id, fixture.hit.id);
    const missing = buildYzjDiscourse([fixture.other_source], { now: NOW });
    assert.equal(missing.fail_open, true);
    assert.equal(missing.available, false);
    assert.equal(missing.items.length, 0);
  });
});

describe("云之家 discourse Done matching", () => {
  it("closes when the completion subject covers the card", () => {
    const discourse = buildYzjDiscourse([fixture.hit], { now: NOW });
    const snapshot: ProgressSnapshot = {
      version: 1,
      generated_at: NOW.toISOString(),
      source: "progress-scan",
      since_days: 90,
      workspaces: [],
      discourse,
    };
    const verdict = matchCandidateToDone({ title: CARD, body: "单机版，不要绑账号" }, ctxFrom(snapshot));
    assert.equal(verdict.hit, true);
    if (verdict.hit) {
      assert.equal(verdict.via, "yzj");
      assert.equal(verdict.evidence.kind, "yzj");
      assert.match(verdict.reason, /云之家进度关闭/);
    }
  });

  it("does not close on weak chat or a narrower follow-up", () => {
    const discourse = buildYzjDiscourse([fixture.hit, ...fixture.weak], { now: NOW });
    assert.equal(discourse.fail_open, false);
    assert.equal(discourse.items.length, 1);
    const snapshot: ProgressSnapshot = {
      version: 1,
      generated_at: NOW.toISOString(),
      source: "progress-scan",
      since_days: 90,
      workspaces: [],
      discourse,
    };
    const weakOnly = buildYzjDiscourse(fixture.weak, { now: NOW });
    const weakSnap: ProgressSnapshot = { ...snapshot, discourse: weakOnly };
    assert.equal(matchCandidateToDone({ title: CARD }, ctxFrom(weakSnap)).hit, false);
    const narrower = matchCandidateToDone(
      { title: "上下文图谱 CLI 单机分发加水印" },
      ctxFrom(snapshot)
    );
    assert.equal(narrower.hit, false);
  });

  it("does not close across themes", () => {
    const discourse = buildYzjDiscourse([fixture.theme_mismatch], { now: NOW });
    assert.equal(discourse.items.length, 1);
    assert.equal(discourse.items[0]?.theme, "速记");
    const snapshot: ProgressSnapshot = {
      version: 1,
      generated_at: NOW.toISOString(),
      source: "progress-scan",
      since_days: 90,
      workspaces: [],
      discourse,
    };
    const verdict = matchCandidateToDone(
      {
        title: "日程导出 PDF",
        body: "日历导出还没做",
        theme: "日程/会议",
        tags: { theme: "日程/会议" },
      },
      ctxFrom(snapshot)
    );
    assert.equal(verdict.hit, false);
  });

  it("fail-opens when no yzj messages are ingested", async () => {
    const { store, repoRoot } = await tempCtx();
    const id = seedSuggested(store, CARD);
    ingest(store, fixture.other_source);
    const folded = foldYzjDiscourse(store, repoRoot, null, { now: NOW });
    assert.equal(folded, null);
    assert.equal(fs.existsSync(path.join(repoRoot, "data/progress-snapshot.json")), false);
    const result = applyDoneGateToSuggested(store, { apply: true, repoRoot });
    assert.equal(result.closed, 0);
    assert.equal(result.snapshotMissing, true);
    assert.equal(projectCandidates(store).find((c) => c.id === id)?.status, "suggested");
  });

  it("closes from ingested 云之家 talk, labels 云之家进度关闭, and reopen sticks", async () => {
    const { store, repoRoot } = await tempCtx();
    for (const msg of fixture.weak) ingest(store, msg);
    ingest(store, fixture.hit);
    const id = seedSuggested(store, CARD, { body: "单机版分发" });
    const other = seedSuggested(store, "日程导出 PDF", {
      body: "日历导出",
      theme: "日程/会议",
      tags: { theme: "日程/会议" },
    });
    ingest(store, fixture.theme_mismatch);
    const result = applyDoneGateToSuggested(store, { apply: true, repoRoot });
    assert.equal(result.closed, 1);
    assert.equal(result.items[0]?.id, id);
    assert.equal(result.items[0]?.via, "yzj");
    const closed = projectCandidates(store).find((c) => c.id === id);
    assert.equal(closed?.status, "rejected");
    assert.equal(closed?.disposition, "already_done");
    assert.equal(closed?.closed_reason, YZJ_ALREADY_DONE_LABEL);
    assert.notEqual(closed?.closed_reason, ALREADY_DONE_LABEL);
    assert.equal(projectCandidates(store).find((c) => c.id === other)?.status, "suggested");

    const snap = loadProgressSnapshot(repoRoot);
    assert.equal(snap?.discourse?.fail_open, false);
    assert.ok((snap?.discourse?.items.length ?? 0) >= 1);

    const live = reopenCandidate(store, id, "仍要我跟");
    assert.equal(live.status, "suggested");
    assert.equal(live.keep_open, true);
    assert.equal(live.closed_reason, undefined);
    const again = applyDoneGateToSuggested(store, { apply: true, repoRoot });
    assert.equal(again.closed, 0);
    assert.equal(projectCandidates(store).find((c) => c.id === id)?.status, "suggested");
  });

  it("keeps discourse when host progress-scan cannot see git", async () => {
    const { repoRoot } = await tempCtx();
    const discourse = buildYzjDiscourse([fixture.hit], { now: NOW });
    writeProgressSnapshot(repoRoot, {
      version: 1,
      generated_at: "2026-09-21T00:00:00.000Z",
      source: "progress-scan",
      since_days: 90,
      workspaces: [
        {
          id: "atom",
          path: path.join(repoRoot, "missing-atom"),
          available: false,
          fail_open: true,
          reason: "path missing",
          items: [],
        },
      ],
      discourse,
    });
    const run: RunCommand = async () => ({ code: 1, stdout: "", stderr: "no", error: "no" });
    await runProgressScan(repoRoot, { run, now: NOW });
    const snap = loadProgressSnapshot(repoRoot);
    assert.equal(snap?.discourse?.items[0]?.message_id, fixture.hit.id);
    assert.equal(snap?.discourse?.preserved, true);
    assert.equal(snap?.workspaces.some((w) => w.fail_open), true);
  });
});
