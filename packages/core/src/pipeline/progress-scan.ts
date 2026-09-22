/**
 * Host-side repo progress scan.
 *
 * Reads `atom` / `yzj` / `ai-advance` from `data/workspaces.json` (paths already
 * there — do not invent new ones). Writes `data/progress-snapshot.json` for the
 * Done gate. Docker Desk cannot see host git — the 15-minute cron asks the Mac
 * helper (`pnpm atom progress-scan --loop` / `scripts/desk-up.sh`) to scan.
 * One-shot: `pnpm atom progress-scan` on the Mac, not `docker compose exec`.
 *
 * Signals (bounded): merged PRs + closed issues via `gh` when authenticated,
 * else `git log` on main|master. Path missing / not a git repo / command fail
 * → that workspace is fail-open (Done gate will not drop on repo evidence).
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { WorkspaceEntry, WorkspacesFile } from "../agents/lead.js";
import {
  loadProgressSnapshot,
  preserveUnavailableWorkspaces,
  PROGRESS_WORKSPACE_IDS,
  writeProgressSnapshot,
  type ProgressItem,
  type ProgressSnapshot,
  type ProgressWorkspaceScan,
} from "./progress-snapshot.js";

export const PROGRESS_SINCE_DAYS = 90;
export const PROGRESS_MAX_COMMITS = 80;
export const PROGRESS_MAX_GH = 40;
const BODY_CAP = 480;
const CMD_TIMEOUT_MS = 20_000;

export type RunCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  error?: string;
};

export type RunCommand = (
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number }
) => Promise<RunCommandResult>;

export type ProgressScanResult = {
  path: string;
  snapshot: ProgressSnapshot;
  available: number;
  failOpen: number;
  items: number;
};

export function defaultRunCommand(): RunCommand {
  return (file, args, opts) =>
    new Promise((resolve) => {
      const child = spawn(file, args, {
        cwd: opts.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({
          code: 1,
          stdout,
          stderr,
          error: `timeout after ${opts.timeoutMs ?? CMD_TIMEOUT_MS}ms`,
        });
      }, opts.timeoutMs ?? CMD_TIMEOUT_MS);
      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        const code = (err as NodeJS.ErrnoException).code;
        resolve({
          code: 1,
          stdout,
          stderr: stderr || err.message,
          error: code === "ENOENT" ? `${file} not found` : err.message,
        });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
}

function clipBody(s: string | undefined): string | undefined {
  const t = (s ?? "").trim();
  if (!t) return undefined;
  return t.length > BODY_CAP ? `${t.slice(0, BODY_CAP)}…` : t;
}

function isoDateDaysAgo(days: number, now: Date): string {
  const d = new Date(now.getTime() - days * 86400_000);
  return d.toISOString().slice(0, 10);
}

export function loadProgressWorkspaces(repoRoot: string): WorkspaceEntry[] {
  const p = path.join(repoRoot, "data", "workspaces.json");
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8")) as WorkspacesFile;
    const all = Array.isArray(data.workspaces) ? data.workspaces : [];
    return all.filter((w) => (PROGRESS_WORKSPACE_IDS as readonly string[]).includes(w.id));
  } catch {
    return [];
  }
}

function failWorkspace(id: string, wsPath: string, reason: string): ProgressWorkspaceScan {
  return {
    id,
    path: wsPath,
    available: false,
    fail_open: true,
    reason,
    items: [],
  };
}

export function parseGhList(stdout: string, kind: "pr" | "issue", workspaceId: string): ProgressItem[] {
  try {
    const raw = JSON.parse(stdout) as unknown;
    if (!Array.isArray(raw)) return [];
    const out: ProgressItem[] = [];
    for (const row of raw) {
      if (!row || typeof row !== "object") continue;
      const o = row as Record<string, unknown>;
      const title = typeof o.title === "string" ? o.title.trim() : "";
      if (!title) continue;
      const body = clipBody(typeof o.body === "string" ? o.body : undefined);
      const url = typeof o.url === "string" ? o.url : undefined;
      const at =
        typeof o.mergedAt === "string"
          ? o.mergedAt
          : typeof o.closedAt === "string"
            ? o.closedAt
            : undefined;
      const number = typeof o.number === "number" && Number.isFinite(o.number) ? o.number : undefined;
      out.push({
        kind,
        title,
        ...(body ? { body } : {}),
        ...(url ? { url } : {}),
        ...(number != null ? { number } : {}),
        ...(at ? { at } : {}),
        workspace_id: workspaceId,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** `git log --pretty=%H%x1f%s%x1f%b%x1e` */
