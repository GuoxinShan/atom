import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TriggerConfig } from "../stubs/webhook-trigger.js";
import {
  cronPollConfigsFromJson,
  cronTickPlan,
  isInScheduleWindow,
  parseCronPollConfig,
  parseRecentPrivateGroupIds,
  scheduleSkipReason,
  unionGroupIds,
  type CronPollConfig,
} from "./cron-schedule.js";

const POLL: CronPollConfig = {
  id: "poll-yzj-15m",
  pipeline: "run",
  everyMinutes: 15,
  source: "yzj-ai-advance",
  weekdaysOnly: true,
  hoursLocal: [8, 20],
  tz: "Asia/Shanghai",
  includeRecentDms: true,
  recentDmLimit: 8,
  progressScan: true,
};

describe("cron schedule window (Asia/Shanghai)", () => {
  it("runs weekdays 08:00 inclusive through 19:59", () => {
    const open = new Date("2026-09-21T00:00:00.000Z"); // Mon 08:00
    const last = new Date("2026-09-21T11:59:00.000Z"); // Mon 19:59
    const noon = new Date("2026-09-21T04:00:00.000Z"); // Mon 12:00
    assert.equal(scheduleSkipReason(open, POLL), null);
    assert.equal(scheduleSkipReason(last, POLL), null);
    assert.equal(isInScheduleWindow(noon, POLL), true);
  });

  it("skips before 08:00 and from 20:00 onward", () => {
    const early = new Date("2026-09-20T23:59:00.000Z"); // Mon 07:59
    const close = new Date("2026-09-21T12:00:00.000Z"); // Mon 20:00
    const night = new Date("2026-09-21T16:00:00.000Z"); // Tue 00:00
    assert.equal(scheduleSkipReason(early, POLL), "hours");
    assert.equal(scheduleSkipReason(close, POLL), "hours");
    assert.equal(isInScheduleWindow(night, POLL), false);
  });

  it("skips Saturday and Sunday even during daytime", () => {
    const sat = new Date("2026-09-19T04:00:00.000Z"); // Sat 12:00
    const sun = new Date("2026-09-20T04:00:00.000Z"); // Sun 12:00
    assert.equal(scheduleSkipReason(sat, POLL), "weekend");
    assert.equal(scheduleSkipReason(sun, POLL), "weekend");
  });

  it("allows weekends when weekdaysOnly is false", () => {
    const sat = new Date("2026-09-19T04:00:00.000Z");
    assert.equal(isInScheduleWindow(sat, { ...POLL, weekdaysOnly: false }), true);
  });
});

describe("cron group union", () => {
  const configured = ["g-ai", "g-meet", "g-note", "g-mcp"];

  it("keeps configured ids and appends unique recent DMs up to the limit", () => {
    const recent = ["dm-1", "g-ai", "dm-2", "dm-3", "dm-4", "dm-5", "dm-6", "dm-7", "dm-8", "dm-9"];
    assert.deepEqual(unionGroupIds(configured, recent, 8), [
      "g-ai",
      "g-meet",
      "g-note",
      "g-mcp",
      "dm-1",
      "dm-2",
      "dm-3",
      "dm-4",
      "dm-5",
      "dm-6",
      "dm-7",
      "dm-8",
    ]);
  });

  it("does not count already-configured ids against the DM cap", () => {
    const recent = ["g-ai", "g-meet", "dm-a", "dm-b"];
    assert.deepEqual(unionGroupIds(configured, recent, 2), [
      ...configured,
      "dm-a",
      "dm-b",
    ]);
  });

  it("parses type:1 private chats from yzj-cli-shaped JSON", () => {
    const payload = {
      data: {
        list: [
          { groupId: "room-group", type: 2, name: "【AI推进】" },
          { groupId: "dm-alice", type: 1, name: "Alice" },
          { id: "dm-bob", type: "1" },
          { groupId: "skip-me", type: 3 },
          { groupId: "dm-alice", type: 1 },
        ],
      },
    };
    assert.deepEqual(parseRecentPrivateGroupIds(payload), ["dm-alice", "dm-bob"]);
    assert.deepEqual(
      parseRecentPrivateGroupIds(JSON.stringify({ list: [{ groupId: "dm-c", type: 1 }] })),
      ["dm-c"]
    );
  });

  it("plans a run with configured ∪ recent DMs and skips overlap / closed window", () => {
    const now = new Date("2026-09-21T04:00:00.000Z"); // Mon 12:00
    const recent = ["dm-1", "g-ai", "dm-2"];
    assert.deepEqual(
      cronTickPlan({
        now,
        config: POLL,
        inFlight: false,
        configuredGroupIds: configured,
        recentPrivateGroupIds: recent,
      }),
      { action: "run", groupIds: [...configured, "dm-1", "dm-2"] }
    );
    assert.deepEqual(
      cronTickPlan({
        now,
        config: POLL,
        inFlight: true,
        configuredGroupIds: configured,
        recentPrivateGroupIds: recent,
      }),
      { action: "skip", reason: "overlap" }
    );
    assert.equal(
      cronTickPlan({
        now: new Date("2026-09-19T04:00:00.000Z"),
        config: POLL,
        inFlight: false,
        configuredGroupIds: configured,
        recentPrivateGroupIds: recent,
      }).action,
      "skip"
    );
  });

  it("omits recent DMs when includeRecentDms is false", () => {
    const now = new Date("2026-09-21T04:00:00.000Z");
    const plan = cronTickPlan({
      now,
      config: { ...POLL, includeRecentDms: false },
      inFlight: false,
      configuredGroupIds: configured,
      recentPrivateGroupIds: ["dm-1"],
    });
    assert.deepEqual(plan, { action: "run", groupIds: configured });
  });
});

describe("cron trigger config", () => {
  it("parses the dogfood 15m poll row and ignores disabled / non-run kinds", () => {
    const row: TriggerConfig = {
      id: "poll-yzj-15m",
      kind: "cron",
      enabled: true,
      pipeline: "run",
      config: {
        everyMinutes: 15,
        source: "yzj-ai-advance",
        weekdaysOnly: true,
        hoursLocal: [8, 20],
        tz: "Asia/Shanghai",
        includeRecentDms: true,
        recentDmLimit: 8,
      },
    };
    const parsed = parseCronPollConfig(row);
    assert.equal(parsed?.everyMinutes, 15);
    assert.equal(parsed?.source, "yzj-ai-advance");
    assert.deepEqual(parsed?.hoursLocal, [8, 20]);
    assert.equal(parsed?.includeRecentDms, true);
    assert.equal(parsed?.progressScan, true);

    const off = parseCronPollConfig({
      ...row,
      id: "cron-no-scan",
      config: { ...row.config, progressScan: false },
    });
    assert.equal(off?.progressScan, false);

    const fromFile = cronPollConfigsFromJson({
      triggers: [
        { id: "manual-run", kind: "manual", enabled: true, pipeline: "run" },
        { id: "webhook-ingest", kind: "webhook", enabled: false, pipeline: "ingest" },
        { id: "cron-off", kind: "cron", enabled: false, pipeline: "run" },
        row,
      ],
    });
    assert.deepEqual(
      fromFile.map((t) => t.id),
      ["poll-yzj-15m"]
    );
  });
});
