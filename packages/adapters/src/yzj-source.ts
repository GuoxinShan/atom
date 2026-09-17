import { spawn } from "node:child_process";
import type { RawMessage, SourceAdapter } from "@atom/core";

/**
 * Thin Yunzhijia CLI wrapper. Does not embed employer schemas.
 * Expected: `$ATOM_YZJ_BIN im messages --json [--since CURSOR] [--group-id ID]`
 */
export class YzjSource implements SourceAdapter {
  readonly id = "yzj";

  constructor(
    private readonly bin = process.env.ATOM_YZJ_BIN ?? "yzj-cli",
    private readonly groupId = process.env.ATOM_YZJ_GROUP_ID,
  ) {}

  async pullSince(cursor: string | null): Promise<{
    messages: RawMessage[];
    nextCursor: string;
  }> {
    const args = ["im", "messages", "--json"];
    if (cursor) args.push("--since", cursor);
    if (this.groupId) args.push("--group-id", this.groupId);
    const { stdout, stderr, code } = await run(this.bin, args);
    if (code !== 0) {
      throw new Error(
        `YzjSource: ${this.bin} exited ${code}. Install yzj-cli or use ATOM_SOURCE=fixture.\n${stderr}`,
      );
    }
    const parsed = parseYzj(stdout, cursor);
    return parsed;
  }
}

function parseYzj(
  stdout: string,
  fallbackCursor: string | null,
): { messages: RawMessage[]; nextCursor: string } {
  const trimmed = stdout.trim();
  if (!trimmed) return { messages: [], nextCursor: fallbackCursor ?? "" };
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    data = trimmed
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  }
  const list = Array.isArray(data)
    ? data
    : ((data as { messages?: unknown[] }).messages ?? []);
  const messages = list.map((item) => normalize(item as Record<string, unknown>));
  const next =
    (data as { nextCursor?: string }).nextCursor ??
    messages.at(-1)?.id ??
    fallbackCursor ??
    "";
  return { messages, nextCursor: next };
}

function normalize(raw: Record<string, unknown>): RawMessage {
  const id = String(raw.id ?? raw.msgId ?? raw.messageId ?? "");
  const groupId = String(raw.groupId ?? raw.group_id ?? raw.chatId ?? "yzj");
  const authorObj = raw.from as { name?: string; openId?: string } | undefined;
  return {
    id,
    sourceId: "yzj",
    groupId,
    author: String(raw.author ?? raw.sender ?? authorObj?.name ?? "unknown"),
    text: String(raw.text ?? raw.content ?? raw.body ?? ""),
    sentAt: String(raw.sentAt ?? raw.createTime ?? raw.created_at ?? new Date().toISOString()),
    token: String(raw.token ?? `yzj:im:${groupId}:${id}`),
    cursor: id,
  };
}

function run(
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
          `YzjSource: failed to spawn ${bin} (${err.message}). Set ATOM_YZJ_BIN or use ATOM_SOURCE=fixture.`,
        ),
      );
    });
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}
