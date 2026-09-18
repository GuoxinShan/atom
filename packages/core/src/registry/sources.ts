import fs from "node:fs";
import path from "node:path";
import { SourceAdapter } from "../schema/types.js";

export interface SourceConfigEntry {
  id: string;
  kind: string;
  enabled?: boolean;
  path?: string;
  groupIds?: string[];
  cli?: string;
  [k: string]: unknown;
}

export interface SourcesFile {
  sources: SourceConfigEntry[];
  defaultSourceId?: string;
  defaultExtractAgent?: string;
}

export type AdapterFactory = (entry: SourceConfigEntry, repoRoot: string) => SourceAdapter;

/** Thin registry over data/sources.json */
export class SourceRegistry {
  private factories = new Map<string, AdapterFactory>();

  constructor(
    private readonly repoRoot: string,
    private readonly configPath = path.join(repoRoot, "data", "sources.json")
  ) {}

  register(kind: string, factory: AdapterFactory): void {
    this.factories.set(kind, factory);
  }

  loadConfig(): SourcesFile {
    const raw = fs.readFileSync(this.configPath, "utf8");
    return JSON.parse(raw) as SourcesFile;
  }

  resolve(sourceId?: string): SourceAdapter {
    const cfg = this.loadConfig();
    const id = sourceId ?? cfg.defaultSourceId ?? cfg.sources[0]?.id;
    const entry = cfg.sources.find((s) => s.id === id);
    if (!entry) throw new Error(`Unknown source id: ${id}`);
    if (entry.enabled === false) throw new Error(`Source disabled: ${id}`);
    const factory = this.factories.get(entry.kind);
    if (!factory) throw new Error(`No adapter factory for kind: ${entry.kind}`);
    return factory(entry, this.repoRoot);
  }

  defaultExtractAgent(): string {
    return this.loadConfig().defaultExtractAgent ?? "heuristic";
  }
}
