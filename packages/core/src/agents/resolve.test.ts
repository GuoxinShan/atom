import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { resolveExtractAgent } from "./resolve.js";

const prev = process.env.ATOM_EXTRACT_AGENT;

afterEach(() => {
  if (prev == null) delete process.env.ATOM_EXTRACT_AGENT;
  else process.env.ATOM_EXTRACT_AGENT = prev;
});

describe("resolveExtractAgent ATOM_EXTRACT_AGENT", () => {
  it("heuristic skips grok and proposes nothing", async () => {
    process.env.ATOM_EXTRACT_AGENT = "heuristic";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-resolve-"));
    const agent = resolveExtractAgent(dir);
    assert.equal(agent.id, "heuristic");
    const out = await agent.extract([
      {
        id: "m1",
        source: "yzj",
        text: "需要一个功能",
        ts: "2026-09-21T00:00:00.000Z",
      },
    ]);
    assert.deepEqual(out, []);
  });
});
