import { spawn } from "node:child_process";
import type { RawMessage, SourceAdapter, SourceConfig } from "@atom/core";

/**
 * Thin Yunzhijia CLI wrapper. Does not embed employer schemas.
 * Group ids come from SourceConfig.groupIds (not env-only).
 * Expected: `$bin im messages --json [--since CURSOR] [--group-id ID]`
 */
export class YzjSource implements SourceAdapter {
  readonly id: string;
  private readonly bin: string;
  private readonly groupIds: string[];
  private readonly credentialRef?: string;
  private readonly seedCursor?: string;

  constructor(config: SourceConfig | { id?: string; bin?: string; groupId?: string } = {}) {
    if (isSourceConfig(config)) {
      this.id = config.id;
      this.bin = stringSetting(config.settings?.bin) ?? process.env.ATOM_YZJ_BIN ?? "yzj-cli";
      this.groupIds = config.groupIds?.length ? config.groupIds : envGroupIds();
      this.credentialRef = config.credentialRef;
      this.seedCursor =
        typeof config.cursor === "string"
          ? config.cursor
          : config.cursor
            ? JSON.stringify(config.cursor)
            : undefined;
    } else {
      this.id = config.id ?? "yzj";
      this.bin = config.bin ?? process.env.ATOM_YZJ_BIN ?? "yzj-cli";
      this.groupIds = config.groupId ? [config.groupId] : envGroupIds();
    }
    void this.credentialRef;
  }

  async pullSince(cursor: string | null): Promise<{
    messages: RawMessage[];
    nextCursor: string;
  }> {
    const from = cursor ?? this.seedCursor ?? null;
    if (this.groupIds.length === 0) {
      return this.pullGroup(null, from);
    }
    const prev = parseCursorMap(from);
    const all: RawMessage[] = [];
    const nextMap: Record<string, string> = { ...prev };
    for (const groupId of this.groupIds) {
      const { messages, nextCursor } = await this.pullGroup(groupId, prev[groupId] ?? null);
      all.push(...messages);
      nextMap[groupId] = nextCursor;
    }
    return { messages: all, nextCursor: JSON.stringify(nextMap) };
  }

  private async pullGroup(
    groupId: string | null,
    cursor: string | null,
  ): Promise<{ messages: RawMessage[]; nextCursor: string }> {
    const args = ["im", "messages", "--json"];
    if (cursor) args.push("--since", cursor);
    if (groupId) args.push("--group-id", groupId);
    const { stdout, stderr, code } = await run(this.bin, args);
    if (code !== 0) {
      throw new Error(
        `YzjSource ${this.id}: ${this.bin} exited ${code}. Check source config groupIds / credentialRef.\n${stderr}`,
      );
    }
    return parseYzj(stdout, cursor, this.id);
  }
}

function isSourceConfig(v: object): v is SourceConfig {
  return "type" in v && "id" in v;
}

function envGroupIds(): string[] {
  const one = process.env.ATOM_YZJ_GROUP_ID;
  return one ? [one] : [];
}

function stringSetting(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function parseCursorMap(cursor: string | null): Record<string, string> {
  if (!cursor) return {};
  try {
    const parsed = JSON.parse(cursor) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
    }
  } catch {
    return { "*": cursor };
  }
  return { "*": cursor };
}

function parseYzj(
  stdout: string,
  fallbackCursor: string | null,
  sourceId: string,
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
  const messages = list.map((item) => normalize(item as Record<string, unknown>, sourceId));
  const next =
    (data as { nextCursor?: string }).nextCursor ??
    messages.at(-1)?.id ??
    fallbackCursor ??
    "";
  return { messages, nextCursor: next };
}

function normalize(raw: Record<string, unknown>, sourceId: string): RawMessage {
  const id = String(raw.id ?? raw.msgId ?? raw.messageId ?? "");
  const groupId = String(raw.groupId ?? raw.group_id ?? raw.chatId ?? "yzj");
  const authorObj = raw.from as { name?: string; openId?: string } | undefined;
  return {
    id,
    sourceId,
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
          `YzjSource: failed to spawn ${bin} (${err.message}). Set settings.bin or ATOM_YZJ_BIN.`,
        ),
      );
    });
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}