export function parseGitLog(stdout: string, workspaceId: string): ProgressItem[] {
  const out: ProgressItem[] = [];
  const records = stdout.split("\x1e");
  for (const rec of records) {
    const t = rec.replace(/^\n+/, "").trimEnd();
    if (!t.trim()) continue;
    const [sha, subject, ...rest] = t.split("\x1f");
    const title = (subject ?? "").trim();
    if (!sha?.trim() || !title) continue;
    const body = clipBody(rest.join("\x1f"));
    out.push({
      kind: "commit",
      title,
      ...(body ? { body } : {}),
      sha: sha.trim(),
      workspace_id: workspaceId,
    });
  }
  return out;
}

async function gitOk(run: RunCommand, cwd: string): Promise<boolean> {
  const r = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeoutMs: 8000 });
  return r.code === 0 && r.stdout.trim() === "true";
}

async function defaultBranch(run: RunCommand, cwd: string): Promise<string | undefined> {
  const head = await run("git", ["rev-parse", "--abbrev-ref", "origin/HEAD"], {
    cwd,
    timeoutMs: 8000,
  });
  if (head.code === 0) {
    const name = head.stdout.trim().replace(/^origin\//, "");
    if (name && name !== "HEAD") return name;
  }
  for (const cand of ["main", "master"]) {
    const r = await run("git", ["rev-parse", "--verify", `origin/${cand}`], { cwd, timeoutMs: 8000 });
    if (r.code === 0) return cand;
  }
  for (const cand of ["main", "master"]) {
    const r = await run("git", ["rev-parse", "--verify", cand], { cwd, timeoutMs: 8000 });
    if (r.code === 0) return cand;
  }
  return undefined;
}

async function scanGh(
  run: RunCommand,
  cwd: string,
  workspaceId: string,
  sinceDay: string
): Promise<ProgressItem[]> {
  const prs = await run(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "merged",
      "--limit",
      String(PROGRESS_MAX_GH),
      "--search",
      `merged:>=${sinceDay}`,
      "--json",
      "title,body,url,mergedAt,number",
    ],
    { cwd }
  );
  const issues = await run(
    "gh",
    [
      "issue",
      "list",
      "--state",
      "closed",
      "--limit",
      String(PROGRESS_MAX_GH),
      "--search",
      `closed:>=${sinceDay}`,
      "--json",
      "title,body,url,closedAt,number",
    ],
    { cwd }
  );
  const items: ProgressItem[] = [];
  if (prs.code === 0) items.push(...parseGhList(prs.stdout, "pr", workspaceId));
  if (issues.code === 0) items.push(...parseGhList(issues.stdout, "issue", workspaceId));
  return items;
}

async function scanGitLog(
  run: RunCommand,
  cwd: string,
  workspaceId: string,
  sinceDays: number
): Promise<ProgressItem[]> {
  const branch = await defaultBranch(run, cwd);
  const args = [
    "log",
    ...(branch ? [branch] : []),
    `--since=${sinceDays} days ago`,
    `--max-count=${PROGRESS_MAX_COMMITS}`,
    "--pretty=format:%H%x1f%s%x1f%b%x1e",
  ];
  const r = await run("git", args, { cwd });
  if (r.code !== 0) {
    if (!branch) return [];
    const fallback = await run(
      "git",
      [
        "log",
        `--since=${sinceDays} days ago`,
        `--max-count=${PROGRESS_MAX_COMMITS}`,
        "--pretty=format:%H%x1f%s%x1f%b%x1e",
      ],
      { cwd }
    );
    if (fallback.code !== 0) return [];
    return parseGitLog(fallback.stdout, workspaceId);
  }
  return parseGitLog(r.stdout, workspaceId);
}

