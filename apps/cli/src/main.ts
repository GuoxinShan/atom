#!/usr/bin/env node
import {
  runPipeline,
  ingestFromSource,
  runExtract,
  writeDigest,
  candidatesByStatus,
  approveCandidate,
  rejectCandidate,
  rejectNoiseCandidates,
  exportHandoff,
  attachEvidence,
  listSpecDrafts,
  LeadAgent,
  findSpec,
  runColdStart,
  ensureColdStartFiles,
  leadApplyConfig,
  AgentProviderRegistry,
  resolveCodingAgent,
  startChecklist,
  completeChecklistItem,
  formatChecklist,
  openPr,
} from "@atom/core";
import { createAppContext, resolveAgent } from "./context.js";

function usage(): never {
  console.log(`ATOM CLI

Usage:
  pnpm atom run [--source <id>] [--agent heuristic|grok-cli]
  pnpm atom ingest [--source <id>]
  pnpm atom extract [--agent grok-cli]
  pnpm atom digest
  pnpm atom candidates [--status suggested|accepted|rejected|merged]
  pnpm atom approve <candidateId> [--note ...]
  pnpm atom reject <candidateId> [--reason ...]
  pnpm atom specs
  pnpm atom handoff <specOrCandidateId> [--run] [--target grok-cli|file]
  pnpm atom evidence <handoffId> --path <file>
  pnpm atom checklist <handoffOrCandidateId>
  pnpm atom checklist-done <handoffOrCandidateId> <itemKey> [--note ...] [--ack]
  pnpm atom pr-open <handoffOrCandidateId> --url <prUrl> [--branch ...] [--force]
  pnpm atom reject-noise
  pnpm atom route <specOrCandidateId>
  pnpm atom doctor
  pnpm atom setup
  pnpm atom sources
  pnpm atom lead "<自然语言改配置>"
  pnpm atom agents

Default run = yzj (scoped groups) + heuristic seed-gate + grok-cli agentic extract
`);
  process.exit(1);
}

function groupAllowlistFor(
  ctx: Awaited<ReturnType<typeof createAppContext>>,
  sourceId?: string
): string[] {
  const cfg = ctx.registry.loadConfig();
  const id = sourceId ?? cfg.defaultSourceId;
  const entry = cfg.sources.find((s) => s.id === id);
  const fromEnv = (process.env.ATOM_YZJ_GROUP_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv.length) return fromEnv;
  return entry?.groupIds ?? [];
}

