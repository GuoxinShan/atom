/**
 * Refresh `data/progress-snapshot.json` on the 15-minute cron tick.
 *
 * Host `pnpm serve`: git/`gh` are visible → scan in-process.
 * Docker Desk: container git is not the dogfood path. Write a request into
 * the mounted `data/` volume and wait for the Mac helper
 * (`pnpm atom progress-scan --loop` / `scripts/desk-up.sh`) to scan and ack.
 *
 * Fail-open: any scan/hook/timeout error logs and keeps the last snapshot.
 * Never throws into poll / extract.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadProgressWorkspaces, runProgressScan, type ProgressScanResult } from "./progress-scan.js";
import { loadProgressSnapshot, progressSnapshotPath } from "./progress-snapshot.js";

export const PROGRESS_SCAN_REQUEST_FILE = "data/progress-scan.request.json";
export const PROGRESS_SCAN_ACK_FILE = "data/progress-scan.ack.json";
export const DEFAULT_PROGRESS_SCAN_PORT = 8788;
export const DEFAULT_PROGRESS_SCAN_WAIT_MS = 45_000;
export const DEFAULT_PROGRESS_SCAN_POLL_MS = 250;

export type ProgressRefreshVia =
  | "in_process"
  | "host_hook"
  | "request_file"
  | "skipped"
  | "kept";

export type ProgressRefreshAction = "skip" | "in_process" | "host_hook" | "request_file";

export type ProgressScanRequest = {
  id: string;
  requested_at: string;
  source: string;
};

export type ProgressScanAck = {
  id: string;
  scanned_at: string;
  ok: boolean;
  path?: string;
  available?: number;
  fail_open?: number;
  items?: number;
  error?: string;
};

export type ProgressRefreshResult = {
  via: ProgressRefreshVia;
  ok: boolean;
  failOpen: boolean;
  error?: string;
  waitedMs?: number;
  snapshotMtime?: string | null;
  available?: number;
  items?: number;
  path?: string;
  requestId?: string;
};

export type ProgressRefreshPlanInput = {
  disabled?: boolean;
  gitVisible?: boolean;
  hookUrl?: string | null;
  hookCommand?: string | null;
};

export type ProgressRefreshDeps = {
  disabled?: boolean;
  gitVisible?: boolean;
  hookUrl?: string | null;
  hookCommand?: string | null;
  source?: string;
  waitMs?: number;
  pollMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  scan?: (repoRoot: string) => Promise<ProgressScanResult>;
  fetchHook?: (url: string) => Promise<{ ok: boolean; status: number; body?: string }>;
  runHookCommand?: (command: string) => Promise<{ code: number; stdout: string; stderr: string }>;
};

export function progressScanDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.ATOM_PROGRESS_SCAN ?? "").trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "off";
}

export function progressScanWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ATOM_PROGRESS_SCAN_WAIT_MS);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : DEFAULT_PROGRESS_SCAN_WAIT_MS;
}

export function progressScanHookUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.ATOM_PROGRESS_SCAN_URL ?? "").trim();
  return raw ? raw : null;
}

export function progressScanHookCommand(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.ATOM_PROGRESS_SCAN_HOOK ?? "").trim();
  return raw ? raw : null;
}

export function isGitWorkTree(dir: string): boolean {
  if (!dir) return false;
  try {
    if (!fs.existsSync(dir)) return false;
    return fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
}

/** True when at least one progress workspace path looks like a git checkout. */
export function workspaceGitVisible(repoRoot: string): boolean {
  const listed = loadProgressWorkspaces(repoRoot);
  return listed.some((w) => isGitWorkTree(w.path));
}

export function progressRefreshPlan(input: ProgressRefreshPlanInput): ProgressRefreshAction {
  if (input.disabled) return "skip";
  if (input.gitVisible) return "in_process";
  if (input.hookUrl || input.hookCommand) return "host_hook";
  return "request_file";
}

export function progressScanRequestPath(repoRoot: string): string {
  return path.join(repoRoot, PROGRESS_SCAN_REQUEST_FILE);
}

export function progressScanAckPath(repoRoot: string): string {
  return path.join(repoRoot, PROGRESS_SCAN_ACK_FILE);
}

