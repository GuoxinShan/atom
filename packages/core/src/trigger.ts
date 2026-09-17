import type { Trigger } from "./interfaces.ts";

/** Stage-1 trigger is the CLI. No webhook / cron server. */
export const MANUAL_TRIGGER: Trigger = { id: "cli", kind: "manual" };
