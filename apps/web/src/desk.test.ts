import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createDaemon, type Daemon } from "./context.js";
import { handleApi } from "./routes.js";
import { newId } from "@atom/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDirs: string[] = [];
const prevLaya = process.env.LAYA_ENABLED;

before(() => {
  process.env.LAYA_ENABLED = "0";
});

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

async function tempDaemon(): Promise<Daemon> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-desk-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  return createDaemon(dir);
}

type FakeRes = {
  statusCode: number;
  body: string;
  writeHead: (code: number, headers?: Record<string, string>) => void;
  end: (data?: string | Buffer) => void;
  write: (data: string | Buffer) => boolean;
};

function mockRes(): FakeRes {
  return {
    statusCode: 200,
    body: "",
    writeHead(code: number) {
      this.statusCode = code;
    },
    end(data?: string | Buffer) {
      if (data) this.body += String(data);
    },
    write(data: string | Buffer) {
      this.body += String(data);
      return true;
    },
  };
}

async function api(
  daemon: Daemon,
  method: string,
  pathname: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from([payload]) as unknown as http.IncomingMessage;
  req.method = method;
  req.url = pathname;
  req.headers = {};
  const res = mockRes();
  const url = new URL(pathname, "http://127.0.0.1:8787");
  const handled = await handleApi(req, res as unknown as http.ServerResponse, url, daemon);
  assert.equal(handled, true, `expected ${method} ${pathname} to be handled`);
  return { status: res.statusCode, json: JSON.parse(res.body || "{}") as Record<string, unknown> };
}

