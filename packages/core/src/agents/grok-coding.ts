import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodingAgent, SpecDraft, HandoffPack } from "../schema/types.js";
import { newId } from "../schema/ids.js";

/**
 * Coding seam via local Grok Build CLI.
 * LeadAgent supplies workDir + briefing so work lands in the right workspace.
 */
export class GrokCliCodingAgent implements CodingAgent {
  readonly id = "grok-cli-coding";

  constructor(
    private readonly opts: {
      repoRoot: string;
      bin?: string;
      workDir?: string;
    }
  ) {}

  async handoff(
    spec: SpecDraft,
    opts?: { run?: boolean; workDir?: string; briefing?: string }
  ): Promise<HandoffPack> {
    const packId = newId("handoff");
    const dir = path.join(this.opts.repoRoot, "out", "handoffs");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${packId}.md`);
    const cwd = opts?.workDir ?? this.opts.workDir ?? this.opts.repoRoot;
    const body = [
      `# Handoff · ${spec.title}`,
      "",
      `Routed workspace: \`${cwd}\``,
      "",
      spec.body || spec.title,
      "",
      "## Acceptance criteria",
      ...spec.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`),
      "",
      "## Refs",
      ...spec.refs.map((r) => `- ${r.token}`),
      "",
      opts?.briefing ? `## Lead briefing\n\n${opts.briefing}` : "",
      "",
    ].join("\n");
    fs.writeFileSync(filePath, body, "utf8");

    if (opts?.run) {
      const bin = this.opts.bin ?? process.env.ATOM_GROK_BIN ?? "grok";
      const prompt = [
        opts?.briefing ?? "",
        "",
        "Implement ONLY in the routed workspace cwd.",
        "Respect acceptance criteria and cited refs.",
        "",
        fs.readFileSync(filePath, "utf8"),
      ].join("\n");
      await runGrokOnce(bin, cwd, prompt);
    }

    return {
      id: packId,
      spec_id: spec.id,
      candidate_id: spec.candidate_id,
      path: filePath,
      target: "grok-cli",
    };
  }
}

function runGrokOnce(bin: string, cwd: string, prompt: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const promptFile = path.join(os.tmpdir(), `atom-code-${Date.now()}.md`);
    fs.writeFileSync(promptFile, prompt, "utf8");
    const child = spawn(
      bin,
      [
        "--always-approve",
        "--cwd",
        cwd,
        "--max-turns",
        process.env.ATOM_GROK_MAX_TURNS ?? "20",
        "--prompt-file",
        promptFile,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      try {
        fs.unlinkSync(promptFile);
      } catch {
        /* ignore */
      }
      reject(err);
    });
    child.on("close", (code) => {
      try {
        fs.unlinkSync(promptFile);
      } catch {
        /* ignore */
      }
      if (code !== 0) reject(new Error(stderr || `grok exit ${code}`));
      else resolve();
    });
  });
}
