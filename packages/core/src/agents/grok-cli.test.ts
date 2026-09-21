import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GrokCliExtractAgent } from "./grok-cli.js";
import type { RawMessage } from "../schema/types.js";

const seed: RawMessage = {
  id: "m1",
  source: "yzj",
  groupId: "g1",
  text: "需要支持 Docker 里跑 yzj-cli",
  ts: "2026-09-21T00:00:00.000Z",
};

describe("GrokCliExtractAgent missing binary", () => {
  it("returns [] and does not throw when grok is ENOENT", async () => {
    const agent = new GrokCliExtractAgent({
      bin: "/nonexistent/atom-grok-cli-missing",
      timeoutMs: 5_000,
    });
    const out = await agent.extract([seed]);
    assert.deepEqual(out, []);
  });
});