describe("Desk shell", () => {
  it("renders operator tabs with Needs you as the default home", () => {
    const html = fs.readFileSync(path.join(here, "public/index.html"), "utf8");
    const js = fs.readFileSync(path.join(here, "public/app.js"), "utf8");
    const css = fs.readFileSync(path.join(here, "public/styles.css"), "utf8");
    assert.match(html, /data-page="needs-you"[^>]*class="active">需要你拍板/);
    assert.match(html, /data-page="processed">系统已处理/);
    assert.match(html, /已在仓库\/历史进度关闭/);
    assert.match(html, /云之家进度关闭/);
    assert.match(js, /云之家进度关闭/);
    assert.match(js, /PAGES = \["needs-you", "processed", "preferences", "advanced"\]/);
    assert.match(html, /data-page="preferences">我的偏好/);
    assert.match(html, /data-page="advanced">高级/);
    assert.doesNotMatch(html, /<nav[^>]*>[\s\S]*data-page="atoms"/);
    assert.match(html, /id="page-needs-you"[^>]*class="page desk active"/);
    assert.match(js, /队列空着是正常的/);
    assert.match(js, /新卡片来自你盯着的群/);
    assert.match(js, /empty-desk/);
    assert.match(js, /PAGES = \["needs-you", "processed", "preferences", "advanced"\]/);
    assert.match(js, /showPage\(pageFromHash\(\)\)/);
    assert.match(js, /needs-group/);
    assert.match(js, /needs-group-summary/);
    assert.match(js, /is-other/);
    assert.match(js, /group-chevron/);
    assert.match(js, /fallbackNeedsGroups/);
    assert.match(js, /data-reopen/);
    assert.match(js, /仍要我跟/);
    assert.match(js, /already_done/);
    assert.match(js, /processed-done/);
    assert.match(html, /按主题\/项目折叠/);
    assert.match(html, /规格待审/);
    assert.match(html, /规格进度/);
    assert.match(js, /批准规格/);
    assert.match(js, /退回修改/);
    assert.match(js, /派给 Lead/);
    assert.match(js, /spec-review-card/);
    assert.match(js, /window\.confirm/);
    assert.match(js, /target: "file", run: false/);
    assert.match(js, /\/api\/spec-approve/);
    assert.match(js, /\/api\/spec-return/);
    assert.match(css, /spec-review-board/);
    assert.match(css, /spec-review-card/);
    assert.match(css, /needs-group\.is-other/);
    assert.match(css, /empty-desk/);
    assert.doesNotMatch(css, /#6e7bf2/);
  });

  it("renders the three-section brief and confirms only Lead handoff", () => {
    const js = fs.readFileSync(path.join(here, "public/app.js"), "utf8");
    const css = fs.readFileSync(path.join(here, "public/styles.css"), "utf8");
    const html = fs.readFileSync(path.join(here, "public/index.html"), "utf8");
    assert.match(js, /【摘要】/);
    assert.match(js, /【要你拍板】/);
    assert.match(js, /【可选动作】/);
    assert.match(js, /回群同步/);
    assert.match(js, /即将推出 · 不会发送/);
    assert.match(js, /先记下/);
    assert.match(js, /默认不外发。云之家不会自动发送。/);
    assert.match(js, /data-brief-len="short"/);
    assert.match(js, /data-brief-len="long"/);
    assert.match(js, /data-outbound="group-sync"/);
    assert.match(js, /disabled data-outbound="group-sync"/);
    assert.match(js, /仍要我跟/);
    assert.match(js, /保持关闭/);
    assert.match(js, /记为已通过，草稿进「规格待审」。不外发、不开工。/);
    assert.match(js, /移出今天的队列。同类少露。只记在本机。/);
    assert.match(js, /跟我无关/);
    assert.match(js, /确认后写出本机交接包。不编码、不发云之家。/);
    assert.match(html, /【摘要】/);
    assert.match(html, /今天没有要你拍板的|需要你拍板/);
    assert.match(js, /今天没有要你拍板的/);
    assert.match(css, /\.brief-label/);
    assert.match(css, /\.brief-len/);
    assert.match(css, /\.optional-strip button:disabled/);

    const confirms = [...js.matchAll(/window\.confirm/g)];
    assert.equal(confirms.length, 1);
    const windows = confirms.map((m) => js.slice(Math.max(0, (m.index ?? 0) - 360), (m.index ?? 0) + 160));
    const handoff = windows.find((w) => /data-handoff/.test(w) && /派给 Lead/.test(w));
    assert.ok(handoff);
    assert.doesNotMatch(handoff, /data-spec-approve|data-reopen|data-note|data-act|静音此来源/);
    assert.match(js, /已记下，同类少露/);
    assert.match(js, /已静音「\$\{label\}」/);
    assert.match(js, /已取消静音/);
    assert.match(html, /id="desk-toast"/);
    assert.match(html, /id="morning-line"/);
    assert.match(js, /今日 \$\{n\} 条待拍板/);
    assert.match(js, /来自 \$\{k\} 个群/);
    assert.match(js, /已静音 \$\{muted\} 个来源/);
    assert.match(js, /近一天记下 \$\{recent\} 条/);
    assert.match(css, /\.desk-toast/);
    assert.match(css, /\.morning-line/);

    const approveAt = js.indexOf('data-act="approve"');
    const approveWindow = js.slice(approveAt, approveAt + 500);
    assert.doesNotMatch(approveWindow, /window\.confirm/);
    const specAt = js.indexOf("data-spec-approve");
    assert.doesNotMatch(js.slice(specAt, specAt + 700), /window\.confirm/);
    const reopenAt = js.indexOf("data-reopen");
    assert.doesNotMatch(js.slice(reopenAt, reopenAt + 500), /window\.confirm/);
    const noteAt = js.indexOf("data-note");
    assert.doesNotMatch(js.slice(noteAt, noteAt + 400), /window\.confirm/);
    assert.doesNotMatch(js, /fetch\([^)]*outbound|\/api\/yunzhijia|云之家.*send/i);
  });

  it("shows a source chip under the title and opens cite without sending", () => {
    const js = fs.readFileSync(path.join(here, "public/app.js"), "utf8");
    const css = fs.readFileSync(path.join(here, "public/styles.css"), "utf8");
    const html = fs.readFileSync(path.join(here, "public/index.html"), "utf8");
    const doc = fs.readFileSync(path.join(here, "../../../docs/10-dispatch-desk.md"), "utf8");

    assert.match(js, /class="source-chip"/);
    assert.match(js, /data-open-cite/);
    assert.match(js, /data-cite-href/);
    assert.match(js, /id="cite-block"/);
    assert.match(js, /data-cite-block/);
    assert.match(js, /【原文】/);
    assert.match(js, /只打开查看。不会发送。/);
    assert.match(js, /function onSourceChipClick/);
    assert.match(js, /function revealCite/);
    assert.match(js, /scrollIntoView\(\{ block: "nearest" \}\)/);
    assert.match(css, /\.source-chip/);
    assert.match(css, /\.cite-block/);
    assert.match(html, /标题、来源、【摘要】、【要你拍板】、【可选动作】/);
    assert.match(doc, /source chip/);
    assert.match(doc, /【原文】/);
    assert.match(doc, /never sends/);
    assert.doesNotMatch(css, /#6e7bf2/);

    const cardStart = js.indexOf("function renderSuggestedCard");
    const cardEnd = js.indexOf("function fallbackNeedsGroups");
    const card = js.slice(cardStart, cardEnd);
    const h3 = card.indexOf("<h3>");
    const chip = card.indexOf("sourceChipsHtml");
    const summary = card.indexOf("briefSummarySection");
    const decide = card.indexOf("briefDecideSection");
    const optional = card.indexOf("briefOptionalSection");
    assert.ok(h3 >= 0 && chip > h3 && summary > chip && decide > summary && optional > decide);
    assert.doesNotMatch(card, /whyNeedsYou/);
    assert.match(card, /还没拍板。/);

    const hop = js.indexOf("function onSourceChipClick");
    const handler = js.slice(hop, js.indexOf("function renderDetail"));
    assert.match(handler, /closest\("\[data-open-cite\]"\)/);
    assert.match(handler, /\^https:\\\/\\\//);
    assert.match(handler, /window\.open\(href, "_blank", "noopener,noreferrer"\)/);
    assert.match(handler, /revealCite\(/);
    assert.doesNotMatch(handler, /fetch\(/);
    assert.doesNotMatch(handler, /window\.confirm/);

    const chipFn = js.slice(js.indexOf("function sourceChipHtml"), js.indexOf("function sourceChipsHtml"));
    assert.match(chipFn, /class="source-chip"/);
    assert.match(chipFn, /data-open-cite/);
    assert.match(chipFn, /class="source-mute"/);
    assert.match(chipFn, /data-mute-source/);
    assert.match(chipFn, /静音此来源/);
    const muteHalf = chipFn.split('class="source-mute"')[1] ?? "";
    assert.doesNotMatch(muteHalf, /data-open-cite/);
    assert.match(js, /data-unmute-source/);
    assert.match(js, /取消静音/);
    assert.match(css, /\.source-mute/);
    assert.match(doc, /静音此来源/);

    const confirms = [...js.matchAll(/window\.confirm/g)];
    assert.equal(confirms.length, 1);
    const muteFn = js.slice(js.indexOf("async function onMuteSourceClick"), js.indexOf("function onSourceChipClick"));
    assert.match(muteFn, /已静音「/);
    assert.doesNotMatch(muteFn, /window\.confirm/);
    assert.match(doc, /已静音「群名」/);
    assert.match(doc, /今日 N 条待拍板 · 来自 K 个群/);
    assert.doesNotMatch(doc, /before \*\*静音此来源\*\*/);
  });
});

describe("Desk operator APIs", () => {
  it("serves health, status, candidates, gate-digest, and preference memory", async () => {
    const daemon = await tempDaemon();
    const health = await api(daemon, "GET", "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    assert.equal(health.json.service, "atom-desk");

    const status = await api(daemon, "GET", "/api/status");
    assert.equal(status.status, 200);
    assert.equal(status.json.ok, true);
    const desk = status.json.desk as { ok?: boolean };
    assert.equal(desk.ok, true);
    const pref = status.json.preference as { floors?: { noise?: number }; source_of_truth?: string };
    assert.equal(pref.floors?.noise, 0.8);
    assert.equal(pref.source_of_truth, "data/preference-memory.json");
    const laya = status.json.laya as { enabled?: boolean };
    assert.equal(laya.enabled, false);

    const cands = await api(daemon, "GET", "/api/candidates");
    assert.equal(cands.status, 200);
    assert.ok(Array.isArray(cands.json.candidates));
    assert.ok(Array.isArray(cands.json.groups));

    const digest = await api(daemon, "GET", "/api/gate-digest?since=24h");
    assert.equal(digest.status, 200);
    assert.equal(digest.json.ok, true);
    const extract = digest.json.extract as { noise_dropped?: number };
    const outbound = digest.json.outbound as { allow?: number; drop?: number; hold?: number };
    assert.equal(extract.noise_dropped, 0);
    assert.equal(outbound.allow, 0);
    assert.equal(outbound.drop, 0);
    assert.equal(outbound.hold, 0);

    const memory = await api(daemon, "GET", "/api/preference-memory");
    assert.equal(memory.status, 200);
    assert.equal(memory.json.ok, true);
    assert.equal(memory.json.source_of_truth, "data/preference-memory.json");
    assert.equal(memory.json.exists, false);
    const mem = memory.json.memory as { thresholds?: { noise?: number }; cursor_at?: string | null };
    assert.equal(mem.thresholds?.noise, 0.8);
    assert.equal(mem.cursor_at, null);
    assert.equal(memory.json.last_rsi, null);
  });

  it("groups Needs-you candidates by theme/project or workspace heuristic", async () => {
    const daemon = await tempDaemon();
    fs.writeFileSync(
      path.join(daemon.repoRoot, "data/workspaces.json"),
      JSON.stringify({
        version: 1,
        defaultMachine: "test",
        machines: {},
        workspaces: [
          {
            id: "atom",
            machine: "test",
            path: "/atom",
            kind: "personal",
            tags: ["atom"],
            match: ["ATOM", "事元产品"],
          },
          {
            id: "yzj",
            machine: "test",
            path: "/yzj",
            kind: "work",
            tags: ["1023"],
            match: ["云之家", "1023", "日历"],
          },
        ],
      })
    );
    const ref = { token: "yzj:im:g:desk", kind: "im" as const, digest: "d" };
    const seed = (title: string, extra: Record<string, unknown> = {}) => {
      const id = newId("cand");
      daemon.store.append({
        type: "candidate_proposed",
        subject_id: id,
        summary: title,
        detail: { title, body: title, confidence: 0.8, ...extra },
        refs: [ref],
        actor: "test",
      });
      return id;
    };
    const bugA = seed("Desk OAuth login", { theme: "产品缺陷" });
    const bugB = seed("OAuth refresh", { tags: { theme: "product-bug" } });
    seed("需要给 ATOM Desk 加上空状态文案");
    seed("需要给 1023 日历加上冲突提醒");

    const cands = await api(daemon, "GET", "/api/candidates");
    assert.equal(cands.status, 200);
    const list = cands.json.candidates as Array<{ id: string; theme?: string }>;
    assert.equal(list.length, 4);
    assert.equal(list.find((c) => c.id === bugA)?.theme, "产品缺陷");
    const groups = cands.json.groups as Array<{
      key: string;
      title: string;
      kind: string;
      candidate_ids: string[];
    }>;
    assert.ok(Array.isArray(groups));
    const bugs = groups.find((g) => g.kind === "theme" && g.title === "产品缺陷");
    assert.ok(bugs);
    assert.deepEqual([...bugs.candidate_ids].sort(), [bugA, bugB].sort());
    const atom = groups.find((g) => g.title === "事元");
    const cal = groups.find((g) => g.title === "日程/会议" || g.title === "云之家");
    assert.ok(atom, `missing 事元 group: ${JSON.stringify(groups)}`);
    assert.ok(cal, `missing calendar/云之家 group: ${JSON.stringify(groups)}`);
    assert.equal(atom?.kind, "project");
    assert.equal(cal?.kind, "theme");
    assert.ok(groups.length >= 3);
    assert.equal(
      groups.some((g) => /[A-Za-z]/.test(g.title) && !/[\u3400-\u9fff]/.test(g.title) && g.kind === "theme"),
      false
    );
  });

  it("PATCH preference-memory clamps floors and writes the json file", async () => {
    const daemon = await tempDaemon();
    const patched = await api(daemon, "PATCH", "/api/preference-memory", {
      thresholds: { noise: 0.1, merge: 0.8, outbound: 1.4 },
      blocklist_add: ["午餐闲聊", "x"],
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.changed, true);
    assert.equal(patched.json.exists, true);
    const mem = patched.json.memory as {
      thresholds: { noise: number; merge: number; outbound: number };
      blocklist: string[];
      cursor_at: string | null;
    };
    assert.equal(mem.thresholds.noise, 0.7);
    assert.equal(mem.thresholds.merge, 0.9);
    assert.equal(mem.thresholds.outbound, 0.95);
    assert.deepEqual(mem.blocklist, ["午餐闲聊"]);
    assert.equal(mem.cursor_at, null);
    assert.equal(fs.existsSync(path.join(daemon.repoRoot, "data/preference-memory.json")), true);

    const noop = await api(daemon, "PATCH", "/api/preference-memory", {
      thresholds: { noise: 0.7 },
    });
    assert.equal(noop.json.changed, false);
  });

  it("POST /api/tag-backfill remaps kebab on suggested and skips accepted", async () => {
    const daemon = await tempDaemon();
    const ref = { token: "yzj:im:g:tag-bf", kind: "im" as const, digest: "t" };
    const seed = (title: string, extra: Record<string, unknown> = {}) => {
      const id = newId("cand");
      daemon.store.append({
        type: "candidate_proposed",
        subject_id: id,
        summary: title,
        detail: { title, body: title, confidence: 0.8, ...extra },
        refs: [ref],
        actor: "test",
      });
      return id;
    };
    const kebab = seed("release notes", { theme: "release-process" });
    const accepted = seed("already decided", { theme: "product-bug" });
    daemon.store.append({
      type: "decision_accepted",
      subject_id: accepted,
      summary: "accepted",
      actor: "test",
    });
    const untagged = seed("速记迁入灵基");

    const dry = await api(daemon, "POST", "/api/tag-backfill", {});
    assert.equal(dry.status, 200);
    assert.equal(dry.json.apply, false);
    assert.equal(storeHasTagged(daemon), 0);

    const applied = await api(daemon, "POST", "/api/tag-backfill", { apply: true });
    assert.equal(applied.status, 200);
    assert.equal(applied.json.apply, true);
    assert.equal(applied.json.tagged, 2);
    const items = applied.json.items as Array<{ id: string; theme?: string; via?: string }>;
    assert.equal(items.length, 2);
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    assert.equal(byId[kebab]?.theme, "发布与发布流程");
    assert.equal(byId[kebab]?.via, "allowlist");
    assert.equal(byId[untagged]?.theme, "速记");
    assert.equal(byId[untagged]?.via, "divert");

    const cands = await api(daemon, "GET", "/api/candidates");
    const list = cands.json.candidates as Array<{ id: string; theme?: string; status: string }>;
    assert.equal(list.find((c) => c.id === kebab)?.theme, "发布与发布流程");
    assert.equal(list.find((c) => c.id === accepted)?.theme, "product-bug");
    assert.equal(list.find((c) => c.id === accepted)?.status, "accepted");
    assert.equal(list.find((c) => c.id === untagged)?.theme, "速记");
    assert.equal(storeHasTagged(daemon), 2);
  });

  it("done-sweep closes a merged-PR near-dup and reopen returns it to Needs-you", async () => {
    const daemon = await tempDaemon();
    fs.writeFileSync(
      path.join(daemon.repoRoot, "data/workspaces.json"),
      JSON.stringify({
        version: 1,
        defaultMachine: "test",
        machines: {},
        workspaces: [
          {
            id: "atom",
            machine: "test",
            path: "/atom",
            kind: "personal",
            tags: ["atom"],
            match: ["ATOM", "Desk"],
          },
          {
            id: "yzj",
            machine: "test",
            path: "/yzj",
            kind: "work",
            tags: ["yunzhijia"],
            match: ["云之家", "日历"],
          },
          {
            id: "ai-advance",
            machine: "test",
            path: "/ai-advance",
            kind: "work",
            tags: ["ai-advance"],
            match: ["AI推进", "lingee"],
          },
        ],
      })
    );
    fs.writeFileSync(
      path.join(daemon.repoRoot, "data/progress-snapshot.json"),
      JSON.stringify({
        version: 1,
        generated_at: "2026-09-21T00:00:00.000Z",
        source: "progress-scan",
        since_days: 90,
        workspaces: [
          {
            id: "atom",
            path: "/atom",
            available: false,
            fail_open: true,
            reason: "path missing",
            items: [],
          },
          {
            id: "ai-advance",
            path: "/ai-advance",
            available: true,
            fail_open: false,
            items: [
              {
                kind: "pr",
                title: "feat: migrate stenography into lingee MCP",
                body: "速记迁入灵基 MCP",
                workspace_id: "ai-advance",
              },
            ],
          },
        ],
      })
    );
    const id = newId("cand");
    daemon.store.append({
      type: "candidate_proposed",
      subject_id: id,
      summary: "需要把速记迁入灵基 MCP",
      detail: {
        title: "需要把速记迁入灵基 MCP",
        body: "stenography / MCP 进灵基",
        confidence: 0.8,
      },
      refs: [{ token: "yzj:im:g:steno", kind: "im", digest: "s" }],
      actor: "test",
    });

    const status = await api(daemon, "GET", "/api/status");
    const progress = status.json.progress as { snapshot?: boolean; items?: number };
    assert.equal(progress.snapshot, true);
    assert.equal(progress.items, 1);

    const swept = await api(daemon, "POST", "/api/done-sweep", { apply: true });
    assert.equal(swept.status, 200);
    assert.equal(swept.json.closed, 1);

    const cands = await api(daemon, "GET", "/api/candidates");
    const list = cands.json.candidates as Array<{
      id: string;
      status: string;
      disposition?: string;
      closed_reason?: string;
    }>;
    const row = list.find((c) => c.id === id);
    assert.equal(row?.status, "rejected");
    assert.equal(row?.disposition, "already_done");
    assert.equal(row?.closed_reason, "已在仓库/历史进度关闭");

    const reopened = await api(daemon, "POST", "/api/reopen", { id, note: "仍要我跟" });
    assert.equal(reopened.status, 200);
    const after = await api(daemon, "GET", "/api/candidates");
    const live = (after.json.candidates as Array<{ id: string; status: string; keep_open?: boolean }>).find(
      (c) => c.id === id
    );
    assert.equal(live?.status, "suggested");
    assert.equal(live?.keep_open, true);
  });

  it("accept drafts a spec; review + confirm-gated handoff; no dispatch on accept", async () => {
    const daemon = await tempDaemon();
    fs.writeFileSync(
      path.join(daemon.repoRoot, "data/workspaces.json"),
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
            tags: ["atom"],
            match: ["ATOM", "Desk", "OAuth"],
          },
        ],
      })
    );
    const id = newId("cand");
    daemon.store.append({
      type: "candidate_proposed",
      subject_id: id,
      summary: "Desk 需要 OAuth 本机登录",
      detail: {
        title: "Desk 需要 OAuth 本机登录",
        body: "登录后才能批候选",
        confidence: 0.9,
      },
      refs: [{ token: "yzj:im:g:spec-desk", kind: "im", digest: "oauth" }],
      actor: "test",
    });

    const accepted = await api(daemon, "POST", "/api/approve", { id });
    assert.equal(accepted.status, 200);
    const specId = String(accepted.json.specId);
    assert.match(specId, /^spec_/);
    assert.equal(accepted.json.created, true);

    const again = await api(daemon, "POST", "/api/approve", { id });
    assert.equal(again.json.specId, specId);
    assert.equal(again.json.created, false);

    const listed = await api(daemon, "GET", "/api/specs");
    const specs = listed.json.specs as Array<{
      id: string;
      review_status: string;
      stage_label: string;
      candidate_id: string;
    }>;
    assert.equal(specs.length, 1);
    assert.equal(specs[0]?.id, specId);
    assert.equal(specs[0]?.review_status, "pending");
    assert.equal(specs[0]?.stage_label, "spec 待审");
    const review = listed.json.review as Array<{ id: string }>;
    assert.equal(review.length, 1);

    assert.equal(daemon.store.list({ type: "handoff_exported" }).length, 0);
    assert.equal(daemon.store.list({ type: "agent_started" }).length, 0);

    const blocked = await api(daemon, "POST", "/api/handoff", { id: specId, target: "file" });
    assert.equal(blocked.status, 400);
    assert.equal(blocked.json.code, "not_approved");
    assert.equal(daemon.store.list({ type: "handoff_exported" }).length, 0);

    const returned = await api(daemon, "POST", "/api/spec-return", {
      id: specId,
      title: "Desk OAuth",
      body: "本机登录",
      acceptance_criteria: ["能登录"],
    });
    assert.equal(returned.status, 200);
    const returnedSpec = returned.json.spec as { review_status: string; title: string };
    assert.equal(returnedSpec.review_status, "returned");
    assert.equal(returnedSpec.title, "Desk OAuth");

    const approved = await api(daemon, "POST", "/api/spec-approve", { id: specId });
    assert.equal(approved.status, 200);
    assert.equal((approved.json.spec as { review_status: string }).review_status, "approved");

    const handoff = await api(daemon, "POST", "/api/handoff", { id: specId, target: "file", run: false });
    assert.equal(handoff.status, 200);
    const pack = handoff.json.pack as { id: string; path: string };
    assert.ok(pack.id);
    assert.equal(handoff.json.reused, false);
    assert.equal(handoff.json.ran, false);
    assert.match(String(handoff.json.limitation), /未启动编码/);
    assert.equal(fs.existsSync(pack.path), true);

    const againHandoff = await api(daemon, "POST", "/api/handoff", {
      id: specId,
      target: "file",
      run: true,
    });
    assert.equal(againHandoff.status, 200);
    assert.equal(againHandoff.json.reused, true);
    assert.equal((againHandoff.json.pack as { id: string }).id, pack.id);
    assert.equal(daemon.store.list({ type: "handoff_exported" }).length, 1);

    const after = await api(daemon, "GET", "/api/specs");
    const handed = (after.json.specs as Array<{ review_status: string; stage_label: string }>)[0];
    assert.equal(handed?.review_status, "handed_off");
    assert.equal(handed?.stage_label, "已派 Lead");
    assert.equal((after.json.review as unknown[]).length, 0);
  });

  it("POST /api/reject learns 跟我无关 and leaves a personal sibling", async () => {
    const daemon = await tempDaemon();
    const group = "6a4ce0e0e4b0611af90e3087";
    const release = "明确88环境技能同步到沙箱/预发布/生产的发布流程";
    const id = newId("cand");
    daemon.store.append({
      type: "candidate_proposed",
      subject_id: id,
      summary: release,
      detail: { title: release, body: "mcpApp开发群", confidence: 0.8 },
      refs: [{ token: `yzj-ai-advance:im:${group}:m1`, kind: "im", digest: "release" }],
      actor: "test",
    });
    const personal = newId("cand");
    daemon.store.append({
      type: "candidate_proposed",
      subject_id: personal,
      summary: "单国鑫请你确认88环境技能同步到生产的发布流程",
      detail: {
        title: "单国鑫请你确认88环境技能同步到生产的发布流程",
        body: "需要你拍板",
        confidence: 0.93,
      },
      refs: [{ token: `yzj-ai-advance:im:${group}:m2`, kind: "im", digest: "you" }],
      actor: "test",
    });

    const rejected = await api(daemon, "POST", "/api/reject", { id });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.json.irrelevant, true);

    const memory = await api(daemon, "GET", "/api/preference-memory");
    const scopes = (
      memory.json.memory as { irrelevant: Array<{ source: string; theme: string }> }
    ).irrelevant;
    assert.equal(
      scopes.some((s) => s.source === group && s.theme === "发布与发布流程"),
      true
    );

    const noiseId = newId("cand");
    daemon.store.append({
      type: "candidate_proposed",
      subject_id: noiseId,
      summary: "另一条发布流程说明",
      detail: { title: "另一条技能同步发布流程说明", body: "发布流程", confidence: 0.6 },
      refs: [{ token: `yzj-ai-advance:im:${group}:m3`, kind: "im", digest: "n" }],
      actor: "test",
    });
    const noise = await api(daemon, "POST", "/api/reject", { id: noiseId, reason: "noise-heuristic" });
    assert.equal(noise.status, 200);
    assert.equal(noise.json.irrelevant, false);

    const cands = await api(daemon, "GET", "/api/candidates");
    const list = cands.json.candidates as Array<{ id: string; status: string; reject_reason?: string }>;
    assert.equal(list.find((c) => c.id === id)?.status, "rejected");
    assert.equal(list.find((c) => c.id === id)?.reject_reason, "not_mine");
    assert.equal(list.find((c) => c.id === personal)?.status, "suggested");
  });

  it("POST /api/source-mute diverts the group and unmute clears the preference", async () => {
    const daemon = await tempDaemon();
    const group = "6a4ce0e0e4b0611af90e3087";
    const id = newId("cand");
    daemon.store.append({
      type: "candidate_proposed",
      subject_id: id,
      summary: "群里对一下技能包版本",
      detail: { title: "群里对一下技能包版本", body: "mcpApp开发群", confidence: 0.7 },
      refs: [{ token: `yzj-ai-advance:im:${group}:mute-1`, kind: "im", digest: "mute" }],
      actor: "test",
    });
    const personal = newId("cand");
    daemon.store.append({
      type: "candidate_proposed",
      subject_id: personal,
      summary: "单国鑫请你看一下这个技能包",
      detail: { title: "单国鑫请你看一下这个技能包", body: "需要你确认", confidence: 0.9 },
      refs: [{ token: `yzj-ai-advance:im:${group}:mute-2`, kind: "im", digest: "you" }],
      actor: "test",
    });

    const muted = await api(daemon, "POST", "/api/source-mute", { source: group, label: "mcpApp开发群" });
    assert.equal(muted.status, 200);
    assert.equal(muted.json.ok, true);
    assert.equal(muted.json.diverted, 1);
    const scopes = (
      muted.json.memory as { muted_sources: Array<{ source: string; label: string }> }
    ).muted_sources;
    assert.equal(scopes.some((s) => s.source === group && s.label === "mcpApp开发群"), true);

    const cands = await api(daemon, "GET", "/api/candidates");
    const list = cands.json.candidates as Array<{ id: string; status: string; disposition?: string }>;
    assert.equal(list.find((c) => c.id === id)?.status, "rejected");
    assert.equal(list.find((c) => c.id === id)?.disposition, "muted_source");
    assert.equal(list.find((c) => c.id === personal)?.status, "suggested");

    const cleared = await api(daemon, "POST", "/api/source-unmute", { source: group });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.changed, true);
    const after = (cleared.json.memory as { muted_sources: unknown[] }).muted_sources;
    assert.equal(after.length, 0);
    const still = await api(daemon, "GET", "/api/candidates");
    const stillList = still.json.candidates as Array<{ id: string; status: string }>;
    assert.equal(stillList.find((c) => c.id === id)?.status, "rejected");
  });
});

function storeHasTagged(daemon: Daemon): number {
  return daemon.store.list({ type: "candidate_tagged" }).length;
}
