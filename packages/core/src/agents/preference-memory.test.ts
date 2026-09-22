import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RSI_MAX_THRESHOLD,
  RSI_MIN_MERGE_THRESHOLD,
  RSI_MIN_THRESHOLD,
  applyPreferenceMemoryPatch,
  defaultPreferenceMemory,
} from "./preference-memory.js";

describe("applyPreferenceMemoryPatch", () => {
  it("clamps noise/outbound to [0.70, 0.95], merge to [0.90, 0.95], and does not move cursor_at", () => {
    const current = {
      ...defaultPreferenceMemory(),
      cursor_at: "2026-09-20T00:00:00.000Z",
      updated_at: "2026-09-20T00:00:00.000Z",
    };
    const { memory, changed } = applyPreferenceMemoryPatch(
      current,
      { thresholds: { noise: 0.1, merge: 0.8, outbound: 2 } },
      new Date("2026-09-21T05:00:00.000Z")
    );
    assert.equal(changed, true);
    assert.equal(memory.thresholds.noise, RSI_MIN_THRESHOLD);
    assert.equal(memory.thresholds.merge, RSI_MIN_MERGE_THRESHOLD);
    assert.equal(memory.thresholds.outbound, RSI_MAX_THRESHOLD);
    assert.equal(memory.cursor_at, current.cursor_at);
    assert.equal(memory.updated_at, "2026-09-21T05:00:00.000Z");
  });

  it("drops blocklist stems shorter than 4 chars and can add/remove", () => {
    const current = {
      ...defaultPreferenceMemory(),
      blocklist: ["午餐闲聊"],
    };
    const short = applyPreferenceMemoryPatch(current, { blocklist_add: ["ab"] });
    assert.equal(short.changed, false);

    const added = applyPreferenceMemoryPatch(current, { blocklist_add: ["收到确认"] });
    assert.equal(added.changed, true);
    assert.deepEqual(added.memory.blocklist, ["午餐闲聊", "收到确认"]);

    const removed = applyPreferenceMemoryPatch(added.memory, { blocklist_remove: ["午餐闲聊"] });
    assert.deepEqual(removed.memory.blocklist, ["收到确认"]);
    assert.deepEqual(removed.memory.allowlist, []);
  });

  it("keeps muted sources and 跟我无关 scopes when floors change", () => {
    const current = {
      ...defaultPreferenceMemory(),
      muted_sources: [{ source: "g1", label: "mcpApp开发群" }],
      irrelevant: [{ source: "g1", theme: "日程/会议", stem: "日历同步" }],
    };
    const { memory, changed } = applyPreferenceMemoryPatch(current, { thresholds: { noise: 0.82 } });
    assert.equal(changed, true);
    assert.deepEqual(memory.muted_sources, current.muted_sources);
    assert.deepEqual(memory.irrelevant, current.irrelevant);
    assert.equal(memory.cursor_at, null);
  });
});
