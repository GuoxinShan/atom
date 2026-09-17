import { readFileSync, existsSync } from "node:fs";

export type SourceRegistryEntry = {
  id: string;
  kind: "fixture" | "yzj";
  enabled?: boolean;
};

export type SourceRegistry = {
  sources: SourceRegistryEntry[];
};

export const DEFAULT_SOURCE_REGISTRY: SourceRegistry = {
  sources: [
    { id: "fixture", kind: "fixture", enabled: true },
    { id: "yzj", kind: "yzj", enabled: false },
  ],
};

/** Thin JSON registry. Missing file → default fixture source. */
export function loadSourceRegistry(path: string): SourceRegistry {
  if (!existsSync(path)) return DEFAULT_SOURCE_REGISTRY;
  const raw = JSON.parse(readFileSync(path, "utf8")) as SourceRegistry;
  if (!Array.isArray(raw.sources)) return DEFAULT_SOURCE_REGISTRY;
  return raw;
}
