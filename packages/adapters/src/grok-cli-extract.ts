import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProposedCandidateListSchema,
  proposedCandidateJsonSchema,
  type ExtractAgent,
  type ProposedCandidate,
  type RawMessage,
} from "@atom/core";

export type GrokSpawnFn = (
  bin: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string; code: number }>;

/**
 * Primary LLM extract path: spawn local Grok Build Agent CLI.
 * Not OpenAI/xAI HTTP chat completions.
 *
 *   grok -p --always-approve --max-turns N --json-schema <file> --prompt-file <file>
 */
export class GrokCliExtractAgent implements ExtractAgent {
  readonly id = "grok";

  constructor(
    private readonly opts: {
      bin?: string;
      model?: string;
      maxTurns?: number;
      spawn?: GrokSpawnFn;
    } = {},
  ) {}

  async propose(input: { messages: RawMessage[] }): Promise<ProposedCandidate[]> {
    const dir = mkdtempSync(join(tmpdir(), "atom-grok-"));
    const schemaPath = join(dir, "schema.json");
    const promptPath = join(dir, "prompt.md");
    writeFileSync(schemaPath, JSON.stringify(proposedCandidateJsonSchema, null, 2));
    writeFileSync(promptPath, buildPrompt(input.messages));
    const bin = this.opts.bin ?? process.env.ATOM_GROK_BIN ?? "grok";
    const maxTurns = this.opts.maxTurns ?? Number(process.env.ATOM_GROK_MAX_TURNS ?? 8);
    const model = this.opts.model ?? process.env.ATOM_GROK_MODEL;
    const args = [
      "-p",
      "--always-approve",
      "--max-turns",
      String(maxTurns),
      "--json-schema",
      schemaPath,
      "--prompt-file",
      promptPath,
      "--output-format",
      "json",
    ];
    if (model) args.push("-m", model);
    try {
      const spawnFn = this.opts.spawn ?? defaultSpawn;
      const { stdout, stderr, code } = await spawnFn(bin, args);
      if (code !== 0) {
        throw new Error(`GrokCliExtractAgent: ${bin} exited ${code}\n${stderr || stdout}`);
      }
      return parseGrokOutput(stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export function grokArgv(input: {
  schemaPath: string;
  promptPath: string;
  maxTurns: number;
  model?: string;
}): string[] {
  const args = [
    "-p",
    "--always-approve",
    "--max-turns",
    String(input.maxTurns),
    "--json-schema",
    input.schemaPath,
    "--prompt-file",
    input.promptPath,
    "--output-format",
    "json",
  ];
  if (input.model) args.push("-m", input.model);
  return args;
}

export function parseGrokOutput(stdout: string): ProposedCandidate[] {
  const data = extractJson(stdout);
  const wrapped =
    data && typeof data === "object" && "candidates" in (data as object)
      ? data
      : data && typeof data === "object" && "structured_output" in (data as object)
        ? (data as { structured_output: unknown }).structured_output
        : data && typeof data === "object" && "text" in (data as object)
          ? extractJson(String((data as { text: unknown }).text))
          : data;
  const parsed = ProposedCandidateListSchema.safeParse(wrapped);
  if (!parsed.success) {
    throw new Error(`GrokCliExtractAgent: output failed Zod (${parsed.error.message})`);
  }
  return parsed.data.candidates as ProposedCandidate[];
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("GrokCliExtractAgent: no JSON in grok stdout");
  }
}

function buildPrompt(messages: RawMessage[]): string {
  const lines = messages.map(
    (m) =>
      `- id=${m.id} author=${m.author} token=${m.token} at=${m.sentAt}\n  ${m.text.replace(/\n/g, " ")}`,
  );
  return `You extract ATOM demand candidates from chat messages.

Rules:
- Return only candidates that are real work requests (not greetings or acknowledgements).
- Every candidate MUST include ≥1 ref. Use the message token exactly; never invent tokens.
- confidence is 0..1.
- cluster_key should be stable, e.g. msg:<id>.

Messages:
${lines.join("\n") || "(none)"}
`;
}

function defaultSpawn(
  bin: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      reject(
        new Error(
          `GrokCliExtractAgent: failed to spawn ${bin} (${err.message}). Set ATOM_GROK_BIN or use ATOM_EXTRACT_AGENT=heuristic.`,
        ),
      );
    });
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}
