import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Walk up from cwd (then this file) until the workspace package named `atom`. */
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
