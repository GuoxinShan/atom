import fs from "node:fs";
import path from "node:path";

export type AgentRole = "lead" | "extract" | "coding" | "execute";

export type AgentProviderKind =
  | "local-cli"
  | "webhook"
  | "grokbot-webhook"
  | "http-json"
  | "noop";

export interface AgentProviderConfig {
  id: string;
  role: AgentRole;
  kind: AgentProviderKind;
  enabled?: boolean;
  bin?: string;
  url?: string;
  cwdMode?: "routed" | "atom" | "fixed";
  cwd?: string;
  headers?: Record<string, string>;
  secretEnv?: string;
  notes?: string;
  args?: string[];
}

export interface AgentsFile {
  version: number;
  defaults: Partial<Record<AgentRole, string>>;
  providers: AgentProviderConfig[];
  workspaceOverrides?: Record<string, Partial<Record<AgentRole, string>>>;
}

export class AgentProviderRegistry {
  constructor(private readonly repoRoot: string) {}

  path(): string {
    return path.join(this.repoRoot, "data", "agents.json");
  }

  load(): AgentsFile {
    const p = this.path();
    if (!fs.existsSync(p)) {
      return { version: 1, defaults: {}, providers: [], workspaceOverrides: {} };
    }
    return JSON.parse(fs.readFileSync(p, "utf8")) as AgentsFile;
  }

  save(cfg: AgentsFile): void {
    fs.writeFileSync(this.path(), JSON.stringify(cfg, null, 2) + "\n", "utf8");
  }

  list(role?: AgentRole): AgentProviderConfig[] {
    const cfg = this.load();
    return cfg.providers.filter((p) => (role ? p.role === role : true));
  }

  resolve(role: AgentRole, workspaceId?: string): AgentProviderConfig {
    const cfg = this.load();
    const overrideId = workspaceId
      ? cfg.workspaceOverrides?.[workspaceId]?.[role]
      : undefined;
    const id = overrideId ?? cfg.defaults[role];
    if (!id) throw new Error(`No default provider for role=${role}`);
    const provider = cfg.providers.find((p) => p.id === id);
    if (!provider) throw new Error(`Provider not found: ${id}`);
    if (provider.enabled === false) throw new Error(`Provider disabled: ${id}`);
    if (provider.role !== role) {
      throw new Error(`Provider ${id} role=${provider.role} != requested ${role}`);
    }
    return provider;
  }

  setDefault(role: AgentRole, providerId: string): void {
    const cfg = this.load();
    const provider = cfg.providers.find((p) => p.id === providerId);
    if (!provider) throw new Error(`Provider not found: ${providerId}`);
    if (provider.role !== role) throw new Error(`Provider ${providerId} is role=${provider.role}`);
    cfg.defaults[role] = providerId;
    this.save(cfg);
  }

  upsertProvider(provider: AgentProviderConfig): void {
    const cfg = this.load();
    const i = cfg.providers.findIndex((p) => p.id === provider.id);
    if (i >= 0) cfg.providers[i] = { ...cfg.providers[i], ...provider };
    else cfg.providers.push(provider);
    this.save(cfg);
  }
}

export type AgentRequest = {
  role: AgentRole;
  runId: string;
  utterance?: string;
  messages?: unknown[];
  spec?: unknown;
  route?: unknown;
  briefing?: string;
  workspacePath?: string;
  policy?: { confirmOutbound?: boolean };
};

export type AgentResponse = {
  ok: boolean;
  summary: string;
  configResult?: unknown;
  candidates?: unknown[];
  artifacts?: Array<{ path: string; kind: string }>;
  atoms?: Array<{ type: string; detail: unknown }>;
  raw?: unknown;
};

/** Dispatch to webhook / grokbot-webhook providers. Local-cli stays in role-specific code for now. */
export async function invokeRemoteProvider(
  provider: AgentProviderConfig,
  req: AgentRequest
): Promise<AgentResponse> {
  if (provider.kind !== "webhook" && provider.kind !== "grokbot-webhook" && provider.kind !== "http-json") {
    throw new Error(`invokeRemoteProvider only for remote kinds, got ${provider.kind}`);
  }
  if (!provider.url) throw new Error(`Provider ${provider.id} missing url`);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(provider.headers ?? {}),
  };
  if (provider.secretEnv) {
    const secret = process.env[provider.secretEnv];
    if (secret) headers.authorization = `Bearer ${secret}`;
  }
  const res = await fetch(provider.url, {
    method: "POST",
    headers,
    body: JSON.stringify(req),
  });
  const text = await res.text();
  let body: AgentResponse;
  try {
    body = JSON.parse(text) as AgentResponse;
  } catch {
    throw new Error(`Provider ${provider.id} non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || body.ok === false) {
    throw new Error(body.summary || `Provider ${provider.id} HTTP ${res.status}`);
  }
  return body;
}
