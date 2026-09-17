import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  TRIGGER_KINDS,
  TRIGGER_PIPELINES,
  type TriggerConfig,
  type TriggerKind,
} from "./interfaces.ts";

export const TriggerConfigSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(TRIGGER_KINDS),
  enabled: z.boolean().default(true),
  pipeline: z.enum(TRIGGER_PIPELINES).default("run"),
  config: z.record(z.unknown()).default({}),
});

export const TriggerRegistryFileSchema = z.object({
  version: z.literal(1).default(1),
  triggers: z.array(TriggerConfigSchema),
});

export type TriggerRegistry = z.infer<typeof TriggerRegistryFileSchema>;

export const DEFAULT_TRIGGER_REGISTRY: TriggerRegistry = {
  version: 1,
  triggers: [
    { id: "cli", kind: "manual", enabled: true, pipeline: "run", config: {} },
    {
      id: "daily",
      kind: "cron",
      enabled: false,
      pipeline: "run",
      config: { expr: "0 8 * * *" },
    },
    {
      id: "inbound",
      kind: "webhook",
      enabled: false,
      pipeline: "ingest",
      config: { path: "/hooks/atom" },
    },
    {
      id: "yzj-hook",
      kind: "im_event",
      enabled: false,
      pipeline: "ingest",
      config: { sourceId: "yzj" },
    },
    {
      id: "on-ingested",
      kind: "atom_event",
      enabled: false,
      pipeline: "extract",
      config: { type: "message_ingested", auto: false },
    },
    {
      id: "on-proposed",
      kind: "atom_event",
      enabled: false,
      pipeline: "approve",
      config: { type: "candidate_proposed", auto: false },
    },
  ],
};

export const MANUAL_TRIGGER: TriggerConfig = DEFAULT_TRIGGER_REGISTRY.triggers[0]!;

export function loadTriggerRegistry(runtimePath: string, seedPath?: string): TriggerRegistry {
  mkdirSync(dirname(runtimePath), { recursive: true });
  if (!existsSync(runtimePath)) {
    if (seedPath && existsSync(seedPath)) copyFileSync(seedPath, runtimePath);
    else saveTriggerRegistry(runtimePath, DEFAULT_TRIGGER_REGISTRY);
  }
  const raw = JSON.parse(readFileSync(runtimePath, "utf8")) as unknown;
  const loaded = normalize(raw);
  const seed = seedPath && existsSync(seedPath)
    ? normalize(JSON.parse(readFileSync(seedPath, "utf8")) as unknown)
    : DEFAULT_TRIGGER_REGISTRY;
  const ids = new Set(loaded.triggers.map((t) => t.id));
  const extra = seed.triggers.filter((t) => !ids.has(t.id));
  if (extra.length === 0) return loaded;
  const merged: TriggerRegistry = { version: 1, triggers: [...loaded.triggers, ...extra] };
  saveTriggerRegistry(runtimePath, merged);
  return merged;
}

export function saveTriggerRegistry(path: string, registry: TriggerRegistry): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(TriggerRegistryFileSchema.parse({ version: 1, triggers: registry.triggers }), null, 2)}\n`,
    "utf8",
  );
}

export function listTriggerConfigs(path: string, seedPath?: string): TriggerConfig[] {
  return loadTriggerRegistry(path, seedPath).triggers;
}

export function resolveManualTrigger(path: string, seedPath?: string): TriggerConfig {
  const rows = listTriggerConfigs(path, seedPath);
  const manual = rows.find((t) => t.kind === "manual" && t.enabled) ?? rows.find((t) => t.kind === "manual");
  return manual ?? MANUAL_TRIGGER;
}

/** Stage-1 only binds `manual`. Other kinds stay in the registry until a receiver exists. */
export function describeUnboundKind(kind: TriggerKind): string {
  if (kind === "manual") return "bound: CLI `atom run|ingest|extract`";
  if (kind === "atom_event") return "bound: observe after append (human gates apply)";
  if (kind === "hook") return "stub unless config.on=atom (same as atom_event)";
  return "stub — not bound in Stage-1";
}

function normalize(raw: unknown): TriggerRegistry {
  if (!raw || typeof raw !== "object") return DEFAULT_TRIGGER_REGISTRY;
  const obj = raw as { triggers?: unknown };
  if (!Array.isArray(obj.triggers)) return DEFAULT_TRIGGER_REGISTRY;
  const triggers = obj.triggers
    .map((item) => TriggerConfigSchema.safeParse(item))
    .filter((r) => r.success)
    .map((r) => r.data);
  return TriggerRegistryFileSchema.parse({ version: 1, triggers });
}
