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
    assert.match(html, /data-page="needs-you"[^>]*class="active">需要你拍板/);
    assert.match(html, /data-page="processed">系统已处理/);
    assert.match(html, /data-page="preferences">我的偏好/);
    assert.match(html, /data-page="advanced">高级/);
    assert.doesNotMatch(html, /<nav[^>]*>[\s\S]*data-page="atoms"/);
    assert.match(html, /id="page-needs-you"[^>]*class="page desk active"/);
    assert.match(js, /队列空着是正常的/);
    assert.match(js, /PAGES = \["needs-you", "processed", "preferences", "advanced"\]/);
    assert.match(js, /showPage\(pageFromHash\(\)\)/);
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

  it("PATCH preference-memory clamps floors and writes the json file", async () => {
    const daemon = await tempDaemon();
    const patched = await api(daemon, "PATCH", "/api/preference-memory", {
      thresholds: { noise: 0.1, outbound: 1.4 },
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
    assert.equal(mem.thresholds.merge, 0.8);
    assert.equal(mem.thresholds.outbound, 0.95);
    assert.deepEqual(mem.blocklist, ["午餐闲聊"]);
    assert.equal(mem.cursor_at, null);
    assert.equal(fs.existsSync(path.join(daemon.repoRoot, "data/preference-memory.json")), true);

    const noop = await api(daemon, "PATCH", "/api/preference-memory", {
      thresholds: { noise: 0.7 },
    });
    assert.equal(noop.json.changed, false);
  });
});
