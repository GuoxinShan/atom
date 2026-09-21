#!/usr/bin/env node
/**
 * Thin HTTP client for the ATOM desk daemon.
 * Side effects live in the local API (`pnpm atom serve`); this file only fetch()s.
 */
import fs from "node:fs";
import { api, apiOk, ApiDownError, apiBase, runServe } from "./client.js";

function usage(): never {
  console.log(`ATOM CLI

Usage:
  pnpm atom serve            # start Desk + API (keep this running)
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
  pnpm atom checklist-ack <handoffOrCandidateId>
  pnpm atom pr-open <handoffOrCandidateId> --url <prUrl> [--branch ...] [--force]
  pnpm atom reject-noise
  pnpm atom merge-sweep [--apply]
  pnpm atom tag-backfill [--apply]
  pnpm atom outbound-check [--title ...] [--body ... | --path <file>] [--kind digest]
  pnpm atom preference-rsi [--dry-run | --apply]
  pnpm atom gate-digest [--since 24h|7d|YYYY-MM-DD|ISO] [--json]
  pnpm atom route <specOrCandidateId>
  pnpm atom doctor
  pnpm atom setup
  pnpm atom sources
  pnpm atom subscriptions
  pnpm atom triggers
  pnpm atom workspaces
  pnpm atom lead "<自然语言改配置>"
  pnpm atom agents

Talks to ${apiBase()} (ATOM_API_BASE). No in-process core.
`);
  process.exit(1);
}

