import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createDaemon } from "./context.js";
import { runCronTick } from "./scheduler.js";
import type { CronPollConfig } from "@atom/core";

const tmpDirs: string[] = [];
const prevLaya = process.env.LAYA_ENABLED;
const prevCron = process.env.ATOM_CRON;
process.env.LAYA_ENABLED = "0";

after(() => {
  if (prevLaya == null) delete process.env.LAYA_ENABLED;
  else process.env.LAYA_ENABLED = prevLaya;
  if (prevCron == null) delete process.env.ATOM_CRON;
  else process.env.ATOM_CRON = prevCron;
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

const POLL: CronPollConfig = {
  id: "poll-yzj-15m",
  pipeline: "run",
  everyMinutes: 15,
  source: "yzj-ai-advance",
  weekdaysOnly: false,
  hoursLocal: [0, 24],
  tz: "UTC",
  includeRecentDms: false,
  recentDmLimit: 0,
  progressScan: true,
};

describe("cron tick progress-scan wiring", () => {
  it("refreshes the snapshot before executeRun", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-cron-"));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "data/sources.json"),
      JSON.stringify({ version: 1, defaultSourceId: "fixture", sources: [] })
    );
    const daemon = await createDaemon(dir);
    const order: string[] = [];
    let ran = false;
    const status = await runCronTick(daemon, POLL, { value: false }, {
      refreshProgress: async () => {
        order.push("refresh");
        return { via: "in_process", ok: true, failOpen: false, items: 3, available: 2 };
      },
      executeRun: async () => {
        order.push("run");
        ran = true;
        return {
          source: "yzj-ai-advance",
          agent: "heuristic",
          groups: [],
          ingested: 0,
          proposed: 0,
          digestPath: "",
          seeded: 0,
          candidates: [],
        };
      },
    });
    assert.equal(status, "ok");
    assert.equal(ran, true);
    assert.deepEqual(order, ["refresh", "run"]);
  });

  it("still runs poll/extract when progress-scan throws", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-cron-"));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "data/sources.json"),
      JSON.stringify({ version: 1, defaultSourceId: "fixture", sources: [] })
    );
    const daemon = await createDaemon(dir);
    let ran = false;
    const status = await runCronTick(daemon, POLL, { value: false }, {
      refreshProgress: async () => {
        throw new Error("git exploded");
      },
      executeRun: async () => {
        ran = true;
        return {
          source: "yzj-ai-advance",
          agent: "heuristic",
          groups: [],
          ingested: 1,
          proposed: 0,
          digestPath: "",
          seeded: 0,
          candidates: [],
        };
      },
    });
    assert.equal(status, "ok");
    assert.equal(ran, true);
  });

  it("does not refresh on overlap or when progressScan is false", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-cron-"));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "data/sources.json"),
      JSON.stringify({ version: 1, defaultSourceId: "fixture", sources: [] })
    );
    const daemon = await createDaemon(dir);
    let refreshes = 0;
    const overlap = await runCronTick(daemon, POLL, { value: true }, {
      refreshProgress: async () => {
        refreshes += 1;
        return { via: "skipped", ok: true, failOpen: false };
      },
      executeRun: async () => {
        throw new Error("should not run");
      },
    });
    assert.equal(overlap, "overlap");

    const skipped = await runCronTick(
      daemon,
      { ...POLL, progressScan: false },
      { value: false },
      {
        refreshProgress: async () => {
          refreshes += 1;
          return { via: "skipped", ok: true, failOpen: false };
        },
        executeRun: async () => ({
          source: "yzj-ai-advance",
          agent: "heuristic",
          groups: [],
          ingested: 0,
          proposed: 0,
          digestPath: "",
          seeded: 0,
          candidates: [],
        }),
      }
    );
    assert.equal(skipped, "ok");
    assert.equal(refreshes, 0);
  });
});
