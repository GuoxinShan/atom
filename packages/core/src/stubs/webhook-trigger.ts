/**
 * Trigger seam. Config lives in data/triggers.json.
 * `kind: "cron"` is started in-process with Desk serve (see pipeline/cron-schedule.ts).
 */
export type TriggerKind = "manual" | "cron" | "webhook" | "hook" | "im_event" | "fs_watch" | "atom_event";

export interface TriggerConfig {
  id: string;
  kind: TriggerKind;
  enabled: boolean;
  pipeline: "ingest" | "extract" | "run" | "handoff";
  config?: Record<string, unknown>;
}
