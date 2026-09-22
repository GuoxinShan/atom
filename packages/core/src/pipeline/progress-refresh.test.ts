import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { writeProgressSnapshot, type ProgressSnapshot } from "./progress-snapshot.js";
import {
  progressRefreshPlan,
  progressScanDisabled,
  refreshProgressSnapshot,
  readProgressScanAck,
  readProgressScanRequest,
  writeProgressScanAck,
  writeProgressScanRequest,
} from "./progress-refresh.js";
import { fulfillProgressScanRequest } from "./progress-scan-host.js";

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

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-refresh-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "data/workspaces.json"),
    JSON.stringify({
      version: 1,
      defaultMachine: "test",
      machines: {},
      workspaces: [
        { id: "atom", machine: "test", path: path.join(dir, "repos", "atom"), kind: "personal" },
        { id: "yzj", machine: "test", path: path.join(dir, "missing-yzj"), kind: "work" },
        { id: "ai-advance", machine: "test", path: path.join(dir, "missing-ai"), kind: "work" },
      ],
    })
  );
  return dir;
}

function staleSnapshot(): ProgressSnapshot {
  return {
    version: 1,
    generated_at: "2026-09-01T00:00:00.000Z",
    source: "progress-scan",
    since_days: 90,
    workspaces: [
      {
        id: "atom",
        path: "/atom",
        available: true,
        fail_open: false,
        items: [{ kind: "commit", title: "kept prior", workspace_id: "atom", sha: "abc" }],
      },
    ],
  };
}

describe("progress refresh plan", () => {
  it("scans in-process when git is visible, otherwise uses the host hook / request file", () => {
    assert.equal(progressRefreshPlan({ disabled: true, gitVisible: true }), "skip");
    assert.equal(progressRefreshPlan({ gitVisible: true }), "in_process");
    assert.equal(
      progressRefreshPlan({ gitVisible: false, hookUrl: "http://127.0.0.1:8788/progress-scan" }),
      "host_hook"
    );
    assert.equal(progressRefreshPlan({ gitVisible: false, hookCommand: "pnpm atom progress-scan" }), "host_hook");
    assert.equal(progressRefreshPlan({ gitVisible: false }), "request_file");
  });

  it("treats ATOM_PROGRESS_SCAN=0 as disabled", () => {
    assert.equal(progressScanDisabled({ ATOM_PROGRESS_SCAN: "0" } as NodeJS.ProcessEnv), true);
    assert.equal(progressScanDisabled({ ATOM_PROGRESS_SCAN: "false" } as NodeJS.ProcessEnv), true);
    assert.equal(progressScanDisabled({ ATOM_PROGRESS_SCAN: "" } as NodeJS.ProcessEnv), false);
  });
});