export async function scanOneWorkspace(
  ws: WorkspaceEntry,
  opts: { run: RunCommand; now: Date; sinceDays: number }
): Promise<ProgressWorkspaceScan> {
  const wsPath = ws.path;
  if (!wsPath) return failWorkspace(ws.id, wsPath, "path missing");
  try {
    if (!fs.existsSync(wsPath)) return failWorkspace(ws.id, wsPath, "path missing");
  } catch {
    return failWorkspace(ws.id, wsPath, "path missing");
  }

  const inside = await gitOk(opts.run, wsPath);
  if (!inside) return failWorkspace(ws.id, wsPath, "not a git repo / git not visible");

  const sinceDay = isoDateDaysAgo(opts.sinceDays, opts.now);
  let items: ProgressItem[] = [];
  try {
    const ghItems = await scanGh(opts.run, wsPath, ws.id, sinceDay);
    items = ghItems;
  } catch (err) {
    return failWorkspace(ws.id, wsPath, `gh scan failed: ${(err as Error).message}`);
  }
  try {
    const commits = await scanGitLog(opts.run, wsPath, ws.id, opts.sinceDays);
    items = [...items, ...commits];
  } catch (err) {
    if (!items.length) {
      return failWorkspace(ws.id, wsPath, `git log failed: ${(err as Error).message}`);
    }
  }

  return {
    id: ws.id,
    path: wsPath,
    available: true,
    fail_open: false,
    items,
  };
}

export async function runProgressScan(
  repoRoot: string,
  opts?: {
    run?: RunCommand;
    now?: Date;
    sinceDays?: number;
    workspaces?: WorkspaceEntry[];
  }
): Promise<ProgressScanResult> {
  const now = opts?.now ?? new Date();
  const sinceDays = opts?.sinceDays ?? PROGRESS_SINCE_DAYS;
  const run = opts?.run ?? defaultRunCommand();
  const listed = opts?.workspaces ?? loadProgressWorkspaces(repoRoot);

  const scans: ProgressWorkspaceScan[] = [];
  if (!listed.length) {
    for (const id of PROGRESS_WORKSPACE_IDS) {
      scans.push(failWorkspace(id, "", "workspaces.json missing this id"));
    }
  } else {
    const have = new Set(listed.map((w) => w.id));
    for (const ws of listed) {
      scans.push(await scanOneWorkspace(ws, { run, now, sinceDays }));
    }
    for (const id of PROGRESS_WORKSPACE_IDS) {
      if (!have.has(id)) scans.push(failWorkspace(id, "", "workspaces.json missing this id"));
    }
  }

  const next: ProgressSnapshot = {
    version: 1,
    generated_at: now.toISOString(),
    source: "progress-scan",
    since_days: sinceDays,
    workspaces: scans,
  };
  const snapshot = preserveUnavailableWorkspaces(next, loadProgressSnapshot(repoRoot));
  const outPath = writeProgressSnapshot(repoRoot, snapshot);
  const available = snapshot.workspaces.filter((w) => w.available).length;
  const failOpen = snapshot.workspaces.filter((w) => w.fail_open).length;
  const items = snapshot.workspaces.reduce((n, w) => n + w.items.length, 0);
  console.log(
    `[progress-scan] wrote ${outPath} available=${available} fail_open=${failOpen} items=${items}`
  );
  for (const w of snapshot.workspaces) {
    const mark = w.available ? "ok" : "fail-open";
    console.log(
      `[progress-scan] ${w.id} ${mark} path=${w.path || "-"} items=${w.items.length}${
        w.reason ? ` (${w.reason})` : ""
      }`
    );
  }
  return { path: outPath, snapshot, available, failOpen, items };
}