export function newProgressScanRequestId(now = new Date()): string {
  return `pscan_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function writeProgressScanRequest(
  repoRoot: string,
  source = "cron",
  now = new Date()
): ProgressScanRequest {
  const req: ProgressScanRequest = {
    id: newProgressScanRequestId(now),
    requested_at: now.toISOString(),
    source,
  };
  const p = progressScanRequestPath(repoRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(req, null, 2) + "\n", "utf8");
  return req;
}

export function readProgressScanRequest(repoRoot: string): ProgressScanRequest | null {
  return readJsonFile(progressScanRequestPath(repoRoot), asRequest);
}

export function writeProgressScanAck(repoRoot: string, ack: ProgressScanAck): string {
  const p = progressScanAckPath(repoRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(ack, null, 2) + "\n", "utf8");
  return p;
}

export function readProgressScanAck(repoRoot: string): ProgressScanAck | null {
  return readJsonFile(progressScanAckPath(repoRoot), asAck);
}

export function progressSnapshotMtimeMs(repoRoot: string): number | null {
  try {
    const p = progressSnapshotPath(repoRoot);
    if (!fs.existsSync(p)) return null;
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

function snapshotSummary(repoRoot: string): {
  snapshotMtime: string | null;
  available?: number;
  items?: number;
  path?: string;
} {
  const mtime = progressSnapshotMtimeMs(repoRoot);
  const snap = loadProgressSnapshot(repoRoot);
  return {
    snapshotMtime: mtime != null ? new Date(mtime).toISOString() : snap?.generated_at || null,
    available: snap?.workspaces.filter((w) => w.available).length,
    items: snap?.workspaces.reduce((n, w) => n + w.items.length, 0),
    path: snap ? progressSnapshotPath(repoRoot) : undefined,
  };
}

function keptResult(repoRoot: string, error: string, via: ProgressRefreshVia = "kept"): ProgressRefreshResult {
  return {
    via,
    ok: false,
    failOpen: true,
    error,
    ...snapshotSummary(repoRoot),
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultFetchHook(url: string): Promise<{ ok: boolean; status: number; body?: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, body };
}

async function defaultRunHookCommand(
  command: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: 1, stdout, stderr: stderr || "hook timeout" });
    }, 60_000);
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * Refresh the progress snapshot. Never throws — cron/extract must continue.
 */
export async function refreshProgressSnapshot(
  repoRoot: string,
  deps: ProgressRefreshDeps = {}
): Promise<ProgressRefreshResult> {
  try {
    const disabled = deps.disabled ?? progressScanDisabled();
    const gitVisible = deps.gitVisible ?? workspaceGitVisible(repoRoot);
    const hookUrl = deps.hookUrl === undefined ? progressScanHookUrl() : deps.hookUrl;
    const hookCommand = deps.hookCommand === undefined ? progressScanHookCommand() : deps.hookCommand;
    const action = progressRefreshPlan({ disabled, gitVisible, hookUrl, hookCommand });
    const source = deps.source ?? "cron";

    if (action === "skip") {
      return { via: "skipped", ok: true, failOpen: false, ...snapshotSummary(repoRoot) };
    }

    if (action === "in_process") {
      return await refreshInProcess(repoRoot, deps);
    }

    const req = writeProgressScanRequest(repoRoot, source, deps.now?.() ?? new Date());
    if (action === "host_hook") {
      const hooked = await invokeHostHook(repoRoot, req, { hookUrl, hookCommand, deps });
      if (hooked) return hooked;
    }
    return await waitForHostScan(repoRoot, req, deps, action === "host_hook" ? "host_hook" : "request_file");
  } catch (err) {
    const error = (err as Error).message || String(err);
    console.warn(`[progress-refresh] fail-open: ${error}`);
    return keptResult(repoRoot, error);
  }
}

async function refreshInProcess(
  repoRoot: string,
  deps: ProgressRefreshDeps
): Promise<ProgressRefreshResult> {
  const scan = deps.scan ?? ((root: string) => runProgressScan(root));
  try {
    const result = await scan(repoRoot);
    return {
      via: "in_process",
      ok: true,
      failOpen: result.failOpen > 0 && result.available === 0,
      available: result.available,
      items: result.items,
      path: result.path,
      snapshotMtime: result.snapshot.generated_at,
    };
  } catch (err) {
    const error = (err as Error).message || String(err);
    console.warn(`[progress-refresh] in-process scan failed (fail-open): ${error}`);
    return keptResult(repoRoot, error, "in_process");
  }
}

async function invokeHostHook(
  repoRoot: string,
  req: ProgressScanRequest,
  input: {
    hookUrl: string | null;
    hookCommand: string | null;
    deps: ProgressRefreshDeps;
  }
): Promise<ProgressRefreshResult | null> {
  const { hookUrl, hookCommand, deps } = input;
  if (hookCommand) {
    try {
      const run = deps.runHookCommand ?? defaultRunHookCommand;
      const spawned = await run(hookCommand);
      if (spawned.code === 0) {
        return {
          via: "host_hook",
          ok: true,
          failOpen: false,
          requestId: req.id,
          ...snapshotSummary(repoRoot),
        };
      }
      console.warn(
        `[progress-refresh] host hook command exited ${spawned.code}: ${(spawned.stderr || spawned.stdout).slice(0, 240)}`
      );
    } catch (err) {
      console.warn(`[progress-refresh] host hook command failed: ${(err as Error).message}`);
    }
  }
  if (hookUrl) {
    try {
      const fetchHook = deps.fetchHook ?? defaultFetchHook;
      const res = await fetchHook(hookUrl);
      if (res.ok) {
        return {
          via: "host_hook",
          ok: true,
          failOpen: false,
          requestId: req.id,
          ...snapshotSummary(repoRoot),
        };
      }
      console.warn(`[progress-refresh] host hook HTTP ${res.status} from ${hookUrl}`);
    } catch (err) {
      console.warn(`[progress-refresh] host hook HTTP failed: ${(err as Error).message}`);
    }
  }
  return null;
}

async function waitForHostScan(
  repoRoot: string,
  req: ProgressScanRequest,
  deps: ProgressRefreshDeps,
  via: "host_hook" | "request_file"
): Promise<ProgressRefreshResult> {
  const waitMs = deps.waitMs ?? progressScanWaitMs();
  const pollMs = deps.pollMs ?? DEFAULT_PROGRESS_SCAN_POLL_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const started = Date.now();
  const mtimeBefore = progressSnapshotMtimeMs(repoRoot);

  if (waitMs <= 0) {
    return {
      via,
      ok: false,
      failOpen: true,
      waitedMs: 0,
      requestId: req.id,
      error: "not waiting for host progress-scan helper",
      ...snapshotSummary(repoRoot),
    };
  }

  while (Date.now() - started < waitMs) {
    const ack = readProgressScanAck(repoRoot);
    if (ack?.id === req.id) {
      const waitedMs = Date.now() - started;
      if (ack.ok) {
        return {
          via,
          ok: true,
          failOpen: false,
          waitedMs,
          requestId: req.id,
          available: ack.available,
          items: ack.items,
          path: ack.path,
          ...snapshotSummary(repoRoot),
        };
      }
      return {
        ...keptResult(repoRoot, ack.error || "host helper reported failure", via),
        waitedMs,
        requestId: req.id,
      };
    }
    const mtime = progressSnapshotMtimeMs(repoRoot);
    if (mtime != null && (mtimeBefore == null || mtime > mtimeBefore + 1)) {
      return {
        via,
        ok: true,
        failOpen: false,
        waitedMs: Date.now() - started,
        requestId: req.id,
        ...snapshotSummary(repoRoot),
      };
    }
    await sleep(Math.min(pollMs, waitMs));
  }

  const error =
    "host progress-scan helper did not refresh snapshot (start: pnpm atom progress-scan --loop / scripts/desk-up.sh)";
  console.warn(`[progress-refresh] fail-open: ${error}`);
  return {
    ...keptResult(repoRoot, error, via),
    waitedMs: Date.now() - started,
    requestId: req.id,
  };
}

function readJsonFile<T>(p: string, parse: (raw: unknown) => T | null): T | null {
  try {
    if (!fs.existsSync(p)) return null;
    return parse(JSON.parse(fs.readFileSync(p, "utf8")) as unknown);
  } catch {
    return null;
  }
}

function asRequest(raw: unknown): ProgressScanRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim() : "";
  const requested_at = typeof o.requested_at === "string" ? o.requested_at : "";
  if (!id) return null;
  return {
    id,
    requested_at,
    source: typeof o.source === "string" && o.source.trim() ? o.source.trim() : "cron",
  };
}

function asAck(raw: unknown): ProgressScanAck | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim() : "";
  if (!id) return null;
  return {
    id,
    scanned_at: typeof o.scanned_at === "string" ? o.scanned_at : "",
    ok: o.ok === true,
    path: typeof o.path === "string" ? o.path : undefined,
    available: typeof o.available === "number" ? o.available : undefined,
    fail_open: typeof o.fail_open === "number" ? o.fail_open : undefined,
    items: typeof o.items === "number" ? o.items : undefined,
    error: typeof o.error === "string" ? o.error : undefined,
  };
}
