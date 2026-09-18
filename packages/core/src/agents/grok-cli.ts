import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExtractAgent, CandidateProposal, CandidateProposalSchema, RawMessage } from "../schema/types.js";
import { refTokenForMessage } from "../schema/ids.js";

const JSON_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          confidence: { type: "number" },
          source_message_ids: { type: "array", items: { type: "string" } },
          cluster_key: { type: "string" },
        },
        required: ["title", "source_message_ids"],
      },
    },
  },
  required: ["candidates"],
};

/**
 * Agentic extract via local Grok Build CLI (not raw model HTTP).
 * Input should already be heuristic-gated seeds.
 */
export class GrokCliExtractAgent implements ExtractAgent {
  readonly id = "grok-cli";

  constructor(
    private readonly opts: {
      bin?: string;
      timeoutMs?: number;
      maxTurns?: number;
    } = {}
  ) {}

  async extract(messages: RawMessage[]): Promise<CandidateProposal[]> {
    if (messages.length === 0) return [];

    const bin = this.opts.bin ?? process.env.ATOM_GROK_BIN ?? "grok";
    const prompt = buildPrompt(messages);
    const schemaStr = JSON.stringify(JSON_SCHEMA);
    const promptFile = path.join(os.tmpdir(), `atom-extract-${Date.now()}.md`);
    fs.writeFileSync(promptFile, prompt, "utf8");

    let stdout: string;
    try {
      stdout = await runGrok(
        bin,
        promptFile,
        schemaStr,
        this.opts.timeoutMs ?? Number(process.env.ATOM_GROK_TIMEOUT_MS ?? 180_000),
        this.opts.maxTurns ?? Number(process.env.ATOM_GROK_MAX_TURNS ?? 12)
      );
    } finally {
      try {
        fs.unlinkSync(promptFile);
      } catch {
        /* ignore */
      }
    }

    const parsed = parseGrokJson(stdout);
    const byId = new Map(messages.map((m) => [m.id, m]));
    const out: CandidateProposal[] = [];

    for (const c of parsed.candidates ?? []) {
      const ids = Array.isArray(c.source_message_ids) ? c.source_message_ids.map(String) : [];
      const refs = ids
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((msg) => ({
          token: refTokenForMessage(msg!),
          kind: "im" as const,
          digest: msg!.text.slice(0, 80),
        }));
      if (refs.length < 1) continue;
      const proposal = CandidateProposalSchema.safeParse({
        title: String(c.title ?? "").trim() || "Untitled demand",
        body: String(c.body ?? ""),
        confidence: Number(c.confidence ?? 0.7),
        cluster_key: c.cluster_key ? String(c.cluster_key) : undefined,
        refs,
        source_message_ids: ids,
      });
      if (proposal.success) out.push(proposal.data);
    }
    return out;
  }
}

function buildPrompt(messages: RawMessage[]): string {
  const lines = messages.map(
    (m) =>
      `- id=${m.id} group=${m.groupId ?? "?"} author=${m.author ?? "?"} ts=${m.ts}\n  ${m.text.slice(0, 1200)}`
  );
  return [
    "You are the ATOM extract agent.",
    "These messages were already shortlisted as *candidate seeds* by a heuristic gate.",
    "Your job: turn them into real product/demand candidates for an approve queue.",
    "",
    "Rules:",
    "- Only keep actionable demands / asks / bugs / missing capabilities.",
    "- Drop acknowledgements, FYIs, already-finished digests, and chatter.",
    "- Merge duplicates into one candidate when they are the same ask.",
    "- Each candidate MUST cite one or more source_message_ids from the list (never invent ids).",
    "- Titles: short, imperative Chinese or English matching the chat language.",
    "- confidence: 0.5–0.95.",
    "",
    "Seed messages:",
    ...lines,
  ].join("\n");
}

function runGrok(
  bin: string,
  promptFile: string,
  schema: string,
  timeoutMs: number,
  maxTurns: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "--always-approve",
      "--max-turns",
      String(maxTurns),
      "--json-schema",
      schema,
      "--prompt-file",
      promptFile,
      "-p",
      "", // headless single; prompt comes from --prompt-file
    ];
    // Prefer: grok -p --prompt-file PATH  (if empty -p fails, use only --prompt-file)
    const child = spawn(
      bin,
      [
        "--always-approve",
        "--max-turns",
        String(maxTurns),
        "--json-schema",
        schema,
        "--prompt-file",
        promptFile,
        "--output-format",
        "json",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`grok timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`grok exit ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseGrokJson(stdout: string): { candidates?: Array<Record<string, unknown>> } {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as { candidates?: Array<Record<string, unknown>> };
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("grok stdout was not JSON");
    return JSON.parse(match[0]) as { candidates?: Array<Record<string, unknown>> };
  }
}
