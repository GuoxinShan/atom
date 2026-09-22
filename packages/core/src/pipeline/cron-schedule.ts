/**
 * In-process cron/interval poll for Desk serve.
 *
 * Pure schedule + group-union helpers. The HTTP server owns the timer,
 * refreshes progress-snapshot.json (fail-open), then calls executeRun
 * (ingest → extract → Done gate) with the unioned groupIds.
 */

import fs from "node:fs";
import path from "node:path";
import type { TriggerConfig } from "../stubs/webhook-trigger.js";

export const DEFAULT_CRON_EVERY_MINUTES = 15;
export const DEFAULT_CRON_SOURCE = "yzj-ai-advance";
export const DEFAULT_CRON_TZ = "Asia/Shanghai";
export const DEFAULT_CRON_HOURS: [number, number] = [8, 20];
export const DEFAULT_RECENT_DM_LIMIT = 8;

const WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

export type CronPollConfig = {
  id: string;
  pipeline: "run";
  everyMinutes: number;
  source: string;
  weekdaysOnly: boolean;
  /** Local hours [start, end) in `tz`. Default 08:00–20:00. */
  hoursLocal: [number, number];
  tz: string;
  includeRecentDms: boolean;
  recentDmLimit: number;
  /** Refresh `data/progress-snapshot.json` before this tick's extract / Done gate. Default true. */
  progressScan: boolean;
};

export type CronSkipReason = "overlap" | "weekend" | "hours";

export type CronTickPlan =
  | { action: "run"; groupIds: string[] }
  | { action: "skip"; reason: CronSkipReason };

export type ZonedClock = {
  weekday: string;
  hour: number;
  minute: number;
};

