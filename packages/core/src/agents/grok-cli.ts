import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExtractAgent, CandidateProposal, CandidateProposalSchema, RawMessage } from "../schema/types.js";
import { refTokenForMessage } from "../schema/ids.js";
import { isNoiseProposal } from "./noise.js";

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

/** Strip every built-in tool so extract cannot wander the repo. */
const EXTRACT_DISALLOWED_TOOLS = [
  "run_terminal_cmd",
  "bash",
  "read_file",
  "search_replace",
  "grep",
  "grep_search",
  "list_dir",
  "web_search",
  "web_fetch",
  "todo_write",
  "task",
  "kill_task",
  "get_task_output",
  "memory_search",
  "memory_get",
  "search_tool",
  "use_tool",
  "lsp",
].join(",");

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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-extract-"));
    const promptFile = path.join(tmpDir, "prompt.md");
    fs.writeFileSync(promptFile, prompt, "utf8");

    let stdout: string;
    try {
      stdout = await runGrok(
        bin,
        promptFile,
        schemaStr,
        tmpDir,
        this.opts.timeoutMs ?? Number(process.env.ATOM_GROK_TIMEOUT_MS ?? 180_000),
        this.opts.maxTurns ?? Number(process.env.ATOM_GROK_MAX_TURNS ?? 3)
      );
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }

    const parsed = parseGrokJson(stdout);
    const byId = new Map(messages.map((m) => [m.id, m]));
    const out: CandidateProposal[] = [];

    for (const c of parsed.candidates ?? []) {
      const title = String(c.title ?? "").trim();
      if (!title || /^placeholder$/i.test(title)) continue;
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
        title: title || "Untitled demand",
        body: String(c.body ?? ""),
        confidence: Number(c.confidence ?? 0.7),
        cluster_key: c.cluster_key ? String(c.cluster_key) : undefined,
        refs,
        source_message_ids: ids,
      });
      if (proposal.success) {
        if (isNoiseProposal(proposal.data.title, proposal.data.body)) continue;
        out.push(proposal.data);
      }
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
    "Hard constraints:",
    "- Do NOT use tools, read files, or explore any repository.",
    "- Emit exactly ONE JSON object matching the schema. No markdown fences.",
    "- Never emit a Placeholder / draft / TODO title.",
    "- Only keep actionable demands / asks / bugs / missing capabilities.",
    "- Drop acknowledgements (收到✅), FYIs, bot digests (【来自Grok Bot自动发送】 / 已记入本周台账), log dumps, and chatter.",
    "- Drop titles shorter than 6 characters or truncated mid-sentence (e.g. ending with bare （dev or only [2026-).",
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
  cwd: string,
  timeoutMs: number,
  maxTurns: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      [
        "--always-approve",
        "--max-turns",
        String(maxTurns),
        "--cwd",
        cwd,
        "--disable-web-search",
        "--no-subagents",
        "--disallowed-tools",
        EXTRACT_DISALLOWED_TOOLS,
        "--rules",
        "Do not use tools. Return exactly one JSON object matching the provided schema. No Placeholder titles.",
        "--json-schema",
        schema,
        "--prompt-file",
        promptFile,
        "--output-format",
        "json",
      ],
      { stdio: ["ignore", "pipe", "pipe"], cwd }
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

type CandidatesBlob = { candidates?: Array<Record<string, unknown>> };

/** Exported for unit tests / debug. */
export function parseGrokJson(stdout: string): CandidatesBlob {
  const trimmed = stdout.trim();
  if (!trimmed) return { candidates: [] };

  const blobs: CandidatesBlob[] = [];

  const consider = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.candidates)) {
      blobs.push(obj as CandidatesBlob);
    }
    // Envelope from `grok --output-format json`
    if (typeof obj.text === "string" && obj.text.trim()) {
      for (const nested of extractJsonObjects(obj.text)) consider(nested);
      try {
        consider(JSON.parse(obj.text));
      } catch {
        /* concatenated handled by extractJsonObjects */
      }
    }
  };

  try {
    consider(JSON.parse(trimmed));
  } catch {
    for (const obj of extractJsonObjects(trimmed)) consider(obj);
  }

  if (blobs.length === 0) {
    throw new Error("grok stdout had no candidates JSON");
  }

  // Prefer the richest non-placeholder blob (Grok sometimes emits a draft then a final).
  const scored = blobs.map((b) => {
    const list = (b.candidates ?? []).filter((c) => {
      const t = String(c.title ?? "").trim();
      return t && !/^placeholder$/i.test(t);
    });
    return { blob: { candidates: list }, score: list.length };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.blob ?? { candidates: [] };
}

/** Pull every top-level `{...}` object from a string (handles `}{` concatenation). */
export function extractJsonObjects(s: string): unknown[] {
  const out: unknown[] = [];
  let i = 0;
  while (i < s.length) {
    const start = s.indexOf("{", i);
    if (start < 0) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let closed = false;
    for (let j = start; j < s.length; j++) {
      const ch = s[j]!;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const slice = s.slice(start, j + 1);
          try {
            out.push(JSON.parse(slice));
          } catch {
            /* skip malformed */
          }
          i = j + 1;
          closed = true;
          break;
        }
      }
    }
    if (!closed) break;
  }
  return out;
}
