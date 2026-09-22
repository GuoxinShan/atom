import { listRecentYzjPrivateChats } from "@atom/adapters";
import {
  cronTickPlan,
  loadCronPollConfigs,
  refreshProgressSnapshot,
  scheduleSkipReason,
  type CronPollConfig,
  type ProgressRefreshResult,
} from "@atom/core";
import type { Daemon } from "./context.js";
import { executeRun, groupAllowlistFor } from "./routes.js";

export type CronSchedulerHandle = {
  stop: () => void;
};

export type CronTickDeps = {
  refreshProgress?: (repoRoot: string) => Promise<ProgressRefreshResult>;
  executeRun?: typeof executeRun;
  listRecentDms?: typeof listRecentYzjPrivateChats;
};

/**
 * Interval poller started with the Desk HTTP server.
 * Replaces launchd `com.guoxinshan.atom.morning-run` / `atom-morning-run.sh`.
 * Serve itself is `docker compose up` or `pnpm serve` — not a login item.
 * Toggle via `data/triggers.json` (`kind: "cron"`). Set `ATOM_CRON=0` to disable.
 *
 * Each in-window tick refreshes `data/progress-snapshot.json` (host git or
 * Mac helper via the mounted data/ request file) then runs extract → Done gate.
 * Scan failure is fail-open: log and keep the last snapshot; poll still runs.
 */
export function startCronScheduler(
  daemon: Daemon,
  deps: CronTickDeps = {}
): CronSchedulerHandle | null {
  if (process.env.ATOM_CRON === "0" || process.env.ATOM_CRON === "false") {
    return null;
  }
  const configs = loadCronPollConfigs(daemon.repoRoot);
  if (configs.length === 0) return null;

  const timers: ReturnType<typeof setInterval>[] = [];
  const delays: ReturnType<typeof setTimeout>[] = [];

  for (const cfg of configs) {
    const inFlight = { value: false };
    const tick = () => void runCronTick(daemon, cfg, inFlight, deps);
    const ms = cfg.everyMinutes * 60 * 1000;
    // First tick shortly after listen so the HTTP server is up; then interval.
    delays.push(setTimeout(tick, 1500));
    timers.push(setInterval(tick, ms));
    console.log(
      `[cron:${cfg.id}] started every=${cfg.everyMinutes}m tz=${cfg.tz} hours=${cfg.hoursLocal[0]}-${cfg.hoursLocal[1]} weekdaysOnly=${cfg.weekdaysOnly} source=${cfg.source} progressScan=${cfg.progressScan}`
    );
  }

  return {
    stop: () => {
      for (const t of delays) clearTimeout(t);
      for (const t of timers) clearInterval(t);
    },
  };
}

export async function runCronTick(
  daemon: Daemon,
  cfg: CronPollConfig,
  inFlight: { value: boolean },
  deps: CronTickDeps = {}
): Promise<"overlap" | "skip" | "ok" | "fail"> {
  const now = new Date();
  if (inFlight.value) {
    console.log(`[cron:${cfg.id}] skip overlap`);
    return "overlap";
  }
  const windowSkip = scheduleSkipReason(now, cfg);
  if (windowSkip) {
    console.log(`[cron:${cfg.id}] skip ${windowSkip}`);
    return "skip";
  }

  inFlight.value = true;
  try {
    if (cfg.progressScan !== false) {
      await refreshProgressForTick(daemon, cfg, deps);
    }

    const configured = groupAllowlistFor(daemon, cfg.source);
    let recent: string[] = [];
    let recentDms = "off";
    const listRecent = deps.listRecentDms ?? listRecentYzjPrivateChats;
    if (cfg.includeRecentDms) {
      try {
        const entry = daemon.registry.loadConfig().sources.find((s) => s.id === cfg.source);
        const cli = typeof entry?.cli === "string" ? entry.cli : undefined;
        recent = await listRecent({ cli });
        recentDms = String(recent.length);
      } catch (err) {
        recentDms = "fail";
        console.warn(`[cron:${cfg.id}] recent DMs failed: ${(err as Error).message}`);
      }
    }

    const plan = cronTickPlan({
      now,
      config: cfg,
      inFlight: false,
      configuredGroupIds: configured,
      recentPrivateGroupIds: recent,
    });
    if (plan.action === "skip") {
      console.log(`[cron:${cfg.id}] skip ${plan.reason}`);
      return "skip";
    }

    const run = deps.executeRun ?? executeRun;
    const result = await run(daemon, {
      source: cfg.source,
      groupIds: plan.groupIds,
    });
    console.log(
      `[cron:${cfg.id}] ok source=${result.source} groups=${plan.groupIds.length} ingested=${result.ingested} seeded=${result.seeded} proposed=${result.proposed} recent_dms=${recentDms}`
    );
    return "ok";
  } catch (err) {
    console.log(`[cron:${cfg.id}] fail ${(err as Error).message}`);
    return "fail";
  } finally {
    inFlight.value = false;
  }
}

async function refreshProgressForTick(
  daemon: Daemon,
  cfg: CronPollConfig,
  deps: CronTickDeps
): Promise<void> {
  try {
    const refresh = deps.refreshProgress ?? ((root: string) => refreshProgressSnapshot(root, { source: `cron:${cfg.id}` }));
    const progress = await refresh(daemon.repoRoot);
    const extra = progress.error ? ` error=${progress.error}` : "";
    console.log(
      `[cron:${cfg.id}] progress via=${progress.via} ok=${progress.ok} fail_open=${progress.failOpen} items=${progress.items ?? "-"} available=${progress.available ?? "-"}${extra}`
    );
  } catch (err) {
    // refreshProgressSnapshot is fail-open; this is a last belt if a mock throws.
    console.warn(
      `[cron:${cfg.id}] progress-scan failed (fail-open, keeping last snapshot): ${(err as Error).message}`
    );
  }
}
