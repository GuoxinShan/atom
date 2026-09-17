import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Candidate } from "./types.ts";
import { utcDateStamp } from "./ids.ts";

export function renderDigest(candidates: Candidate[], generatedAt = new Date()): string {
  const suggested = candidates.filter((c) => c.status === "suggested");
  const accepted = candidates.filter((c) => c.status === "accepted");
  const rejected = candidates.filter((c) => c.status === "rejected");
  const lines: string[] = [
    `# ATOM 需求日报 · ${utcDateStamp(generatedAt)}`,
    "",
    `Generated: ${generatedAt.toISOString()}`,
    "",
    `| suggested | accepted | rejected |`,
    `| ---: | ---: | ---: |`,
    `| ${suggested.length} | ${accepted.length} | ${rejected.length} |`,
    "",
  ];
  lines.push("## Suggested", "");
  if (suggested.length === 0) lines.push("_None._", "");
  for (const c of suggested) lines.push(...renderCandidate(c));
  lines.push("## Accepted", "");
  if (accepted.length === 0) lines.push("_None._", "");
  for (const c of accepted) lines.push(...renderCandidate(c));
  lines.push("## Rejected", "");
  if (rejected.length === 0) lines.push("_None._", "");
  for (const c of rejected) lines.push(...renderCandidate(c));
  return lines.join("\n");
}

function renderCandidate(c: Candidate): string[] {
  const refs =
    c.refs.length === 0
      ? "_missing_"
      : c.refs.map((r) => `\`${r.token}\``).join(", ");
  return [
    `### ${c.title}`,
    "",
    `- id: \`${c.id}\``,
    `- status: ${c.status}`,
    `- confidence: ${c.confidence}`,
    `- refs: ${refs}`,
    "",
    c.body,
    "",
  ];
}

export function writeDigestFile(outDir: string, markdown: string, generatedAt = new Date()): string {
  const path = join(outDir, `${utcDateStamp(generatedAt)}.md`);
  writeFileSync(path, markdown, "utf8");
  return path;
}
