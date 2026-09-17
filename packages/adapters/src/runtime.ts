import {
  AtomStore,
  loadSourceRegistry,
  LogSubscriptionSink,
  resolvePaths,
  type ExtractAgent,
  type Pipeline,
  type SourceAdapter,
  type SourceConfig,
} from "@atom/core";
import { HeuristicExtractAgent } from "./heuristic-extract.ts";
import { GrokCliExtractAgent } from "./grok-cli-extract.ts";
import {
  createSourceFromConfig,
  registeredSourceTypes,
} from "./factories.ts";

export function createExtractAgent(kind: string): ExtractAgent {
  if (kind === "grok") return new GrokCliExtractAgent();
  return new HeuristicExtractAgent();
}

export function createPipeline(): { pipeline: Pipeline; store: AtomStore } {
  const paths = resolvePaths();
  const registry = loadSourceRegistry(paths.registryPath, paths.seedRegistryPath);
  const wanted = process.env.ATOM_SOURCE;
  const selected = wanted
    ? registry.sources.filter((s) => s.id === wanted)
    : registry.sources.filter((s) => s.enabled);
  if (wanted && selected.length === 0) {
    throw new Error(`ATOM_SOURCE=${wanted} not in ${paths.registryPath}`);
  }
  const ctx = {
    fixturesPath: paths.fixturesPath,
    dataDir: paths.dataDir,
    root: paths.root,
  };
  const sources: SourceAdapter[] = [];
  for (const cfg of selected) {
    const adapter = createSourceFromConfig(cfg, ctx);
    if (!adapter) {
      console.warn(
        `[atom] skip source ${cfg.id}: no factory for type "${cfg.type}". Registered: ${registeredSourceTypes().join(", ") || "(none)"}. Call registerSourceType() to extend.`,
      );
      continue;
    }
    sources.push(adapter);
  }
  if (sources.length === 0) {
    throw new Error(
      `No runnable sources. Enable a config in ${paths.registryPath} or pnpm atom sources add`,
    );
  }
  const extractKind = process.env.ATOM_EXTRACT_AGENT ?? "heuristic";
  const store = new AtomStore(paths.dbPath);
  const pipeline: Pipeline = {
    store,
    sources,
    extract: createExtractAgent(extractKind),
    outDir: paths.outDir,
    sink: new LogSubscriptionSink(),
  };
  return { pipeline, store };
}

export function describeSource(cfg: SourceConfig): string {
  const groups = cfg.groupIds?.length ? cfg.groupIds.join(",") : "-";
  const cred = cfg.credentialRef ?? "-";
  const on = cfg.enabled ? "on" : "off";
  const factory = registeredSourceTypes().includes(cfg.type) ? "factory" : "no-factory";
  return `${cfg.id}\t${cfg.type}\t${on}\tgroups=${groups}\tcred=${cred}\t${factory}`;
}

export { FixtureSource } from "./fixture-source.ts";
export { YzjSource } from "./yzj-source.ts";
export { HeuristicExtractAgent } from "./heuristic-extract.ts";
export { GrokCliExtractAgent } from "./grok-cli-extract.ts";
export { registerSourceType, registeredSourceTypes, createSourceFromConfig } from "./factories.ts";
