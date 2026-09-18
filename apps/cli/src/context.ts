import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EventStore,
  SourceRegistry,
  ManualTrigger,
  LogSubscriptionSink,
  openDb,
  defaultDbPath,
  ExtractAgent,
  resolveExtractAgent,
} from "@atom/core";
import { FixtureSource, YzjSource } from "@atom/adapters";

export function resolveRepoRoot(): string {
  let dir = path.resolve(process.cwd());
  for (;;) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const j = JSON.parse(fs.readFileSync(pkg, "utf8")) as { name?: string };
        if (j.name === "atom") return dir;
      } catch {
        /* ignore */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../..");
}

export async function createAppContext(repoRoot = resolveRepoRoot()) {
  const dbPath = process.env.ATOM_DB ?? defaultDbPath(repoRoot);
  const atomDb = await openDb(dbPath);
  const store = new EventStore(atomDb);

  const registry = new SourceRegistry(repoRoot);
  registry.register("fixture", (entry, root) => {
    const rel = entry.path ?? "fixtures/messages.jsonl";
    return new FixtureSource(path.join(root, rel), entry.id);
  });
  registry.register(
    "yzj",
    (entry) =>
      new YzjSource({
        id: entry.id,
        groupIds: entry.groupIds,
        cli: entry.cli as string | undefined,
      })
  );

  const trigger = new ManualTrigger();
  const sink = new LogSubscriptionSink(repoRoot);

  return { repoRoot, dbPath, atomDb, store, registry, trigger, sink };
}

export function resolveAgent(_name: string, repoRoot = resolveRepoRoot()): ExtractAgent {
  // Name flag kept for CLI compat; real selection is data/agents.json defaults.
  return resolveExtractAgent(repoRoot);
}