describe("progress refresh fail-open", () => {
  it("runs in-process scan when git is visible", async () => {
    const root = tempRoot();
    const result = await refreshProgressSnapshot(root, {
      gitVisible: true,
      scan: async () => {
        const snap = writeProgressSnapshot(root, {
          ...staleSnapshot(),
          generated_at: "2026-09-22T02:00:00.000Z",
        });
        return {
          path: snap,
          snapshot: staleSnapshot(),
          available: 3,
          failOpen: 0,
          items: 9,
        };
      },
    });
    assert.equal(result.via, "in_process");
    assert.equal(result.ok, true);
    assert.equal(result.items, 9);
    assert.equal(result.available, 3);
    assert.equal(fs.existsSync(path.join(root, "data/progress-scan.request.json")), false);
  });
  it("keeps the last snapshot when in-process scan throws", async () => {
    const root = tempRoot();
    writeProgressSnapshot(root, staleSnapshot());
    const result = await refreshProgressSnapshot(root, {
      gitVisible: true,
      scan: async () => {
        throw new Error("gh unavailable");
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.failOpen, true);
    assert.equal(result.via, "in_process");
    assert.match(result.error ?? "", /gh unavailable/);
    const kept = JSON.parse(fs.readFileSync(path.join(root, "data/progress-snapshot.json"), "utf8"));
    assert.equal(kept.workspaces[0].items[0].title, "kept prior");
  });

  it("writes a request file and waits for the host helper ack (Docker path)", async () => {
    const root = tempRoot();
    writeProgressSnapshot(root, staleSnapshot());
    const pending = refreshProgressSnapshot(root, {
      gitVisible: false,
      waitMs: 2_000,
      pollMs: 20,
      source: "cron:poll-yzj-15m",
    });
    await new Promise((r) => setTimeout(r, 40));
    const req = readProgressScanRequest(root);
    assert.ok(req);
    assert.equal(req?.source, "cron:poll-yzj-15m");
    writeProgressSnapshot(root, {
      ...staleSnapshot(),
      generated_at: "2026-09-22T00:00:00.000Z",
      workspaces: [
        {
          id: "atom",
          path: "/atom",
          available: true,
          fail_open: false,
          items: [{ kind: "pr", title: "fresh from host", workspace_id: "atom", number: 1 }],
        },
      ],
    });
    writeProgressScanAck(root, {
      id: req!.id,
      scanned_at: "2026-09-22T00:00:00.000Z",
      ok: true,
      items: 1,
      available: 1,
      path: path.join(root, "data/progress-snapshot.json"),
    });
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.failOpen, false);
    assert.equal(result.via, "request_file");
    assert.equal(result.items, 1);
  });

  it("logs fail-open and keeps last snapshot when the host helper never acks", async () => {
    const root = tempRoot();
    writeProgressSnapshot(root, staleSnapshot());
    const result = await refreshProgressSnapshot(root, {
      gitVisible: false,
      waitMs: 40,
      pollMs: 10,
      sleep: async () => undefined,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failOpen, true);
    assert.equal(result.via, "request_file");
    assert.match(result.error ?? "", /host progress-scan helper/);
    const kept = JSON.parse(fs.readFileSync(path.join(root, "data/progress-snapshot.json"), "utf8"));
    assert.equal(kept.generated_at, "2026-09-01T00:00:00.000Z");
    assert.ok(readProgressScanRequest(root)?.id);
  });

  it("POSTs the host hook URL when git is not visible", async () => {
    const root = tempRoot();
    writeProgressSnapshot(root, staleSnapshot());
    let hit = "";
    const result = await refreshProgressSnapshot(root, {
      gitVisible: false,
      hookUrl: "http://127.0.0.1:8788/progress-scan",
      fetchHook: async (url) => {
        hit = url;
        writeProgressSnapshot(root, {
          ...staleSnapshot(),
          generated_at: "2026-09-22T01:00:00.000Z",
        });
        return { ok: true, status: 200, body: "{}" };
      },
    });
    assert.equal(hit, "http://127.0.0.1:8788/progress-scan");
    assert.equal(result.ok, true);
    assert.equal(result.via, "host_hook");
  });

  it("falls back to the request file when the hook HTTP fails", async () => {
    const root = tempRoot();
    writeProgressSnapshot(root, staleSnapshot());
    const result = await refreshProgressSnapshot(root, {
      gitVisible: false,
      hookUrl: "http://127.0.0.1:9/progress-scan",
      fetchHook: async () => {
        throw new Error("ECONNREFUSED");
      },
      waitMs: 30,
      pollMs: 5,
      sleep: async () => undefined,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failOpen, true);
    assert.equal(result.via, "host_hook");
    assert.ok(readProgressScanRequest(root));
  });
});

describe("host helper fulfill", () => {
  it("scans and writes ack matching the request id", async () => {
    const root = tempRoot();
    const req = writeProgressScanRequest(root, "test", new Date("2026-09-22T00:00:00Z"));
    const ack = await fulfillProgressScanRequest(root, {
      request: req,
      now: new Date("2026-09-22T00:00:01Z"),
      scan: async () => {
        const snap = writeProgressSnapshot(root, {
          ...staleSnapshot(),
          generated_at: "2026-09-22T00:00:01.000Z",
        });
        return {
          path: snap,
          snapshot: staleSnapshot(),
          available: 1,
          failOpen: 0,
          items: 4,
        };
      },
    });
    assert.equal(ack.ok, true);
    assert.equal(ack.id, req.id);
    assert.equal(ack.items, 4);
    assert.equal(readProgressScanAck(root)?.id, req.id);
  });

  it("acks failure without throwing so Desk can keep the last snapshot", async () => {
    const root = tempRoot();
    writeProgressSnapshot(root, staleSnapshot());
    const req = writeProgressScanRequest(root, "test");
    const ack = await fulfillProgressScanRequest(root, {
      request: req,
      scan: async () => {
        throw new Error("spawn git ENOENT");
      },
    });
    assert.equal(ack.ok, false);
    assert.match(ack.error ?? "", /ENOENT/);
    const kept = JSON.parse(fs.readFileSync(path.join(root, "data/progress-snapshot.json"), "utf8"));
    assert.equal(kept.workspaces[0].items[0].title, "kept prior");
  });
});