export function zonedClock(now: Date, tz: string): ZonedClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return {
    weekday: get("weekday"),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

/** Skip nights / weekends. `hoursLocal` is start-inclusive, end-exclusive. */
export function scheduleSkipReason(now: Date, cfg: CronPollConfig): "weekend" | "hours" | null {
  const clock = zonedClock(now, cfg.tz);
  if (cfg.weekdaysOnly && !WEEKDAYS.has(clock.weekday)) return "weekend";
  const [start, end] = cfg.hoursLocal;
  if (clock.hour < start || clock.hour >= end) return "hours";
  return null;
}

export function isInScheduleWindow(now: Date, cfg: CronPollConfig): boolean {
  return scheduleSkipReason(now, cfg) === null;
}

/**
 * Configured source groups first, then up to `recentDmLimit` private chats
 * that are not already in the configured list.
 */
export function unionGroupIds(
  configured: string[],
  recentPrivate: string[],
  recentDmLimit = DEFAULT_RECENT_DM_LIMIT
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of configured) {
    const id = String(raw ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  const cap = Math.max(0, recentDmLimit);
  let added = 0;
  for (const raw of recentPrivate) {
    if (added >= cap) break;
    const id = String(raw ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    added += 1;
  }
  return out;
}

function isPrivateChatType(value: unknown): boolean {
  if (value === 1 || value === "1") return true;
  if (typeof value !== "string") return false;
  const t = value.trim().toLowerCase();
  return t === "private" || t === "dm" || t === "single";
}

function groupIdFromRow(row: Record<string, unknown>): string {
  const raw = row.groupId ?? row.group_id ?? row.id ?? row.eid ?? row.sessionId;
  return raw != null ? String(raw).trim() : "";
}

function asRecordList(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  }
  if (!payload || typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;
  const nested =
    (Array.isArray(obj.list) && obj.list) ||
    (Array.isArray(obj.groups) && obj.groups) ||
    (Array.isArray(obj.data) && obj.data) ||
    (obj.data &&
      typeof obj.data === "object" &&
      Array.isArray((obj.data as { list?: unknown }).list) &&
      (obj.data as { list: unknown[] }).list) ||
    (obj.data &&
      typeof obj.data === "object" &&
      Array.isArray((obj.data as { groups?: unknown }).groups) &&
      (obj.data as { groups: unknown[] }).groups) ||
    [];
  return (nested as unknown[]).filter(
    (x): x is Record<string, unknown> => !!x && typeof x === "object"
  );
}

/** Parse `yzj-cli im group recent` JSON; keep private chats (`type: 1`). */
export function parseRecentPrivateGroupIds(payload: unknown): string[] {
  let data = payload;
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (!trimmed) return [];
    try {
      data = JSON.parse(trimmed) as unknown;
    } catch {
      const start = trimmed.indexOf("{") >= 0 ? trimmed.indexOf("{") : trimmed.indexOf("[");
      if (start < 0) return [];
      try {
        data = JSON.parse(trimmed.slice(start)) as unknown;
      } catch {
        return [];
      }
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of asRecordList(data)) {
    const type = row.type ?? row.groupType ?? row.chatType ?? row.sessionType ?? row.kind;
    if (!isPrivateChatType(type)) continue;
    const id = groupIdFromRow(row);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function cronTickPlan(input: {
  now: Date;
  config: CronPollConfig;
  inFlight: boolean;
  configuredGroupIds: string[];
  recentPrivateGroupIds: string[];
}): CronTickPlan {
  if (input.inFlight) return { action: "skip", reason: "overlap" };
  const skip = scheduleSkipReason(input.now, input.config);
  if (skip) return { action: "skip", reason: skip };
  const recent = input.config.includeRecentDms ? input.recentPrivateGroupIds : [];
  return {
    action: "run",
    groupIds: unionGroupIds(input.configuredGroupIds, recent, input.config.recentDmLimit),
  };
}

function asHoursLocal(raw: unknown): [number, number] {
  if (!Array.isArray(raw) || raw.length < 2) return DEFAULT_CRON_HOURS;
  const start = Number(raw[0]);
  const end = Number(raw[1]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return DEFAULT_CRON_HOURS;
  const lo = Math.min(23, Math.max(0, Math.trunc(start)));
  const hi = Math.min(24, Math.max(0, Math.trunc(end)));
  if (hi <= lo) return DEFAULT_CRON_HOURS;
  return [lo, hi];
}

export function parseCronPollConfig(trigger: TriggerConfig): CronPollConfig | null {
  if (trigger.kind !== "cron" || trigger.enabled === false) return null;
  if (trigger.pipeline && trigger.pipeline !== "run") return null;
  const c = trigger.config ?? {};
  const every = Number(c.everyMinutes);
  const limit = Number(c.recentDmLimit);
  const source = typeof c.source === "string" && c.source.trim() ? c.source.trim() : DEFAULT_CRON_SOURCE;
  return {
    id: trigger.id,
    pipeline: "run",
    everyMinutes:
      Number.isFinite(every) && every >= 1 ? Math.trunc(every) : DEFAULT_CRON_EVERY_MINUTES,
    source,
    weekdaysOnly: c.weekdaysOnly !== false,
    hoursLocal: asHoursLocal(c.hoursLocal),
    tz: typeof c.tz === "string" && c.tz.trim() ? c.tz.trim() : DEFAULT_CRON_TZ,
    includeRecentDms: c.includeRecentDms !== false,
    recentDmLimit:
      Number.isFinite(limit) && limit >= 0 ? Math.trunc(limit) : DEFAULT_RECENT_DM_LIMIT,
    progressScan: c.progressScan !== false,
  };
}

export function cronPollConfigsFromJson(raw: unknown): CronPollConfig[] {
  const triggers = (raw as { triggers?: TriggerConfig[] } | null)?.triggers;
  if (!Array.isArray(triggers)) return [];
  return triggers
    .map((t) => parseCronPollConfig(t))
    .filter((t): t is CronPollConfig => t !== null);
}

export function loadCronPollConfigs(repoRoot: string): CronPollConfig[] {
  const pth = path.join(repoRoot, "data", "triggers.json");
  if (!fs.existsSync(pth)) return [];
  try {
    return cronPollConfigsFromJson(JSON.parse(fs.readFileSync(pth, "utf8")));
  } catch (err) {
    console.warn(`[cron] failed to read data/triggers.json: ${(err as Error).message}`);
    return [];
  }
}
