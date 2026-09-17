import { isAbsolute, join, resolve } from "node:path";
import type { SourceAdapter, SourceConfig, SourceFactory, SourceFactoryContext } from "@atom/core";
import { FixtureSource } from "./fixture-source.ts";
import { YzjSource } from "./yzj-source.ts";

const factories = new Map<string, SourceFactory>();

/** Extension point: later agents (Grok) register new source types without changing ingest. */
export function registerSourceType(type: string, factory: SourceFactory): void {
  factories.set(type, factory);
}

export function registeredSourceTypes(): string[] {
  return [...factories.keys()].sort();
}

export function createSourceFromConfig(
  config: SourceConfig,
  ctx: SourceFactoryContext,
): SourceAdapter | null {
  const factory = factories.get(config.type);
  if (!factory) return null;
  return factory(config, ctx);
}

registerSourceType("fixture", (config, ctx) => {
  const raw = config.settings?.path;
  const path =
    typeof raw === "string" && raw.length > 0
      ? isAbsolute(raw)
        ? raw
        : resolve(join(ctx.root, raw))
      : ctx.fixturesPath;
  return new FixtureSource({
    id: config.id,
    filePath: path,
    seedCursor: typeof config.cursor === "string" ? config.cursor : undefined,
  });
});

registerSourceType("yzj", (config) => new YzjSource(config));