type Flags = Record<string, string | boolean>;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "run";
  const flags = parseFlags(argv.slice(1));

  if (cmd === "help" || cmd === "-h" || cmd === "--help") usage();

  if (cmd === "serve" || cmd === "web") {
    await runServe();
    return;
  }

  const groupIds = cliGroupIds();
  const sourceId = flags.source as string | undefined;
  const agentName = flags.agent as string | undefined;

  if (cmd === "run") {
    const data = await apiOk<{
      source: string;
      agent: string;
      ingested: number;
      seeded: number;
      proposed: number;
      digestPath: string;
      groups: string[];
      candidates: Candidate[];
    }>("POST", "/api/run", {
      source: sourceId,
      agent: agentName,
      groupIds,
    });
    console.log(
      `OK run source=${data.source} agent=${data.agent} ingested=${data.ingested} seeds=${data.seeded} proposed=${data.proposed}`
    );
    console.log(`groups: ${(data.groups ?? []).join(",") || "(all ingested)"}`);
    console.log(`digest: ${data.digestPath}`);
    printCandidates(data.candidates ?? []);
    return;
  }

  if (cmd === "ingest") {
    const data = await apiOk<{ source: string; ingested: number; nextCursor: string }>(
      "POST",
      "/api/ingest",
      { source: sourceId }
    );
    console.log(`OK ingest source=${data.source} ingested=${data.ingested} cursor=${data.nextCursor}`);
    return;
  }

  if (cmd === "extract") {
    const data = await apiOk<{
      agent: string;
      seeded: number;
      gated: number;
      proposed: number;
      skipped: number;
      noiseDropped: number;
    }>("POST", "/api/extract", { source: sourceId, agent: agentName, groupIds });
    console.log(
      `OK extract agent=${data.agent} seeds=${data.seeded} gated_out=${data.gated} proposed=${data.proposed} skipped=${data.skipped} noise_dropped=${data.noiseDropped}`
    );
    return;
  }

  if (cmd === "digest") {
    const data = await apiOk<{ digestPath: string }>("POST", "/api/digest");
    console.log(`OK digest ${data.digestPath}`);
    return;
  }

  if (cmd === "candidates") {
    const status = flags.status as string | undefined;
    const q = status ? `?status=${encodeURIComponent(status)}` : "";
    const data = await apiOk<{ candidates: Candidate[] }>("GET", `/api/candidates${q}`);
    printCandidates(data.candidates ?? []);
    return;
  }

  if (cmd === "approve") {
    const id = positional(argv.slice(1));
    if (!id) usage();
    const data = await apiOk<{ specId: string }>("POST", "/api/approve", {
      id,
      note: flags.note,
    });
    console.log(`OK approved ${id}`);
    console.log(`spec drafted: ${data.specId} (atom type spec_drafted)`);
    return;
  }

  if (cmd === "reject") {
    const id = positional(argv.slice(1));
    if (!id) usage();
    await apiOk("POST", "/api/reject", { id, reason: flags.reason });
    console.log(`OK rejected ${id}`);
    return;
  }

  if (cmd === "reject-noise") {
    const data = await apiOk<{ rejected: number; ids: string[]; titles: string[] }>(
      "POST",
      "/api/reject-noise"
    );
    if (!data.rejected) {
      console.log("OK reject-noise: nothing matched");
      return;
    }
    console.log(`OK reject-noise rejected=${data.rejected} reason=noise-heuristic`);
    for (let i = 0; i < (data.ids ?? []).length; i++) {
      console.log(`- ${data.ids[i]}  ${data.titles[i]}`);
    }
    return;
  }

  if (cmd === "merge-sweep") {
    const apply = Boolean(flags.apply);
    const data = await apiOk<{
      apply: boolean;
      considered: number;
      compared: number;
      merged: number;
      skipped: number;
      failOpen: boolean;
      layaAvailable: boolean;
      reason?: string;
      pairs: Array<{
        loserId: string;
        loserTitle: string;
        survivorId: string;
        survivorTitle: string;
        sameRequest?: number;
        confidence?: number;
        reason: string;
      }>;
    }>("POST", "/api/merge-sweep", { apply });
    printMergeSweep(data);
    return;
  }

  if (cmd === "tag-backfill" || cmd === "tags-backfill") {
    const apply = Boolean(flags.apply);
    const data = await apiOk<{
      apply: boolean;
      considered: number;
      tagged: number;
      skipped: number;
      failOpen: boolean;
      layaAvailable: boolean;
      reason?: string;
      items: Array<{
        id: string;
        title: string;
        theme?: string;
        project?: string;
        via: string;
        reason: string;
      }>;
    }>("POST", "/api/tag-backfill", { apply });
    printTagBackfill(data);
    return;
  }

  if (cmd === "outbound-check") {
    const pathFlag = flags.path as string | undefined;
    let title = (flags.title as string | undefined) ?? "";
    let bodyText = (flags.body as string | undefined) ?? (flags.text as string | undefined) ?? "";
    const kind = (flags.kind as string | undefined) ?? (pathFlag ? "digest" : "outbound");
    if (pathFlag) {
      if (!fs.existsSync(pathFlag)) {
        console.error(`outbound-check: file not found: ${pathFlag}`);
        process.exit(1);
      }
      bodyText = fs.readFileSync(pathFlag, "utf8");
      if (!title) title = pathFlag.split(/[/\\]/).at(-1) ?? pathFlag;
    }
    if (!title && !bodyText) {
      console.log(
        'Usage: pnpm atom outbound-check --title "…" --body "…"\n       pnpm atom outbound-check --path out/digest-YYYY-MM-DD.md --kind digest'
      );
      process.exit(1);
    }
    const data = await apiOk<{
      action: string;
      fail_open: boolean;
      reason: string;
      confidence: number | null;
      laya_available: boolean;
      delivered: boolean;
      event_id: string | null;
      kind: string;
      laya_outbound: {
        action: string;
        fail_open: boolean;
        reason: string;
        demand_noul: number | null;
        noise_noul: number | null;
      };
    }>("POST", "/api/outbound-check", { title, body: bodyText, kind });
    printOutboundCheck(data);
    return;
  }

  if (cmd === "preference-rsi" || cmd === "rsi") {
    const dryRun = Boolean(flags["dry-run"] || flags.dryRun);
    const apply = Boolean(flags.apply) && !dryRun;
    const data = await apiOk<{
      apply: boolean;
      changed: boolean;
      reason: string;
      path: string | null;
      eventId: string | null;
      samples: {
        accepted: number;
        rejected: number;
        merged: number;
        suggested: number;
        noise_rejects: number;
        fail_open_accepted: number;
        merge_fail_open_merged: number;
      };
      before: { noise: number; merge: number; outbound: number };
      after: { noise: number; merge: number; outbound: number };
      deltas: { noise: number; merge: number; outbound: number };
      added_allowlist: string[];
      added_blocklist: string[];
    }>("POST", "/api/preference-rsi", { apply, dryRun });
    printPreferenceRsi(data);
    return;
  }

  if (cmd === "gate-digest" || cmd === "gate-acceptance") {
    const since = (flags.since as string | undefined) ?? undefined;
    const asJson = Boolean(flags.json);
    const q = new URLSearchParams();
    if (since) q.set("since", since);
    const path = q.toString() ? `/api/gate-digest?${q.toString()}` : "/api/gate-digest";
    const data = await apiOk<{
      markdown: string;
      since: string;
      until: string;
      extract: Record<string, unknown>;
      merge: Record<string, unknown>;
      outbound: Record<string, unknown>;
      desk: Record<string, unknown>;
      preference: Record<string, unknown>;
      proxies: Record<string, unknown>;
    }>("GET", path);
    if (asJson) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(data.markdown.replace(/\n$/, ""));
    }
    return;
  }

  if (cmd === "specs") {
    const data = await apiOk<{ specs: Array<{ id: string; candidate_id: string; title: string }> }>(
      "GET",
      "/api/specs"
    );
    const specs = data.specs ?? [];
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
    const data = await apiOk<{ pack: { id: string; path: string; target: string } }>(
      "POST",
      "/api/handoff",
      { id, run, target }
    );
    const pack = data.pack;
    console.log(`OK handoff ${pack.id}`);
    console.log(`path: ${pack.path}`);
    console.log(`target: ${pack.target} run=${run}`);
    return;
  }

  if (cmd === "agents") {
    const cfg = await apiOk<{
      defaults: Record<string, string>;
      providers: Array<{
        id: string;
        role: string;
        kind: string;
        enabled?: boolean;
        url?: string;
      }>;
    }>("GET", "/api/agents");
    console.log("defaults:", JSON.stringify(cfg.defaults));
    for (const p of cfg.providers ?? []) {
      const star = cfg.defaults?.[p.role] === p.id ? "*" : " ";
      console.log(
        `${star} ${p.id} role=${p.role} kind=${p.kind} on=${p.enabled !== false} url=${p.url || "-"}`
      );
    }
    return;
  }

  if (cmd === "doctor") {
    const report = await apiOk<{
      ready: boolean;
      checks: Array<{ status: string; title: string; detail: string; fix?: string }>;
    }>("GET", "/api/doctor");
    printDoctor(report);
    process.exit(report.ready ? 0 : 1);
  }

  if (cmd === "setup") {
    const data = await apiOk<{
      created: string[];
      report: { ready: boolean };
    }>("POST", "/api/setup");
    console.log(
      data.created?.length ? `created: ${data.created.join(", ")}` : "templates already present"
    );
    console.log(
      data.report?.ready
        ? "cold-start: READY"
        : "cold-start: still has gaps — run pnpm atom doctor"
    );
    return;
  }

  if (cmd === "sources") {
    const cfg = await apiOk<{
      sources: Array<{
        id: string;
        kind: string;
        enabled?: boolean;
        groupIds?: string[];
      }>;
      defaultSourceId?: string;
      defaultExtractAgent?: string;
    }>("GET", "/api/sources");
    for (const s of cfg.sources ?? []) {
      console.log(
        `- ${s.id} kind=${s.kind} enabled=${s.enabled !== false} groups=${(s.groupIds ?? []).join(",") || "-"}`
      );
    }
    console.log(`defaultSource=${cfg.defaultSourceId} extract=${cfg.defaultExtractAgent}`);
    return;
  }

  if (cmd === "subscriptions") {
    const data = await apiOk<{ subscriptions: Array<Record<string, unknown>> }>(
      "GET",
      "/api/subscriptions"
    );
    const list = data.subscriptions ?? [];
    if (!list.length) {
      console.log("(no subscriptions)");
      return;
    }
    for (const s of list) {
      const id = String(s.id ?? "");
      const kind = String(s.kind ?? "webhook");
      const url = String(s.url || s.bin || s.path || "-");
      console.log(`- ${id} kind=${kind} enabled=${s.enabled !== false} url=${url}`);
    }
    return;
  }

  if (cmd === "triggers") {
    const data = await apiOk<{ triggers: Array<Record<string, unknown>> }>("GET", "/api/triggers");
    const list = data.triggers ?? [];
    if (!list.length) {
      console.log("(no triggers)");
      return;
    }
    for (const t of list) {
      console.log(
        `- ${String(t.id ?? "")} kind=${String(t.kind ?? "-")} enabled=${t.enabled !== false} pipeline=${String(t.pipeline || "-")}`
      );
    }
    return;
  }

  if (cmd === "workspaces") {
    const data = await apiOk<{ workspaces: Array<Record<string, unknown>> }>(
      "GET",
      "/api/workspaces"
    );
    const list = data.workspaces ?? [];
    if (!list.length) {
      console.log("(no workspaces)");
      return;
    }
    for (const w of list) {
      console.log(`- ${String(w.id ?? "")} machine=${String(w.machine ?? "")} path=${String(w.path ?? "")}`);
    }
    return;
  }

  if (cmd === "lead") {
    const words = argv.slice(1).filter((a) => !a.startsWith("--") || a === "--");
    const u = words.filter((w) => w !== "--").join(" ").trim();
    if (!u) {
      console.log('Usage: pnpm atom lead "打开 AI推进 群"');
      process.exit(1);
    }
    const res = await api<{ ok: boolean; message: string; changed?: string[] }>(
      "POST",
      "/api/lead",
      { utterance: u }
    );
    const result = res.data;
    const fail = result.message || (result as { error?: string }).error || "";
    console.log(result.ok ? `OK ${result.message}` : `NO ${fail}`);
    if (result.changed?.length) console.log(`changed: ${result.changed.join(", ")}`);
    process.exit(result.ok ? 0 : 1);
  }

  if (cmd === "route") {
    const id = positional(argv.slice(1));
    if (!id) usage();
    const data = await apiOk<{
      workspace: string;
      machine: string;
      path: string;
      confidence: number;
      reason: string;
    }>("POST", "/api/route", { id });
    console.log(`workspace: ${data.workspace}`);
    console.log(`machine:   ${data.machine}`);
    console.log(`path:      ${data.path}`);
    console.log(`confidence:${data.confidence}`);
    console.log(`reason:    ${data.reason}`);
    return;
  }

  if (cmd === "evidence") {
    const id = positional(argv.slice(1));
    const pathFlag = flags.path as string | undefined;
    if (!id || !pathFlag) usage();
    const data = await apiOk<{ evidenceId: string; handoffId: string }>("POST", "/api/evidence", {
      id,
      path: pathFlag,
    });
    console.log(`OK evidence ${data.evidenceId} for handoff ${id}`);
    return;
  }

  if (cmd === "checklist") {
    const id = positional(argv.slice(1));
    if (!id) usage();
    const data = await apiOk<{ text: string }>("POST", "/api/checklist", { id });
    console.log(data.text);
    return;
  }

  if (cmd === "checklist-done") {
    const [id, itemKey] = positionals(argv.slice(1));
    if (!id || !itemKey) usage();
    const data = await apiOk<{ itemKey: string; text: string }>("POST", "/api/checklist-done", {
      id,
      itemKey,
      note: flags.note,
      ack: Boolean(flags.ack),
    });
    console.log(`OK checklist-done ${data.itemKey}`);
    console.log(data.text);
    return;
  }

  if (cmd === "checklist-ack") {
    const id = positional(argv.slice(1));
    if (!id) usage();
    const data = await apiOk<{ text?: string }>("POST", "/api/checklist-ack", { id, ack: true });
    console.log(`OK checklist-ack ${id}`);
    if (data.text) console.log(data.text);
    return;
  }

  if (cmd === "pr-open") {
    const id = positional(argv.slice(1));
    const url = flags.url as string | undefined;
    if (!id || !url) usage();
    const data = await apiOk<{ prId: string; forced: boolean }>("POST", "/api/pr-open", {
      id,
      url,
      branch: flags.branch,
      force: Boolean(flags.force),
    });
    console.log(`OK pr-open ${data.prId}${data.forced ? " (forced)" : ""}`);
    console.log(`url: ${url}`);
    return;
  }

  usage();
}