async function main() {

  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "run";
  const flags = parseFlags(argv.slice(1));

  const ctx = await createAppContext();
  const sourceId = flags.source as string | undefined;
  const agentName =
    (flags.agent as string | undefined) ?? ctx.registry.defaultExtractAgent();

  if (cmd === "run") {
    const source = ctx.registry.resolve(sourceId);
    const agent = resolveAgent(agentName, ctx.repoRoot);
    const allow = groupAllowlistFor(ctx, sourceId ?? source.id);
    const result = await runPipeline({
      store: ctx.store,
      source,
      agent,
      repoRoot: ctx.repoRoot,
      trigger: ctx.trigger,
      sink: ctx.sink,
      groupAllowlist: allow,
      heuristicGate: true,
    });
    console.log(
      `OK run source=${source.id} agent=${agent.id} ingested=${result.ingested} seeds=${result.seeded} proposed=${result.proposed}`
    );
    console.log(`groups: ${allow.join(",") || "(all ingested)"}`);
    console.log(`digest: ${result.digestPath}`);
    printCandidates(ctx.store, "suggested");
    return;
  }

  if (cmd === "ingest") {
    const source = ctx.registry.resolve(sourceId);
    const { ingested, nextCursor } = await ingestFromSource(ctx.store, source);
    console.log(`OK ingest source=${source.id} ingested=${ingested} cursor=${nextCursor}`);
    return;
  }

  if (cmd === "extract") {
    const agent = resolveAgent(agentName, ctx.repoRoot);
    const allow = groupAllowlistFor(ctx, sourceId);
    const { proposed, skipped, seeded, gated, noiseDropped } = await runExtract(ctx.store, agent, {
      heuristicGate: true,
      groupAllowlist: allow,
    });
    console.log(
      `OK extract agent=${agent.id} seeds=${seeded} gated_out=${gated} proposed=${proposed} skipped=${skipped} noise_dropped=${noiseDropped}`
    );
    return;
  }

  if (cmd === "digest") {
    const p = writeDigest(ctx.store, ctx.repoRoot);
    console.log(`OK digest ${p}`);
    return;
  }

  if (cmd === "candidates") {
    const status = flags.status as
      | "suggested"
      | "accepted"
      | "rejected"
      | "merged"
      | undefined;
    printCandidates(ctx.store, status);
    return;
  }

  if (cmd === "approve") {
    const id = positional(argv.slice(1));
    if (!id) usage();
    const { specId } = approveCandidate(ctx.store, id, flags.note as string | undefined);
    console.log(`OK approved ${id}`);
    console.log(`spec drafted: ${specId} (atom type spec_drafted)`);
    return;
  }

  if (cmd === "reject") {
    const id = positional(argv.slice(1));
    if (!id) usage();
    rejectCandidate(ctx.store, id, flags.reason as string | undefined);
    console.log(`OK rejected ${id}`);
    return;
  }

  if (cmd === "reject-noise") {
    const { rejected, ids, titles } = rejectNoiseCandidates(ctx.store);
    if (!rejected) {
      console.log("OK reject-noise: nothing matched");
      return;
    }
    console.log(`OK reject-noise rejected=${rejected} reason=noise-heuristic`);
    for (let i = 0; i < ids.length; i++) {
      console.log(`- ${ids[i]}  ${titles[i]}`);
    }
    return;
  }

  if (cmd === "specs") {
    const specs = listSpecDrafts(ctx.store);
    if (!specs.length) {
      console.log("(no specs)");
      return;
    }
    for (const s of specs) {
      console.log(`- ${s.id} ← ${s.candidate_id}`);
      console.log(`  ${s.title}`);
    }
    return;
  }

  if (cmd === "handoff") {
    const id = positional(argv.slice(1));
    if (!id) usage();
    const target = (flags.target as string | undefined) ?? "grok-cli";
    const run = Boolean(flags.run);
    const coding =
      target === "file" ? undefined : resolveCodingAgent(ctx.repoRoot);
    const pack = await exportHandoff(ctx.store, ctx.repoRoot, id, coding, {
      run,
      target: target === "file" ? "file" : "grok-cli",
    });
    console.log(`OK handoff ${pack.id}`);
    console.log(`path: ${pack.path}`);
    console.log(`target: ${pack.target} run=${run}`);
    return;
  }

  if (cmd === "agents") {
    const reg = new AgentProviderRegistry(ctx.repoRoot);
    const cfg = reg.load();
    console.log("defaults:", JSON.stringify(cfg.defaults));
    for (const p of cfg.providers) {
      const star = cfg.defaults[p.role] === p.id ? "*" : " ";
      console.log(
        `${star} ${p.id} role=${p.role} kind=${p.kind} on=${p.enabled !== false} url=${p.url || "-"}`
      );
    }
    return;
  }

  if (cmd === "doctor") {
    const report = runColdStart(ctx.repoRoot);
    for (const c of report.checks) {
      const mark = c.status === "ok" ? "OK" : c.status === "warn" ? "!!" : "XX";
      console.log(`[${mark}] ${c.title}: ${c.detail}`);
      if (c.fix && c.status !== "ok") console.log(`     fix: ${c.fix}`);
    }
    console.log(report.ready ? "cold-start: READY" : "cold-start: NOT READY");
    process.exit(report.ready ? 0 : 1);
  }

  if (cmd === "setup") {
    const created = ensureColdStartFiles(ctx.repoRoot);
    console.log(created.length ? `created: ${created.join(", ")}` : "templates already present");
    const report = runColdStart(ctx.repoRoot);
    console.log(report.ready ? "cold-start: READY" : "cold-start: still has gaps — run pnpm atom doctor");
    return;
  }

  if (cmd === "sources") {
    const cfg = ctx.registry.loadConfig();
    for (const s of cfg.sources) {
      console.log(
        `- ${s.id} kind=${s.kind} enabled=${s.enabled !== false} groups=${(s.groupIds ?? []).join(",") || "-"}`
      );
    }
    console.log(`defaultSource=${cfg.defaultSourceId} extract=${cfg.defaultExtractAgent}`);
    return;
  }

  if (cmd === "lead") {
    const utterance = argv.slice(1).join(" ").replace(/^--\s*/, "").trim();
    // allow: atom lead 打开AI推进  OR atom lead -- 打开...
    const text = utterance.replace(/^--\s*/, "") || positional(argv.slice(1)) || "";
    // gather all non-flag args as utterance
    const words = argv.slice(1).filter((a) => !a.startsWith("--") || a === "--");
    const u = words.filter((w) => w !== "--").join(" ").trim();
    if (!u) {
      console.log('Usage: pnpm atom lead "打开 AI推进 群"');
      process.exit(1);
    }
    const result = leadApplyConfig(ctx.repoRoot, u);
    console.log(result.ok ? `OK ${result.message}` : `NO ${result.message}`);
    if (result.changed?.length) console.log(`changed: ${result.changed.join(", ")}`);
    process.exit(result.ok ? 0 : 1);
  }

  if (cmd === "route") {
    const id = positional(argv.slice(1));
    if (!id) usage();
    const lead = new LeadAgent(ctx.repoRoot);
    const spec = findSpec(ctx.store, id);
    const route = lead.routeSpec(spec);
    console.log(`workspace: ${route.workspace.id}`);
    console.log(`machine:   ${route.machine}`);
    console.log(`path:      ${route.workspace.path}`);
    console.log(`confidence:${route.confidence}`);
    console.log(`reason:    ${route.reason}`);
    return;
  }

  if (cmd === "evidence") {
    const id = positional(argv.slice(1));
    const pathFlag = flags.path as string | undefined;
    if (!id || !pathFlag) usage();
    const eid = attachEvidence(ctx.store, id, pathFlag);
    console.log(`OK evidence ${eid} for handoff ${id}`);
    return;
  }

  if (cmd === "checklist") {
    const id = positional(argv.slice(1));
    if (!id) usage();
    const view = startChecklist(ctx.store, id);
    console.log(formatChecklist(view));
    return;
  }

  if (cmd === "checklist-done") {
    const [id, itemKey] = positionals(argv.slice(1));
    if (!id || !itemKey) usage();
    const view = completeChecklistItem(ctx.store, id, itemKey, {
      note: flags.note as string | undefined,
      ack: Boolean(flags.ack),
    });
    console.log(`OK checklist-done ${itemKey}`);
    console.log(formatChecklist(view));
    return;
  }

  if (cmd === "pr-open") {
    const id = positional(argv.slice(1));
    const url = flags.url as string | undefined;
    if (!id || !url) usage();
    const { prId, forced } = openPr(ctx.store, id, {
      url,
      branch: flags.branch as string | undefined,
      force: Boolean(flags.force),
    });
    console.log(`OK pr-open ${prId}${forced ? " (forced)" : ""}`);
    console.log(`url: ${url}`);
    return;
  }

  usage();
}

function printCandidates(
  store: import("@atom/core").EventStore,
  status?: "suggested" | "accepted" | "rejected" | "merged"
) {
  const list = candidatesByStatus(store, status);
  if (list.length === 0) {
    console.log("(no candidates)");
    return;
  }
  for (const c of list) {
    console.log(`- [${c.status}] ${c.id}`);
    console.log(`  ${c.title}`);
    console.log(`  confidence=${c.confidence}`);
    for (const r of c.refs) {
      console.log(`  ref: ${r.token}${r.digest ? ` | ${r.digest}` : ""}`);
    }
  }
}

function parseFlags(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const next = args[i + 1];
      if (next && !next.startsWith("--")) i += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}

function positional(args: string[]): string | undefined {
  return positionals(args)[0];
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
