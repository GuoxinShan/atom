/**
 * Unit-ish fixture check for Lead haystack routing (no test harness in-repo).
 * Usage: pnpm check:lead-routing
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LeadAgent, type SpecDraft } from "@atom/core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(repoRoot, "fixtures", "lead-routing.json");

type Case = {
  id: string;
  expectWorkspace: string;
  note?: string;
  spec: SpecDraft;
};

const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as { cases: Case[] };
const lead = new LeadAgent(repoRoot);
let failed = 0;

for (const c of fixture.cases) {
  const route = lead.routeSpec(c.spec);
  const ok = route.workspace.id === c.expectWorkspace;
  const mark = ok ? "OK  " : "FAIL";
  console.log(
    `${mark} ${c.id}: got ${route.workspace.id} (expect ${c.expectWorkspace}) — ${route.reason}`
  );
  if (!ok) failed += 1;
}

if (failed) {
  console.error(`\n${failed} lead-routing fixture(s) failed`);
  process.exit(1);
}
console.log(`\n${fixture.cases.length} lead-routing fixture(s) passed`);