type Candidate = {
  id: string;
  status: string;
  title: string;
  confidence?: number;
  refs?: Array<{ token: string; digest?: string }>;
};

function printMergeSweep(data: {
  apply: boolean;
  considered: number;
  compared?: number;
  merged: number;
  skipped?: number;
  failOpen?: boolean;
  layaAvailable?: boolean;
  reason?: string;
  pairs: Array<{
    loserId: string;
    loserTitle: string;
    survivorId: string;
    survivorTitle: string;
    sameRequest?: number;
    confidence?: number;
    reason: string;
  }>;
}) {
  const mode = data.apply ? "apply" : "dry-run";
  if (data.reason === "laya-disabled") {
    console.log(`merge-sweep (${mode}): Laya disabled (LAYA_ENABLED=0) — nothing to do`);
    return;
  }
  if (data.reason === "laya-unavailable" || data.layaAvailable === false) {
    console.log(
      `merge-sweep (${mode}): Laya unavailable — fail-open (no merges). Start Laya or check LAYA_URL.`
    );
    console.log(`open Needs-you items: ${data.considered}`);
    return;
  }
  if (!data.merged) {
    console.log(
      `OK merge-sweep (${mode}): open=${data.considered} compared=${data.compared ?? 0} nothing to merge`
    );
    return;
  }
  console.log(
    `OK merge-sweep (${mode}): open=${data.considered} would_merge=${data.merged}${
      data.apply ? " wrote=yes" : " wrote=no"
    }`
  );
  for (const p of data.pairs ?? []) {
    const noul = p.sameRequest != null ? ` same_request=${p.sameRequest}` : "";
    console.log(`- ${p.loserId}  ${p.loserTitle}`);
    console.log(`    → ${p.survivorId}  ${p.survivorTitle}${noul}`);
  }
  if (!data.apply) {
    console.log("(no writes — pass --apply to merge)");
  }
}

