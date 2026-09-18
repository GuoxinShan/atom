import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export type SubscriptionKind = "webhook" | "cli" | "http-json" | "file" | "log" | "noop";

export interface SubscriptionConfig {
  id: string;
  kind: SubscriptionKind;
  enabled?: boolean;
  /** atom/event kinds to receive; ["*"] = all */
  types?: string[];
  url?: string;
  headers?: Record<string, string>;
  secretEnv?: string;
  bin?: string;
  args?: string[];
  path?: string;
  notes?: string;
}

export interface SubscriptionsFile {
  version?: number;
  subscriptions: SubscriptionConfig[];
}

export type SubscriptionPayload = {
  kind: string;
  text: string;
  meta?: Record<string, unknown>;
  at?: string;
};

export class SubscriptionRegistry {
  constructor(private readonly repoRoot: string) {}

  path(): string {
    return path.join(this.repoRoot, "data", "subscriptions.json");
  }

  load(): SubscriptionsFile {
    const p = this.path();
    if (!fs.existsSync(p)) return { version: 1, subscriptions: [] };
    return JSON.parse(fs.readFileSync(p, "utf8")) as SubscriptionsFile;
  }

  save(cfg: SubscriptionsFile): void {
    fs.writeFileSync(this.path(), JSON.stringify(cfg, null, 2) + "\n", "utf8");
  }

  matching(kind: string): SubscriptionConfig[] {
    return this.load().subscriptions.filter((s) => {
      if (s.enabled === false) return false;
      const types = s.types?.length ? s.types : ["*"];
      return types.includes("*") || types.includes(kind);
    });
  }
}

export async function dispatchSubscriptions(
  repoRoot: string,
  payload: SubscriptionPayload
): Promise<void> {
  const reg = new SubscriptionRegistry(repoRoot);
  const list = reg.matching(payload.kind);
  const full = { ...payload, at: payload.at ?? new Date().toISOString() };

  for (const s of list) {
    try {
      await deliverOne(repoRoot, s, full);
    } catch (err) {
      console.warn(`[sub:${s.id}] ${(err as Error).message}`);
    }
  }
}

async function deliverOne(
  repoRoot: string,
  s: SubscriptionConfig,
  payload: SubscriptionPayload
): Promise<void> {
  switch (s.kind) {
    case "log":
      console.log(`[sub:log:${s.id}] ${payload.kind}: ${payload.text}`);
      return;
    case "noop":
      return;
    case "file": {
      const rel = s.path ?? "out/subscriptions/events.jsonl";
      const abs = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.appendFileSync(abs, JSON.stringify({ subscription_id: s.id, ...payload }) + "\n");
      return;
    }
    case "cli": {
      if (!s.bin) throw new Error("cli subscription missing bin");
      await new Promise<void>((resolve, reject) => {
        const child = spawn(s.bin!, s.args ?? [], { stdio: ["pipe", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d.toString()));
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`))
        );
        child.stdin.write(JSON.stringify({ subscription_id: s.id, ...payload }));
        child.stdin.end();
      });
      return;
    }
    case "webhook":
    case "http-json": {
      if (!s.url) throw new Error("webhook subscription missing url");
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...(s.headers ?? {}),
      };
      if (s.secretEnv) {
        const secret = process.env[s.secretEnv];
        if (secret) headers.authorization = `Bearer ${secret}`;
      }
      const res = await fetch(s.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ subscription_id: s.id, ...payload }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return;
    }
    default:
      throw new Error(`unknown subscription kind: ${(s as SubscriptionConfig).kind}`);
  }
}
