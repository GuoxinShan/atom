import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { existsSync } from "node:fs";

export function findRepoRoot(start = process.cwd()): string {
  if (process.env.ATOM_ROOT) return resolve(process.env.ATOM_ROOT);
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export type AtomPaths = {
  root: string;
  dataDir: string;
  outDir: string;
  dbPath: string;
  fixturesPath: string;
  /** Runtime store (gitignored). Seeded from `seedRegistryPath` on first run. */
  registryPath: string;
  seedRegistryPath: string;
  triggerRegistryPath: string;
  seedTriggerRegistryPath: string;
};

export function resolvePaths(root = findRepoRoot()): AtomPaths {
  const dataDir = resolve(envPath(root, process.env.ATOM_DATA_DIR, "data"));
  const outDir = resolve(envPath(root, process.env.ATOM_OUT_DIR, "out"));
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  return {
    root,
    dataDir,
    outDir,
    dbPath: resolve(process.env.ATOM_DB ?? join(dataDir, "atom.sqlite")),
    fixturesPath: resolve(
      envPath(root, process.env.ATOM_FIXTURES, "fixtures/messages.jsonl"),
    ),
    registryPath: resolve(
      envPath(root, process.env.ATOM_SOURCE_REGISTRY, "data/sources.json"),
    ),
    seedRegistryPath: resolve(join(root, "config/sources.json")),
    triggerRegistryPath: resolve(
      envPath(root, process.env.ATOM_TRIGGER_REGISTRY, "data/triggers.json"),
    ),
    seedTriggerRegistryPath: resolve(join(root, "config/triggers.json")),
  };
}

function envPath(root: string, value: string | undefined, fallback: string): string {
  const p = value ?? fallback;
  return isAbsolute(p) ? p : join(root, p);
}
