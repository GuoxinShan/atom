import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import {
  candidatesByStatus,
  groupNeedsYouCandidates,
  loadGroupingWorkspaces,
  approveCandidate,
  rejectCandidate,
  rejectNoiseCandidates,
  listSpecDrafts,
  approveSpec,
  returnSpec,
  dispatchToLead,
  SpecReviewError,
  specsAwaitingReview,
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
  runTagBackfill,
  runPreferenceRsi,
  runGateDigest,
  GateDigestError,
  writeDigest,
  evaluateOutboundGate,
  layaOutboundToDetail,
  attachEvidence,
  findSpec,
  LeadAgent,
  openPr,
  readRuntimeMeta,
  loadPreferenceMemory,
  savePreferenceMemory,
  applyPreferenceMemoryPatch,
  preferenceMemoryPath,
  PREFERENCE_MEMORY_FILE,
  readLastPreferenceRsi,
  LayaClient,
  loadThemeVocabulary,
  refreshProgressSnapshot,
  runDoneSweep,
  reopenCandidate,
  loadProgressSnapshot,
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

  if (method === "GET" && p === "/api/status") {
    const meta = readRuntimeMeta(daemon.store);
    const memory = loadPreferenceMemory(daemon.repoRoot, daemon.store);
    json(res, {
      ok: true,
      desk: { ok: true, service: "atom-desk" },
      lastRunAt: meta.lastRunAt,
      lastExtractAt: meta.lastExtractAt,
      preference: {
        floors: { ...memory.thresholds },
        updated_at: memory.updated_at,
        source_of_truth: PREFERENCE_MEMORY_FILE,
      },
      laya: await probeLayaCheap(daemon.repoRoot),
      progress: progressStatus(daemon.repoRoot),
    });
    return true;
  }

  if (method === "GET" && p === "/api/preference-memory") {
    json(res, preferenceMemoryPayload(daemon));
    return true;
  }

  if (method === "PATCH" && p === "/api/preference-memory") {
    const body = await readJson(req);
    const current = loadPreferenceMemory(daemon.repoRoot, daemon.store);
    const thresholdsRaw = body.thresholds;
    const thresholds =
      thresholdsRaw && typeof thresholdsRaw === "object" && !Array.isArray(thresholdsRaw)
        ? (thresholdsRaw as Record<string, unknown>)
        : undefined;
    const { memory, changed } = applyPreferenceMemoryPatch(current, {
      thresholds: thresholds
        ? {
            noise: typeof thresholds.noise === "number" && Number.isFinite(thresholds.noise) ? thresholds.noise : undefined,
            merge: typeof thresholds.merge === "number" && Number.isFinite(thresholds.merge) ? thresholds.merge : undefined,
            outbound:
              typeof thresholds.outbound === "number" && Number.isFinite(thresholds.outbound)
                ? thresholds.outbound
                : undefined,
          }
        : undefined,
      blocklist: Array.isArray(body.blocklist) ? body.blocklist.map(String) : undefined,
      blocklist_add: Array.isArray(body.blocklist_add) ? body.blocklist_add.map(String) : undefined,
      blocklist_remove: Array.isArray(body.blocklist_remove)
        ? body.blocklist_remove.map(String)
        : undefined,
    });
    if (changed) {
      savePreferenceMemory(daemon.repoRoot, memory, daemon.store);
    }
    json(res, { ...preferenceMemoryPayload(daemon, memory), changed });
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
    const suggested = status === "suggested" ? list : candidatesByStatus(daemon.store, "suggested");
    json(res, {
      candidates: list,
      groups: groupNeedsYouCandidates(
        suggested,
        loadGroupingWorkspaces(daemon.repoRoot),
        loadThemeVocabulary(daemon.repoRoot)
      ),
    });
    return true;
  }

  if (method === "POST" && p === "/api/approve") {
    const body = await readJson(req);
    const id = str(body, "id");
    if (!id) {
      json(res, { error: "id required" }, 400);
      return true;
    }
    const { specId, created } = approveCandidate(
      daemon.store,
      id,
      body.note ? String(body.note) : undefined
    );
    json(res, { ok: true, specId, created });
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

  if (method === "POST" && p === "/api/tag-backfill") {
    const body = await readJson(req);
    const result = await runTagBackfill(daemon.store, {
      apply: body.apply === true,
      repoRoot: daemon.repoRoot,
    });
    json(res, { ok: true, ...result });
    return true;
  }

  if (method === "POST" && p === "/api/progress-scan") {
    const refresh = await refreshProgressSnapshot(daemon.repoRoot, { source: "api" });
    const snapshot = loadProgressSnapshot(daemon.repoRoot);
    json(res, {
      ok: refresh.ok,
      via: refresh.via,
      failOpen: refresh.failOpen,
      error: refresh.error,
      path: refresh.path,
      available: refresh.available,
      items: refresh.items,
      snapshot,
    });
    return true;
  }

  if (method === "POST" && p === "/api/done-sweep") {
    const body = await readJson(req);
    const result = await runDoneSweep(daemon.store, {
      apply: body.apply === true,
      repoRoot: daemon.repoRoot,
    });
    json(res, { ok: true, ...result });
    return true;
  }

  if (method === "POST" && p === "/api/reopen") {
    const body = await readJson(req);
    const id = str(body, "id");
    if (!id) {
      json(res, { error: "id required" }, 400);
      return true;
    }
    try {
      const candidate = reopenCandidate(daemon.store, id, body.note ? String(body.note) : undefined);
      json(res, { ok: true, candidate });
    } catch (err) {
      json(res, { error: (err as Error).message }, 400);
    }
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

  if ((method === "GET" || method === "POST") && p === "/api/gate-digest") {
    let since = url.searchParams.get("since") ?? "";
    if (method === "POST") {
      const body = await readJson(req);
      if (!since) since = str(body, "since");
    }
    try {
      const result = runGateDigest(daemon.store, {
        since: since || undefined,
        repoRoot: daemon.repoRoot,
      });
      json(res, { ok: true, ...result });
    } catch (err) {
      if (err instanceof GateDigestError) {
        json(res, { error: err.message }, 400);
        return true;
      }
      throw err;
    }
    return true;
  }

  if (method === "GET" && p === "/api/specs") {
    const specs = listSpecDrafts(daemon.store);
    json(res, { specs, review: specsAwaitingReview(daemon.store) });
    return true;
  }

  if (method === "POST" && p === "/api/spec-approve") {
    const body = await readJson(req);
    const id = str(body, "id", "specId", "candidateId");
    if (!id) {
      json(res, { error: "id required" }, 400);
      return true;
    }
    try {
      const spec = approveSpec(daemon.store, id, specPatch(body));
      json(res, { ok: true, spec });
    } catch (err) {
      if (err instanceof SpecReviewError) {
        json(res, { error: err.message, code: err.code }, 400);
        return true;
      }
      throw err;
    }
    return true;
  }

  if (method === "POST" && p === "/api/spec-return") {
    const body = await readJson(req);
    const id = str(body, "id", "specId", "candidateId");
    if (!id) {
      json(res, { error: "id required" }, 400);
      return true;
    }
    try {
      const spec = returnSpec(daemon.store, id, specPatch(body));
      json(res, { ok: true, spec });
    } catch (err) {
      if (err instanceof SpecReviewError) {
        json(res, { error: err.message, code: err.code }, 400);
        return true;
      }
      throw err;
    }
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
    const target =
      body.target === "grok-cli" || body.target === "cursor" || body.target === "file"
        ? body.target
        : "file";
    const coding =
      run || target === "grok-cli" || target === "cursor"
        ? resolveCodingAgent(daemon.repoRoot)
        : undefined;
    try {
      const result = await dispatchToLead(daemon.store, daemon.repoRoot, id, coding, {
        run,
        target,
      });
      json(res, { ok: true, ...result });
    } catch (err) {
      if (err instanceof SpecReviewError) {
        json(res, { error: err.message, code: err.code }, 400);
        return true;
      }
      throw err;
    }
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

function preferenceMemoryPayload(
  daemon: Daemon,
  memory = loadPreferenceMemory(daemon.repoRoot, daemon.store)
) {
  const filePath = preferenceMemoryPath(daemon.repoRoot);
  return {
    ok: true,
    source_of_truth: PREFERENCE_MEMORY_FILE,
    path: filePath,
    exists: fs.existsSync(filePath),
    memory,
    last_rsi: readLastPreferenceRsi(daemon.store),
  };
}

/** Short probe for the Desk status strip. Must not stall on a 10s Laya timeout. */
async function probeLayaCheap(
  repoRoot: string
): Promise<{ enabled: boolean; ok: boolean | null }> {
  const client = LayaClient.fromEnv({ repoRoot, timeoutMs: 400 });
  if (!client.enabled) return { enabled: false, ok: null };
  try {
    return { enabled: true, ok: await client.health() };
  } catch {
    return { enabled: true, ok: false };
  }
}

function progressStatus(repoRoot: string): {
  snapshot: boolean;
  generated_at: string | null;
  available: number;
  fail_open: number;
  items: number;
} {
  const snap = loadProgressSnapshot(repoRoot);
  if (!snap) {
    return { snapshot: false, generated_at: null, available: 0, fail_open: 0, items: 0 };
  }
  return {
    snapshot: true,
    generated_at: snap.generated_at || null,
    available: snap.workspaces.filter((w) => w.available).length,
    fail_open: snap.workspaces.filter((w) => w.fail_open).length,
    items: snap.workspaces.reduce((n, w) => n + w.items.length, 0),
  };
}

function str(body: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

function specPatch(body: Record<string, unknown>): {
  title?: string;
  body?: string;
  acceptance_criteria?: string[];
  note?: string;
} {
  const criteriaRaw = body.acceptance_criteria ?? body.criteria;
  return {
    title: typeof body.title === "string" ? body.title : undefined,
    body: typeof body.body === "string" ? body.body : undefined,
    acceptance_criteria: Array.isArray(criteriaRaw) ? criteriaRaw.map(String) : undefined,
    note: typeof body.note === "string" ? body.note : undefined,
  };
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

export async function executeRun(daemon: Daemon, body: Record<string, unknown>) {
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
