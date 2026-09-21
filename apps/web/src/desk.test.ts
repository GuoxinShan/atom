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
    assert.match(css, /needs-group\.is-other/);
    assert.match(css, /empty-desk/);
    assert.doesNotMatch(css, /#6e7bf2/);
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
});

function storeHasTagged(daemon: Daemon): number {
  return daemon.store.list({ type: "candidate_tagged" }).length;
}
