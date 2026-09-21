import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import {
  candidatesByStatus,
  approveCandidate,
  rejectCandidate,
  rejectNoiseCandidates,
  exportHandoff,
  listSpecDrafts,
  listChecklists,
  completeChecklistItem,
  startChecklist,
  formatChecklist,
  runColdStart,
  ensureColdStartFiles,
  leadApplyConfig,
  AgentProviderRegistry,
  runPipeline,
  resolveExtractAgent,
  resolveCodingAgent,
  ingestFromSource,
  runExtract,
  runMergeSweep,
  runPreferenceRsi,
  writeDigest,
  evaluateOutboundGate,
  layaOutboundToDetail,
  attachEvidence,
  findSpec,
  LeadAgent,
  openPr,
  readRuntimeMeta,
} from "@atom/core";
import type { Daemon } from "./context.js";
import { json, readJson } from "./http.js";

/**
 * Local HTTP API — the only side-effect path.
 *
 * Desk (browser) and CLI (fetch client) both call these routes.
 * `/hooks/*` is the inbound webhook alias; CLI `run` uses POST `/api/run`.
 */
export async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  daemon: Daemon
): Promise<boolean> {
  const method = req.method ?? "GET";
  const p = url.pathname;

  if (method === "GET" && p === "/api/health") {
    json(res, { ok: true, service: "atom-desk" });
    return true;
  }

  if (method === "GET" && p === "/api/meta") {
    json(res, { ok: true, ...readRuntimeMeta(daemon.store) });
    return true;
  }

  if (method === "GET" && p === "/api/candidates") {
    const status = url.searchParams.get("status") as
      | "suggested"
      | "accepted"
      | "rejected"
      | "merged"
      | null;
    const list = candidatesByStatus(daemon.store, status ?? undefined);
    json(res, { candidates: list });
    return true;
  }

  if (method === "POST" && p === "/api/approve") {
    const body = await readJson(req);
    const id = str(body, "id");
    if (!id) {
      json(res, { error: "id required" }, 400);
      return true;
    }
    const { specId } = approveCandidate(
      daemon.store,
      id,
      body.note ? String(body.note) : undefined
    );
    json(res, { ok: true, specId });
    return true;
  }

  if (method === "POST" && p === "/api/reject") {
    const body = await readJson(req);
    const id = str(body, "id");
    if (!id) {
      json(res, { error: "id required" }, 400);
      return true;
    }
    rejectCandidate(daemon.store, id, body.reason ? String(body.reason) : undefined);
    json(res, { ok: true });
    return true;
  }

  if (method === "POST" && p === "/api/reject-noise") {
    const result = rejectNoiseCandidates(daemon.store);
    json(res, { ok: true, ...result });
    return true;
  }

  if (method === "POST" && p === "/api/merge-sweep") {
    const body = await readJson(req);
    const result = await runMergeSweep(daemon.store, {
      apply: body.apply === true,
      repoRoot: daemon.repoRoot,
    });
    json(res, { ok: true, ...result });
    return true;
  }

  if (method === "POST" && p === "/api/outbound-check") {
    const body = await readJson(req);
    const title = str(body, "title");
    const text = str(body, "body", "text");
    const kind = str(body, "kind") || "outbound";
    if (!title && !text) {
      json(res, { error: "title or body required" }, 400);
      return true;
    }
    const result = await evaluateOutboundGate(
      { title, body: text, kind },
      { store: daemon.store, repoRoot: daemon.repoRoot }
    );
    json(res, {
      ok: true,
      action: result.gate.action,
      fail_open: result.gate.failOpen,
      reason: result.gate.reason,
      confidence: result.gate.confidence ?? null,
      laya_available: result.layaAvailable,
      delivered: false,
      event_id: result.eventId ?? null,
      kind: result.kind,
      laya_outbound: layaOutboundToDetail(result.gate),
    });
    return true;
  }

  if (method === "POST" && p === "/api/preference-rsi") {
    const body = await readJson(req);
    const dryRun = body.dryRun === true || body["dry-run"] === true;
    const apply = body.apply === true && !dryRun;
    const result = runPreferenceRsi(daemon.store, {
      apply,
      repoRoot: daemon.repoRoot,
    });
    json(res, { ok: true, ...result });
    return true;
  }

  if (method === "GET" && p === "/api/specs") {
    json(res, { specs: listSpecDrafts(daemon.store) });
    return true;
  }

  if (method === "GET" && p === "/api/checklists") {
    const all = listChecklists(daemon.store);
    json(res, {
      checklists: all,
      awaitingHumanAck: all.filter((c) => c.awaitingHumanAck && !c.passed),
    });
    return true;
  }

  if (method === "POST" && p === "/api/checklist-ack") {
    const body = await readJson(req);
    const id = str(body, "id", "subjectId");
    if (!id) {
      json(res, { error: "id required" }, 400);
      return true;
    }
    if (body.ack !== true) {
      json(res, { error: "human_gate_ack requires ack:true (never auto)" }, 400);
      return true;
    }
    const view = completeChecklistItem(daemon.store, id, "human_gate_ack", { ack: true });
    json(res, { ok: true, checklist: view, text: formatChecklist(view) });
    return true;
  }

  if (method === "POST" && p === "/api/checklist") {
    const body = await readJson(req);
    const id = str(body, "id");
    if (!id) {
      json(res, { error: "id required" }, 400);
      return true;
    }
    const view = startChecklist(daemon.store, id);
    json(res, { ok: true, checklist: view, text: formatChecklist(view) });
    return true;
  }

  if (method === "POST" && p === "/api/checklist-done") {
    const body = await readJson(req);
    const id = str(body, "id");
    const itemKey = str(body, "itemKey", "key");
    if (!id || !itemKey) {
      json(res, { error: "id and itemKey required" }, 400);
      return true;
    }
    const view = completeChecklistItem(daemon.store, id, itemKey, {
      note: body.note ? String(body.note) : undefined,
      ack: Boolean(body.ack),
    });
    json(res, { ok: true, itemKey, checklist: view, text: formatChecklist(view) });
    return true;
  }

  if (method === "POST" && p === "/api/handoff") {
    const body = await readJson(req);
    const id = str(body, "id", "specId", "candidateId");
    if (!id) {
      json(res, { error: "id required" }, 400);
      return true;
    }
    const run = Boolean(body.run);
    const coding =
      body.target === "file" ? undefined : resolveCodingAgent(daemon.repoRoot);
    const pack = await exportHandoff(daemon.store, daemon.repoRoot, id, coding, {
      run,
      target: body.target === "file" ? "file" : "grok-cli",
    });
    json(res, { ok: true, pack });
    return true;
  }

  if (method === "POST" && p === "/api/evidence") {
    const body = await readJson(req);
    const id = str(body, "id", "handoffId");
    const evidencePath = str(body, "path");
    if (!id || !evidencePath) {
      json(res, { error: "id and path required" }, 400);
      return true;
    }
    const kind = (body.kind as "test" | "screenshot" | "log" | "note" | undefined) ?? "note";
    const evidenceId = attachEvidence(daemon.store, id, evidencePath, kind);
    json(res, { ok: true, evidenceId, handoffId: id });
    return true;
  }

  if (method === "POST" && p === "/api/pr-open") {
    const body = await readJson(req);
    const id = str(body, "id");
    const prUrl = str(body, "url");
    if (!id || !prUrl) {
      json(res, { error: "id and url required" }, 400);
      return true;
    }
    const { prId, forced } = openPr(daemon.store, id, {
      url: prUrl,
      branch: body.branch ? String(body.branch) : undefined,
      force: Boolean(body.force),
    });
    json(res, { ok: true, prId, forced, url: prUrl });
    return true;
  }

  if (method === "POST" && p === "/api/route") {
    const body = await readJson(req);
    const id = str(body, "id");
    if (!id) {
      json(res, { error: "id required" }, 400);
      return true;
    }
    const lead = new LeadAgent(daemon.repoRoot);
    const spec = findSpec(daemon.store, id);
    const route = lead.routeSpec(spec);
    json(res, {
      ok: true,
      workspace: route.workspace.id,
      machine: route.machine,
      path: route.workspace.path,
      confidence: route.confidence,
      reason: route.reason,
      route,
    });
    return true;
  }

  if (method === "GET" && p === "/api/agents") {
    const reg = new AgentProviderRegistry(daemon.repoRoot);
    json(res, reg.load());
    return true;
  }

  if (method === "GET" && (p === "/api/setup" || p === "/api/doctor")) {
    json(res, runColdStart(daemon.repoRoot));
    return true;
  }

  if (method === "POST" && p === "/api/setup") {
    const created = ensureColdStartFiles(daemon.repoRoot);
    const report = runColdStart(daemon.repoRoot);
    json(res, { ok: true, created, report });
    return true;
  }

  if (method === "GET" && p === "/api/sources") {
    json(res, readDataJson(daemon.repoRoot, "data/sources.json", { sources: [] }));
    return true;
  }

  if (method === "GET" && p === "/api/subscriptions") {
    json(
      res,
      readDataJson(daemon.repoRoot, "data/subscriptions.json", { subscriptions: [] })
    );
    return true;
  }

  if (method === "GET" && p === "/api/triggers") {
    json(res, readDataJson(daemon.repoRoot, "data/triggers.json", { triggers: [] }));
    return true;
  }

  if (method === "GET" && p === "/api/workspaces") {
    json(res, readDataJson(daemon.repoRoot, "data/workspaces.json", { workspaces: [] }));
    return true;
  }

  if (method === "POST" && p === "/api/lead") {
    const body = await readJson(req);
    const utterance = str(body, "utterance", "text");
    if (!utterance.trim()) {
      json(res, { error: "utterance required" }, 400);
      return true;
    }
    const result = leadApplyConfig(daemon.repoRoot, utterance);
    json(res, result, result.ok ? 200 : 400);
    return true;
  }

  if (method === "POST" && p === "/api/run") {
    const body = await readJson(req);
    const result = await executeRun(daemon, body);
    json(res, { ok: true, ...result });
    return true;
  }

  if (method === "POST" && p === "/api/ingest") {
    const body = await readJson(req);
    const result = await executeIngest(daemon, body);
    json(res, { ok: true, ...result });
    return true;
  }

  if (method === "POST" && p === "/api/extract") {
    const body = await readJson(req);
    const result = await executeExtract(daemon, body);
    json(res, { ok: true, ...result });
    return true;
  }

  if (method === "POST" && p === "/api/digest") {
    const digestPath = writeDigest(daemon.store, daemon.repoRoot);
    json(res, { ok: true, digestPath });
    return true;
  }

  if (method === "POST" && p.startsWith("/hooks/")) {
    const body = await readJson(req);
    const hook = p.slice("/hooks/".length) || "run";
    console.log(`[hook] ${hook}`, body);

    if (hook === "run") {
      const result = await executeRun(daemon, body);
      json(res, { ok: true, hook, ...result });
      return true;
    }
    if (hook === "ingest") {
      const result = await executeIngest(daemon, body);
      json(res, { ok: true, hook, ...result });
      return true;
    }
    if (hook === "extract") {
      const result = await executeExtract(daemon, body);
      json(res, { ok: true, hook, ...result });
      return true;
    }
    if (hook === "digest") {
      const digestPath = writeDigest(daemon.store, daemon.repoRoot);
      json(res, { ok: true, hook, digestPath });
      return true;
    }

    json(res, { ok: true, received: true, path: p });
    return true;
  }

  return false;
}

