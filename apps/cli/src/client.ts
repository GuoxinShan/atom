import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { resolveRepoRoot } from "./root.js";

export function defaultApiPort(): string {
  return process.env.ATOM_WEB_PORT ?? "8787";
}

export function apiBase(): string {
  const raw = process.env.ATOM_API_BASE ?? `http://127.0.0.1:${defaultApiPort()}`;
  return raw.replace(/\/$/, "");
}

export class ApiDownError extends Error {
  constructor(base = apiBase()) {
    super(`ATOM API is not running at ${base}. Start it with \`pnpm atom serve\` (or \`pnpm web\`).`);
    this.name = "ApiDownError";
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ApiResponse<T = Record<string, unknown>> = {
  ok: boolean;
  status: number;
  data: T;
};

function isUnreachable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; cause?: { code?: string }; name?: string; message?: string };
  const code = e.code ?? e.cause?.code;
  if (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EHOSTUNREACH" ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return true;
  }
  const msg = String(e.message ?? err);
  return /fetch failed|ECONNREFUSED|Failed to fetch|network/i.test(msg);
}

let autoStartAttempted = false;

export function spawnServe(opts?: { detached?: boolean }): ChildProcess {
  const repoRoot = resolveRepoRoot();
  const tsx = path.join(repoRoot, "node_modules", ".bin", "tsx");
  const server = path.join(repoRoot, "apps", "web", "src", "server.ts");
  if (!fs.existsSync(tsx)) {
    throw new Error("tsx not found; run pnpm install at the repo root");
  }
  if (!fs.existsSync(server)) {
    throw new Error(`web server not found at ${server}`);
  }
  const child = spawn(tsx, [server], {
    cwd: repoRoot,
    env: process.env,
    stdio: opts?.detached ? "ignore" : "inherit",
    detached: Boolean(opts?.detached),
  });
  if (opts?.detached) child.unref();
  return child;
}

export async function runServe(): Promise<void> {
  const child = spawnServe({ detached: false });
  const stop = (signal: NodeJS.Signals) => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        process.exit(0);
      }
      process.exit(code ?? 0);
      resolve();
    });
  });
}

async function pingHealth(timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase()}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean; service?: string };
    return data.ok === true && data.service === "atom-desk";
  } catch {
    return false;
  }
}

async function autoStartOnce(): Promise<boolean> {
  if (autoStartAttempted) return false;
  autoStartAttempted = true;
  if (process.env.ATOM_API_AUTO_START !== "1") return false;
  try {
    spawnServe({ detached: true });
  } catch {
    return false;
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await pingHealth(500)) {
      console.error(`started ATOM serve at ${apiBase()}`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function api<T = Record<string, unknown>>(
  method: string,
  pathname: string,
  body?: unknown
): Promise<ApiResponse<T>> {
  const url = `${apiBase()}${pathname}`;
  const isGet = method === "GET" || method === "HEAD";
  try {
    const res = await fetch(url, {
      method,
      headers: isGet ? undefined : { "content-type": "application/json" },
      body: body === undefined || isGet ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(isGet ? 15_000 : 10 * 60_000),
    });
    const text = await res.text();
    let data: T;
    try {
      data = (text ? JSON.parse(text) : {}) as T;
    } catch {
      throw new ApiError(text || res.statusText, res.status, text);
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (isUnreachable(err)) {
      if (await autoStartOnce()) {
        return api<T>(method, pathname, body);
      }
      throw new ApiDownError();
    }
    throw err;
  }
}

export async function apiOk<T = Record<string, unknown>>(
  method: string,
  pathname: string,
  body?: unknown
): Promise<T> {
  const res = await api<T>(method, pathname, body);
  if (res.ok) return res.data;
  const data = res.data as { error?: string; message?: string };
  const msg = data?.error || data?.message || `HTTP ${res.status}`;
  throw new ApiError(String(msg), res.status, res.data);
}
