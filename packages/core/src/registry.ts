import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { SourceAdapter } from "./interfaces.ts";

/** Open string — not a closed Fixture/Yzj enum. New types register via SourceFactory. */
export const SourceConfigSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  enabled: z.boolean().default(true),
  label: z.string().min(1).optional(),
  /** Opaque pointer to a secret store; never put tokens in this file. */
  credentialRef: z.string().min(1).optional(),
  /** Yunzhijia (and similar) group/chat ids — config, not env-only. */
  groupIds: z.array(z.string().min(1)).optional(),
  /** Optional seed cursor if SQLite `cursors` has no row yet. */
  cursor: z.union([z.string(), z.record(z.string())]).optional(),
  settings: z.record(z.unknown()).optional(),
});

export type SourceConfig = z.infer<typeof SourceConfigSchema>;

export const SourceRegistryFileSchema = z.object({
  version: z.literal(1).default(1),
  sources: z.array(SourceConfigSchema),
});

export type SourceRegistry = z.infer<typeof SourceRegistryFileSchema>;

export const DEFAULT_SOURCE_REGISTRY: SourceRegistry = {
  version: 1,
  sources: [
    {
      id: "fixture",
      type: "fixture",
      enabled: true,
      label: "Bundled JSONL",
      settings: { path: "fixtures/messages.jsonl" },
    },
    {
      id: "yzj",
      type: "yzj",
      enabled: false,
      label: "Yunzhijia via yzj-cli",
      groupIds: [],
      credentialRef: "keychain:yzj-cli",
      settings: { bin: "yzj-cli" },
    },
  ],
};

export type SourceFactoryContext = {
  fixturesPath: string;
  dataDir: string;
  root: string;
};

/** Built by adapters. Core only stores configs. */
export type SourceFactory = (
  config: SourceConfig,
  ctx: SourceFactoryContext,
) => SourceAdapter;

export function loadSourceRegistry(runtimePath: string, seedPath?: string): SourceRegistry {
  mkdirSync(dirname(runtimePath), { recursive: true });
  if (!existsSync(runtimePath)) {
    if (seedPath && existsSync(seedPath)) {
      copyFileSync(seedPath, runtimePath);
    } else {
      saveSourceRegistry(runtimePath, DEFAULT_SOURCE_REGISTRY);
    }
  }
  const raw = JSON.parse(readFileSync(runtimePath, "utf8")) as unknown;
  return normalizeRegistry(raw);
}

export function saveSourceRegistry(path: string, registry: SourceRegistry): void {
  mkdirSync(dirname(path), { recursive: true });
  const parsed = SourceRegistryFileSchema.parse({ version: 1, sources: registry.sources });
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

export function upsertSourceConfig(
  path: string,
  input: SourceConfig,
  seedPath?: string,
): SourceRegistry {
  const registry = loadSourceRegistry(path, seedPath);
  const next = SourceConfigSchema.parse(input);
  const idx = registry.sources.findIndex((s) => s.id === next.id);
  if (idx >= 0) registry.sources[idx] = { ...registry.sources[idx], ...next };
  else registry.sources.push(next);
  saveSourceRegistry(path, registry);
  return registry;
}

export function listSourceConfigs(path: string, seedPath?: string): SourceConfig[] {
  return loadSourceRegistry(path, seedPath).sources;
}

function normalizeRegistry(raw: unknown): SourceRegistry {
  if (!raw || typeof raw !== "object") return DEFAULT_SOURCE_REGISTRY;
  const obj = raw as { version?: unknown; sources?: unknown };
  if (!Array.isArray(obj.sources)) return DEFAULT_SOURCE_REGISTRY;
  const sources = obj.sources.map((item) => coerceEntry(item)).filter((x): x is SourceConfig => x !== null);
  return SourceRegistryFileSchema.parse({ version: 1, sources });
}

function coerceEntry(item: unknown): SourceConfig | null {
  if (!item || typeof item !== "object") return null;
  const row = item as Record<string, unknown>;
  const type = String(row.type ?? row.kind ?? "");
  const id = String(row.id ?? "");
  if (!id || !type) return null;
  const parsed = SourceConfigSchema.safeParse({
    id,
    type,
    enabled: row.enabled ?? true,
    label: row.label,
    credentialRef: row.credentialRef ?? row.credential_ref,
    groupIds: row.groupIds ?? row.group_ids,
    cursor: row.cursor,
    settings: row.settings,
  });
  return parsed.success ? parsed.data : null;
}

/** @deprecated Use SourceConfig.type. Kept for old call sites. */
export type SourceRegistryEntry = SourceConfig;
