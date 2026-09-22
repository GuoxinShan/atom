/**
 * Host-side progress-scan helper.
 *
 * Docker Desk cannot see Mac git checkouts. This process stays on the Mac:
 * watches `data/progress-scan.request.json` (compose mounts `./data`), scans
 * atom/yzj/ai-advance, writes `data/progress-snapshot.json` + ack.
 *
 * Also ticks on the same 15-minute weekday window as `poll-yzj-15m`, and
 * optionally serves POST /progress-scan on 127.0.0.1:8788 for health / curl.
 *
 * Not a LaunchAgent. Start with `pnpm atom progress-scan --loop` or
 * `scripts/desk-up.sh` (compose + this helper).
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_CRON_EVERY_MINUTES,
  DEFAULT_CRON_HOURS,
  DEFAULT_CRON_TZ,
  loadCronPollConfigs,
  scheduleSkipReason,
  type CronPollConfig,
} from "./cron-schedule.js";
import { runProgressScan, type ProgressScanResult } from "./progress-scan.js";
import {
  DEFAULT_PROGRESS_SCAN_POLL_MS,
  DEFAULT_PROGRESS_SCAN_PORT,
  progressScanAckPath,
  progressScanRequestPath,
  readProgressScanRequest,
  writeProgressScanAck,
  type ProgressScanAck,
  type ProgressScanRequest,
} from "./progress-refresh.js";

export type ProgressScanHostHandle = {
  stop: () => void;
  port: number | null;
};

export type ProgressScanHostOpts = {
  port?: number | null;
  bind?: string;
  scan?: (repoRoot: string) => Promise<ProgressScanResult>;
  now?: () => Date;
  /** Skip HTTP (tests / file-watch only). Default listens. */
  http?: boolean;
  /** Skip the 15m safety-net interval (tests). */
  interval?: boolean;
};

const FALLBACK_CRON: CronPollConfig = {
  id: "poll-yzj-15m",
  pipeline: "run",
  everyMinutes: DEFAULT_CRON_EVERY_MINUTES,
  source: "yzj-ai-advance",
  weekdaysOnly: true,
  hoursLocal: DEFAULT_CRON_HOURS,
  tz: DEFAULT_CRON_TZ,
  includeRecentDms: true,
  recentDmLimit: 8,
  progressScan: true,
};

function hostPort(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ATOM_PROGRESS_SCAN_PORT);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_PROGRESS_SCAN_PORT;
}

function hostBind(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.ATOM_PROGRESS_SCAN_BIND ?? "").trim();
  return raw || "127.0.0.1";
}

export function ackFromScan(
  req: ProgressScanRequest | { id: string },
  result: ProgressScanResult,
  now = new Date()
): ProgressScanAck {
  return {
    id: req.id,
    scanned_at: now.toISOString(),
    ok: true,
    path: result.path,
    available: result.available,
    fail_open: result.failOpen,
    items: result.items,
  };
}

export async function fulfillProgressScanRequest(
  repoRoot: string,
  opts?: {
    scan?: (repoRoot: string) => Promise<ProgressScanResult>;
    request?: ProgressScanRequest | null;
    now?: Date;
  }
): Promise<ProgressScanAck> {
  const req = opts?.request ?? readProgressScanRequest(repoRoot) ?? {
    id: "manual",
    requested_at: (opts?.now ?? new Date()).toISOString(),
    source: "host",
  };
  const scan = opts?.scan ?? ((root: string) => runProgressScan(root));
  try {
    const result = await scan(repoRoot);
    const ack = ackFromScan(req, result, opts?.now ?? new Date());
    writeProgressScanAck(repoRoot, ack);
    return ack;
  } catch (err) {
    const ack: ProgressScanAck = {
      id: req.id,
      scanned_at: (opts?.now ?? new Date()).toISOString(),
      ok: false,
      error: (err as Error).message || String(err),
    };
    writeProgressScanAck(repoRoot, ack);
    console.warn(`[progress-scan-host] scan failed (Desk keeps last snapshot): ${ack.error}`);
    return ack;
  }
}

