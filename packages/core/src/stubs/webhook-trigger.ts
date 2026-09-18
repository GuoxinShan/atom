/**
 * Inbound webhook Trigger seam (Stage stub).
 * Later: HTTP server maps POST /hooks/:id → pipeline run.
 * Config lives in data/triggers.json.
 */
export type TriggerKind = "manual" | "cron" | "webhook" | "hook" | "im_event" | "fs_watch" | "atom_event";

export interface TriggerConfig {
  id: string;
  kind: TriggerKind;
  enabled: boolean;
  pipeline: "ingest" | "extract" | "run" | "handoff";
  config?: Record<string, unknown>;
}