function str(body: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

function readDataJson(repoRoot: string, rel: string, fallback: unknown): unknown {
  const pth = path.join(repoRoot, rel);
  if (!fs.existsSync(pth)) return fallback;
  return JSON.parse(fs.readFileSync(pth, "utf8"));
}

function groupIdsFromBody(body: Record<string, unknown>): string[] | undefined {
  const g = body.groupIds ?? body.groups;
  if (Array.isArray(g)) return g.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof g === "string") {
    return g
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return undefined;
}

export function groupAllowlistFor(
  daemon: Daemon,
  sourceId?: string,
  override?: string[]
): string[] {
  if (override?.length) return override;
  const fromEnv = (process.env.ATOM_YZJ_GROUP_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv.length) return fromEnv;
  const cfg = daemon.registry.loadConfig();
  const id = sourceId ?? cfg.defaultSourceId;
  const entry = cfg.sources.find((s) => s.id === id);
  return entry?.groupIds ?? [];
}

async function executeRun(daemon: Daemon, body: Record<string, unknown>) {
  const sourceId = str(body, "source", "sourceId") || undefined;
  const source = daemon.registry.resolve(sourceId);
  const agent = resolveExtractAgent(daemon.repoRoot);
  const allow = groupAllowlistFor(daemon, sourceId ?? source.id, groupIdsFromBody(body));
  const result = await runPipeline({
    store: daemon.store,
    source,
    agent,
    repoRoot: daemon.repoRoot,
    trigger: daemon.trigger,
    sink: daemon.sink,
    groupAllowlist: allow,
    heuristicGate: true,
  });
  return {
    source: source.id,
    agent: agent.id,
    groups: allow,
    ...result,
    candidates: candidatesByStatus(daemon.store, "suggested"),
  };
}

async function executeIngest(daemon: Daemon, body: Record<string, unknown>) {
  const sourceId = str(body, "source", "sourceId") || undefined;
  const source = daemon.registry.resolve(sourceId);
  const { ingested, nextCursor } = await ingestFromSource(daemon.store, source);
  return { source: source.id, ingested, nextCursor };
}

async function executeExtract(daemon: Daemon, body: Record<string, unknown>) {
  const sourceId = str(body, "source", "sourceId") || undefined;
  const agent = resolveExtractAgent(daemon.repoRoot);
  const allow = groupAllowlistFor(daemon, sourceId, groupIdsFromBody(body));
  const stats = await runExtract(daemon.store, agent, {
    heuristicGate: true,
    groupAllowlist: allow,
    repoRoot: daemon.repoRoot,
  });
  return { agent: agent.id, groups: allow, ...stats };
}