function printTagBackfill(data: {
  apply: boolean;
  considered: number;
  tagged: number;
  skipped?: number;
  failOpen?: boolean;
  layaAvailable?: boolean;
  reason?: string;
  items: Array<{
    id: string;
    title: string;
    theme?: string;
    project?: string;
    via: string;
    reason: string;
  }>;
}) {
  const mode = data.apply ? "apply" : "dry-run";
  if (data.reason === "laya-disabled" && !data.tagged) {
    console.log(`tag-backfill (${mode}): Laya disabled (LAYA_ENABLED=0) — nothing to do`);
    return;
  }
  if ((data.reason === "laya-unavailable" || data.layaAvailable === false) && !data.tagged) {
    console.log(
      `tag-backfill (${mode}): Laya unavailable — fail-open (cards unchanged). Start Laya or check LAYA_URL.`
    );
    console.log(`open Needs-you items: ${data.considered}`);
    return;
  }
  if (!data.tagged) {
    console.log(
      `OK tag-backfill (${mode}): open=${data.considered} skipped=${data.skipped ?? 0} nothing to tag`
    );
    return;
  }
  console.log(
    `OK tag-backfill (${mode}): open=${data.considered} would_tag=${data.tagged}${
      data.apply ? " wrote=yes" : " wrote=no"
    }`
  );
  if (data.layaAvailable === false) {
    console.log("Laya unavailable — untagged cards left unchanged; kebab/alias titles were remapped locally.");
  }
  for (const it of data.items ?? []) {
    const proj = it.project ? ` project=${it.project}` : "";
    console.log(`- ${it.id}  ${it.title}`);
    console.log(`    theme=${it.theme ?? "-"} via=${it.via}${proj}`);
  }
  if (!data.apply) {
    console.log("(no writes — pass --apply to persist Chinese allowlist tags)");
  }
}

