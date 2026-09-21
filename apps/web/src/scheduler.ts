import { listRecentYzjPrivateChats } from "@atom/adapters";
import {
  cronTickPlan,
  loadCronPollConfigs,
  scheduleSkipReason,
  type CronPollConfig,
} from "@atom/core";
import type { Daemon } from "./context.js";
import { executeRun, groupAllowlistFor } from "./routes.js";

export type CronSchedulerHandle = {
  stop: () => void;
};

/**
 * Interval poller started with the Desk HTTP server.
 * Replaces launchd `com.guoxinshan.atom.morning-run` / `atom-morning-run.sh`.
 * Toggle via `data/triggers.json` (`kind: "cron"`). Set `ATOM_CRON=0` to disable.
 */
export function startCronScheduler(daemon: Daemon): CronSchedulerHandle | null {
  if (process.env.ATOM_CRON === "0" || process.env.ATOM_CRON === "false") {
    return null;
  }
  const configs = loadCronPollConfigs(daemon.repoRoot);
  if (configs.length === 0) return null;

  const timers: ReturnType<typeof setInterval>[] = [];
  const delays: ReturnType<typeof setTimeout>[] = [];

  for (const cfg of configs) {
    const inFlight = { value: false };
    const tick = () => void runCronTick(daemon, cfg, inFlight);
    const ms = cfg.everyMinutes * 60 * 1000;
    // First tick shortly after listen so the HTTP server is up; then interval.
    delays.push(setTimeout(tick, 1500));
    timers.push(setInterval(tick, ms));
    console.log(
      `[cron:${cfg.id}] started every=${cfg.everyMinutes}m tz=${cfg.tz} hours=${cfg.hoursLocal[0]}-${cfg.hoursLocal[1]} weekdaysOnly=${cfg.weekdaysOnly} source=${cfg.source}`
    );
  }

  return {
    stop: () => {
      for (const t of delays) clearTimeout(t);
      for (const t of timers) clearInterval(t);
    },
  };
}

async function runCronTick(
  daemon: Daemon,
  cfg: CronPollConfig,
  inFlight: { value: boolean }
): Promise<void> {
  const now = new Date();
  if (inFlight.value) {
    console.log(`[cron:${cfg.id}] skip overlap`);
    return;
  }
  const windowSkip = scheduleSkipReason(now, cfg);
  if (windowSkip) {
    console.log(`[cron:${cfg.id}] skip ${windowSkip}`);
    return;
  }

  inFlight.value = true;
  try {
    const configured = groupAllowlistFor(daemon, cfg.source);
    let recent: string[] = [];
    let recentDms = "off";
    if (cfg.includeRecentDms) {
      try {
        const entry = daemon.registry.loadConfig().sources.find((s) => s.id === cfg.source);
        const cli = typeof entry?.cli === "string" ? entry.cli : undefined;
        recent = await listRecentYzjPrivateChats({ cli });
        recentDms = String(recent.length);
      } catch {
        recentDms = "fail";
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
      return;
    }

    const result = await executeRun(daemon, {
      source: cfg.source,
      groupIds: plan.groupIds,
    });
    console.log(
      `[cron:${cfg.id}] ok source=${result.source} groups=${plan.groupIds.length} ingested=${result.ingested} seeded=${result.seeded} proposed=${result.proposed} recent_dms=${recentDms}`
    );
  } catch (err) {
    console.log(`[cron:${cfg.id}] fail ${(err as Error).message}`);
  } finally {
    inFlight.value = false;
  }
}
