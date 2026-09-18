import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDb,
  defaultDbPath,
  EventStore,
  SourceRegistry,
  ManualTrigger,
  LogSubscriptionSink,
} from "@atom/core";
import { FixtureSource, YzjSource } from "@atom/adapters";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  return path.resolve(__dirname, "../../..");
}

export type Daemon = {
  repoRoot: string;
  store: EventStore;
  registry: SourceRegistry;
  trigger: ManualTrigger;
  sink: LogSubscriptionSink;
};

export function createSourceRegistry(repoRoot: string): SourceRegistry {
  const registry = new SourceRegistry(repoRoot);
  registry.register("fixture", (entry, root) => {
    const rel = (entry as { path?: string }).path ?? "fixtures/messages.jsonl";
    return new FixtureSource(path.join(root, rel), entry.id);
  });
  registry.register(
    "yzj",
    (entry) =>
      new YzjSource({
        id: entry.id,
        groupIds: (entry as { groupIds?: string[] }).groupIds,
        cli: (entry as { cli?: string }).cli,
      })
  );
  return registry;
}

export async function createDaemon(repoRoot = resolveRepoRoot()): Promise<Daemon> {
  const atomDb = await openDb(process.env.ATOM_DB ?? defaultDbPath(repoRoot));
  const store = new EventStore(atomDb);
  const registry = createSourceRegistry(repoRoot);
  const trigger = new ManualTrigger();
  const sink = new LogSubscriptionSink(repoRoot);
  return { repoRoot, store, registry, trigger, sink };
}