function printOutboundCheck(data: {
  action: string;
  fail_open: boolean;
  reason: string;
  confidence?: number | null;
  laya_available?: boolean;
  delivered?: boolean;
  kind?: string;
  laya_outbound?: {
    demand_noul?: number | null;
    noise_noul?: number | null;
  };
}) {
  const open = data.fail_open ? " fail_open" : "";
  console.log(
    `OK outbound-check action=${data.action} reason=${data.reason}${open} kind=${data.kind ?? "outbound"}`
  );
  if (data.laya_available === false) {
    console.log("Laya unavailable — fail-open allow. Desk remains the send authority.");
  }
  const noul = data.laya_outbound;
  if (noul?.noise_noul != null || noul?.demand_noul != null) {
    console.log(
      `noise_noul=${noul.noise_noul ?? "-"} demand_noul=${noul.demand_noul ?? "-"}`
    );
  }
  if (data.action === "drop") {
    console.log("drop: do not post (high-confidence noise)");
  } else if (data.action === "hold") {
    console.log("hold: Desk should confirm before send");
  } else {
    console.log("allow: Laya would not block; Desk still confirms irreversible Yunzhijia sends");
  }
}

function printPreferenceRsi(data: {
  apply: boolean;
  changed: boolean;
  reason: string;
  path?: string | null;
  eventId?: string | null;
  samples: {
    accepted: number;
    rejected: number;
    merged: number;
    suggested: number;
    noise_rejects: number;
    fail_open_accepted: number;
    merge_fail_open_merged: number;
  };
  before: { noise: number; merge: number; outbound: number };
  after: { noise: number; merge: number; outbound: number };
  deltas: { noise: number; merge: number; outbound: number };
  added_allowlist?: string[];
  added_blocklist?: string[];
}) {
  const mode = data.apply ? "apply" : "dry-run";
  console.log(
    `OK preference-rsi (${mode}) reason=${data.reason} changed=${data.changed}`
  );
  const s = data.samples;
  console.log(
    `samples: accepted=${s.accepted} rejected=${s.rejected} merged=${s.merged} suggested=${s.suggested} noise_rejects=${s.noise_rejects} fail_open_accepted=${s.fail_open_accepted} merge_fail_open=${s.merge_fail_open_merged}`
  );
  console.log(
    `thresholds: noise ${data.before.noise}→${data.after.noise}  merge ${data.before.merge}→${data.after.merge}  outbound ${data.before.outbound}→${data.after.outbound}`
  );
  if (data.added_allowlist?.length) {
    console.log(`allowlist +: ${data.added_allowlist.join(" | ")}`);
  }
  if (data.added_blocklist?.length) {
    console.log(`blocklist +: ${data.added_blocklist.join(" | ")}`);
  }
  if (data.apply && data.eventId) {
    console.log(`audit: preference_rsi ${data.eventId}`);
  }
  if (data.apply && data.path) {
    console.log(`wrote: ${data.path}`);
  }
  if (!data.apply) {
    console.log("(no writes — pass --apply to persist preference memory)");
  }
}

