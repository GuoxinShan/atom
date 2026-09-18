import fs from "node:fs";
import path from "node:path";
import { EventStore } from "../store/events.js";
import { candidatesByStatus } from "../store/candidates.js";

function shanghaiStamp(date = new Date()): string {
  // en-CA yields YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function writeDigest(
  store: EventStore,
  repoRoot: string,
  date = new Date()
): string {
  const stamp = shanghaiStamp(date);

  const suggested = candidatesByStatus(store, "suggested");
  const accepted = candidatesByStatus(store, "accepted");
  const rejected = candidatesByStatus(store, "rejected");
  const messages = store.list({ type: "message_ingested", limit: 5000 });

  const lines: string[] = [
    `# ATOM 需求日报 · ${stamp}`,
    "",
    `生成时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} (CST)`,
    "",
    "## 概览",
    "",
    `- 已摄入消息：${messages.length}`,
    `- Suggested：${suggested.length}`,
    `- Accepted：${accepted.length}`,
    `- Rejected：${rejected.length}`,
    "",
    "## Suggested 候选",
    "",
  ];

  if (suggested.length === 0) {
    lines.push("_（暂无）_", "");
  } else {
    for (const c of suggested) {
      lines.push(`### ${c.title}`);
      lines.push("");
      lines.push(`- id: \`${c.id}\``);
      lines.push(`- confidence: ${c.confidence}`);
      lines.push(`- body: ${c.body}`);
      lines.push("- refs:");
      for (const r of c.refs) {
        lines.push(`  - \`${r.token}\`${r.digest ? ` — ${r.digest}` : ""}`);
      }
      lines.push("");
    }
  }

  lines.push("## Accepted", "");
  if (accepted.length === 0) lines.push("_（暂无）_", "");
  else {
    for (const c of accepted) {
      lines.push(`- **${c.title}** (\`${c.id}\`)`);
    }
    lines.push("");
  }

  lines.push("## Rejected", "");
  if (rejected.length === 0) lines.push("_（暂无）_", "");
  else {
    for (const c of rejected) {
      lines.push(`- ~~${c.title}~~ (\`${c.id}\`)`);
    }
    lines.push("");
  }

  lines.push("---", "", "_ATOM Stage-1 · projection only; SQLite events remain source of truth._", "");

  const outDir = path.join(repoRoot, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `digest-${stamp}.md`);
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
  return outPath;
}