export function startProgressScanHost(
  repoRoot: string,
  opts: ProgressScanHostOpts = {}
): ProgressScanHostHandle {
  const inFlight = { value: false };
  let pending = false;
  let lastHandledId = "";
  const scanFn = opts.scan;
  const nowFn = opts.now ?? (() => new Date());
  const watchers: fs.FSWatcher[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];
  const delays: ReturnType<typeof setTimeout>[] = [];
  let server: http.Server | null = null;
  let listenPort: number | null = null;

  const run = async (reason: string) => {
    if (inFlight.value) {
      pending = true;
      console.log(`[progress-scan-host] skip overlap (${reason}); queued`);
      return;
    }
    inFlight.value = true;
    try {
      do {
        pending = false;
        console.log(`[progress-scan-host] scan (${reason})`);
        await fulfillProgressScanRequest(repoRoot, { scan: scanFn, now: nowFn() });
      } while (pending);
    } finally {
      inFlight.value = false;
    }
  };

  const onRequestFile = () => {
    const req = readProgressScanRequest(repoRoot);
    if (!req || req.id === lastHandledId) return;
    lastHandledId = req.id;
    void run(`request ${req.id} from ${req.source}`);
  };

  const dataDir = path.dirname(progressScanRequestPath(repoRoot));
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    watchers.push(
      fs.watch(dataDir, (_event, filename) => {
        if (filename && String(filename) === "progress-scan.request.json") onRequestFile();
      })
    );
  } catch {
    /* watch the file when it appears via poll */
  }
  timers.push(setInterval(onRequestFile, Math.max(500, DEFAULT_PROGRESS_SCAN_POLL_MS * 4)));

  const useHttp = opts.http !== false;
  const port = opts.port === null ? null : opts.port ?? hostPort();
  const bind = opts.bind ?? hostBind();
  if (useHttp && port != null) {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${bind}:${port}`);
      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, service: "atom-progress-scan-host" }));
        return;
      }
      if (req.method === "POST" && (url.pathname === "/progress-scan" || url.pathname === "/")) {
        try {
          const ack = await fulfillProgressScanRequest(repoRoot, { scan: scanFn, now: nowFn() });
          res.writeHead(ack.ok ? 200 : 500, { "content-type": "application/json" });
          res.end(JSON.stringify(ack));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
        }
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(port, bind, () => {
      listenPort = port;
      console.log(`[progress-scan-host] listening http://${bind}:${port} (POST /progress-scan)`);
    });
    server.on("error", (err) => {
      console.warn(`[progress-scan-host] HTTP listen failed: ${(err as Error).message} — file watch still runs`);
    });
  }

  if (opts.interval !== false) {
    const cfg = loadCronPollConfigs(repoRoot)[0] ?? FALLBACK_CRON;
    const ms = cfg.everyMinutes * 60 * 1000;
    const tick = () => {
      const skip = scheduleSkipReason(nowFn(), cfg);
      if (skip) {
        console.log(`[progress-scan-host] skip ${skip}`);
        return;
      }
      void run(`interval ${cfg.everyMinutes}m`);
    };
    delays.push(setTimeout(() => void run("startup"), 400));
    timers.push(setInterval(tick, ms));
    console.log(
      `[progress-scan-host] started every=${cfg.everyMinutes}m tz=${cfg.tz} hours=${cfg.hoursLocal[0]}-${cfg.hoursLocal[1]} watch=${progressScanRequestPath(repoRoot)} ack=${progressScanAckPath(repoRoot)}`
    );
  } else {
    console.log(`[progress-scan-host] file-watch only ${progressScanRequestPath(repoRoot)}`);
  }

  return {
    port: listenPort ?? (useHttp ? port : null),
    stop: () => {
      for (const t of delays) clearTimeout(t);
      for (const t of timers) clearInterval(t);
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* ignore */
        }
      }
      server?.close();
    },
  };
}
