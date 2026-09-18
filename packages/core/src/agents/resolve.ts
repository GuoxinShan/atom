import { GrokCliExtractAgent } from "./grok-cli.js";
import { GrokCliCodingAgent } from "./grok-coding.js";
import type { CodingAgent, ExtractAgent } from "../schema/types.js";
import {
  AgentProviderRegistry,
  invokeRemoteProvider,
  type AgentProviderConfig,
} from "../registry/agents.js";
import { newId } from "../schema/ids.js";
import { CandidateProposalSchema, type RawMessage } from "../schema/types.js";
import { refTokenForMessage } from "../schema/ids.js";

/** Build ExtractAgent from data/agents.json (local-cli or webhook). */
export function resolveExtractAgent(repoRoot: string, workspaceId?: string): ExtractAgent {
  const reg = new AgentProviderRegistry(repoRoot);
  let provider: AgentProviderConfig;
  try {
    provider = reg.resolve("extract", workspaceId);
  } catch {
    return new GrokCliExtractAgent();
  }

  if (provider.kind === "local-cli") {
    const bin = provider.bin && provider.bin !== "grok" ? provider.bin : undefined;
    return new GrokCliExtractAgent({ bin });
  }

  if (provider.kind === "webhook" || provider.kind === "grokbot-webhook" || provider.kind === "http-json") {
    return {
      id: provider.id,
      async extract(messages: RawMessage[]) {
        const res = await invokeRemoteProvider(provider, {
          role: "extract",
          runId: newId("agent"),
          messages,
        });
        const out = [];
        for (const c of res.candidates ?? []) {
          const row = c as Record<string, unknown>;
          const ids = Array.isArray(row.source_message_ids)
            ? row.source_message_ids.map(String)
            : [];
          const byId = new Map(messages.map((m) => [m.id, m]));
          const refs = ids
            .map((id) => byId.get(id))
            .filter(Boolean)
            .map((msg) => ({
              token: refTokenForMessage(msg!),
              kind: "im" as const,
              digest: msg!.text.slice(0, 80),
            }));
          if (!refs.length) continue;
          const parsed = CandidateProposalSchema.safeParse({
            title: String(row.title ?? "Untitled"),
            body: String(row.body ?? ""),
            confidence: Number(row.confidence ?? 0.7),
            refs,
            source_message_ids: ids,
          });
          if (parsed.success) out.push(parsed.data);
        }
        return out;
      },
    } satisfies ExtractAgent;
  }

  throw new Error(`Unsupported extract provider kind: ${provider.kind}`);
}

export function resolveCodingAgent(repoRoot: string, workspaceId?: string): CodingAgent {
  const reg = new AgentProviderRegistry(repoRoot);
  let provider: AgentProviderConfig;
  try {
    provider = reg.resolve("coding", workspaceId);
  } catch {
    return new GrokCliCodingAgent({ repoRoot });
  }

  if (provider.kind === "local-cli") {
    return new GrokCliCodingAgent({
      repoRoot,
      bin: provider.bin && provider.bin !== "builtin:lead" ? provider.bin : undefined,
    });
  }

  if (provider.kind === "webhook" || provider.kind === "grokbot-webhook" || provider.kind === "http-json") {
    return {
      id: provider.id,
      async handoff(spec, opts) {
        const res = await invokeRemoteProvider(provider, {
          role: "coding",
          runId: newId("agent"),
          spec,
          briefing: opts?.briefing,
          workspacePath: opts?.workDir,
        });
        const art = res.artifacts?.[0];
        return {
          id: newId("handoff"),
          spec_id: spec.id,
          candidate_id: spec.candidate_id,
          path: art?.path ?? "",
          target: "grok-cli",
        };
      },
    } satisfies CodingAgent;
  }

  throw new Error(`Unsupported coding provider kind: ${provider.kind}`);
}
