import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type CheckStatus = "ok" | "warn" | "fail";

export interface SetupCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface ColdStartReport {
  ready: boolean;
  checks: SetupCheck[];
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function which(bin: string): string | null {
  const r = spawnSync("which", [bin], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return (r.stdout || "").trim() || null;
}

export function runColdStart(repoRoot: string): ColdStartReport {
  const checks: SetupCheck[] = [];

  const node = process.versions.node;
  checks.push({
    id: "node",
    title: "Node.js",
    status: Number(node.split(".")[0]) >= 20 ? "ok" : "fail",
    detail: `node ${node}`,
    fix: "Install Node 20+",
  });

  const grok = which(process.env.ATOM_GROK_BIN ?? "grok");
  checks.push({
    id: "grok",
    title: "Grok Build CLI (agentic extract / coding)",
    status: grok ? "ok" : "warn",
    detail: grok ?? "not found on PATH",
    fix: "Install Grok CLI and ensure `grok` is on PATH",
  });

  const yzj = which("yzj-cli");
  checks.push({
    id: "yzj-cli",
    title: "yzj-cli",
    status: yzj ? "ok" : "warn",
    detail: yzj ?? "not found — fixture source still works",
    fix: "Install/login yzj-cli for live Yunzhijia ingest",
  });

  if (yzj) {
    const who = spawnSync("yzj-cli", ["whoami"], { encoding: "utf8" });
    const ok = who.status === 0 && /success|openId|name/i.test(who.stdout || "");
    checks.push({
      id: "yzj-auth",
      title: "yzj-cli auth",
      status: ok ? "ok" : "fail",
      detail: ok ? "logged in" : (who.stderr || who.stdout || "auth failed").slice(0, 200),
      fix: "Run `yzj-cli auth login`",
    });
  }

  const required = [
    "data/sources.json",
    "data/workspaces.json",
    "data/user-context.md",
    "data/subscriptions.json",
    "data/triggers.json",
    "data/agents.json",
  ];
  for (const rel of required) {
    const p = path.join(repoRoot, rel);
    checks.push({
      id: `file:${rel}`,
      title: rel,
      status: exists(p) ? "ok" : "fail",
      detail: exists(p) ? "present" : "missing",
      fix: exists(p) ? undefined : "Restore from repo template / ask LeadAgent to bootstrap",
    });
  }

  const sourcesPath = path.join(repoRoot, "data", "sources.json");
  if (exists(sourcesPath)) {
    const cfg = JSON.parse(fs.readFileSync(sourcesPath, "utf8")) as {
      sources?: Array<{ id: string; enabled?: boolean; groupIds?: string[] }>;
      defaultSourceId?: string;
    };
    const enabled = (cfg.sources ?? []).filter((s) => s.enabled !== false);
    const yzjSrc = enabled.find((s) => s.id === "yzj" || (s as { kind?: string }).kind === "yzj");
    const groups = yzjSrc?.groupIds ?? [];
    checks.push({
      id: "sources-scope",
      title: "Source scope (groups)",
      status: groups.length ? "ok" : "warn",
      detail: groups.length
        ? `enabled sources=${enabled.map((s) => s.id).join(",")} groups=${groups.join(",")}`
        : "no yzj groupIds — only fixture will produce digests",
      fix: "Ask LeadAgent: 帮我把 Agentic Working 群加进订阅，or edit data/sources.json / UI Sources",
    });
  }

  const ready = checks.every((c) => c.status !== "fail");
  return { ready, checks };
}

export function ensureColdStartFiles(repoRoot: string): string[] {
  const created: string[] = [];
  const ensure = (rel: string, body: string) => {
    const p = path.join(repoRoot, rel);
    if (!exists(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body, "utf8");
      created.push(rel);
    }
  };
  ensure(
    "data/subscriptions.json",
    JSON.stringify({ subscriptions: [] }, null, 2) + "\n"
  );
  ensure(
    "data/triggers.json",
    JSON.stringify(
      {
        triggers: [
          { id: "manual-run", kind: "manual", enabled: true, pipeline: "run" },
        ],
      },
      null,
      2
    ) + "\n"
  );
  return created;
}