function printCandidates(list: Candidate[]) {
  if (!list.length) {
    console.log("(no candidates)");
    return;
  }
  for (const c of list) {
    console.log(`- [${c.status}] ${c.id}`);
    console.log(`  ${c.title}`);
    console.log(`  confidence=${c.confidence}`);
    for (const r of c.refs ?? []) {
      console.log(`  ref: ${r.token}${r.digest ? ` | ${r.digest}` : ""}`);
    }
  }
}

function printDoctor(report: {
  ready: boolean;
  checks: Array<{ status: string; title: string; detail: string; fix?: string }>;
}) {
  for (const c of report.checks ?? []) {
    const mark = c.status === "ok" ? "OK" : c.status === "warn" ? "!!" : "XX";
    console.log(`[${mark}] ${c.title}: ${c.detail}`);
    if (c.fix && c.status !== "ok") console.log(`     fix: ${c.fix}`);
  }
  console.log(report.ready ? "cold-start: READY" : "cold-start: NOT READY");
}

function cliGroupIds(): string[] | undefined {
  const fromEnv = (process.env.ATOM_YZJ_GROUP_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : undefined;
}

function parseFlags(args: string[]): Flags {
  const out: Flags = {};
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
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(err instanceof ApiDownError ? 2 : 1);
});
