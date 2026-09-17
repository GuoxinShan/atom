import {
  AtomStore,
  loadSourceRegistry,
  LogSubscriptionSink,
  resolvePaths,
  type ExtractAgent,
  type Pipeline,
  type SourceAdapter,
} from "@atom/core";
import { FixtureSource } from "./fixture-source.ts";
import { YzjSource } from "./yzj-source.ts";
import { HeuristicExtractAgent } from "./heuristic-extract.ts";
import { GrokCliExtractAgent } from "./grok-cli-extract.ts";

export function createSource(kind: string, fixturesPath: string): SourceAdapter {
  if (kind === "yzj") return new YzjSource();
  return new FixtureSource(fixturesPath);
}

export function createExtractAgent(kind: string): ExtractAgent {
  if (kind === "grok") return new GrokCliExtractAgent();
  return new HeuristicExtractAgent();
}

export function createPipeline(): { pipeline: Pipeline; store: AtomStore } {
  const paths = resolvePaths();
  const registry = loadSourceRegistry(paths.registryPath);
  const sourceKind =
    process.env.ATOM_SOURCE ??
    registry.sources.find((s) => s.enabled)?.kind ??
    "fixture";
  const extractKind = process.env.ATOM_EXTRACT_AGENT ?? "heuristic";
  const store = new AtomStore(paths.dbPath);
  const pipeline: Pipeline = {
    store,
    source: createSource(sourceKind, paths.fixturesPath),
    extract: createExtractAgent(extractKind),
    outDir: paths.outDir,
    sink: new LogSubscriptionSink(),
  };
  return { pipeline, store };
}

export { FixtureSource, YzjSource, HeuristicExtractAgent, GrokCliExtractAgent };
