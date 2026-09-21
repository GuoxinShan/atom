import { spawn } from "node:child_process";
import { parseRecentPrivateGroupIds, RawMessage, SourceAdapter } from "@atom/core";

/**
 * SourceAdapter wrapping `yzj-cli im message list`.
 * Cursor = last seen msgId (comma-joined per group is not used; global last msgId set).
 * yzj-cli has no --since; we pull newest/new and skip already-seen ids upstream in ingest.
 */
export class YzjSource implements SourceAdapter {
  readonly id: string;

  constructor(
    private readonly opts: {
      id?: string;
      groupIds?: string[];
      cli?: string;
      limit?: number;
    } = {}
  ) {
    this.id = opts.id ?? "yzj";
  }

  private groupIds(): string[] {
    const fromEnv = (process.env.ATOM_YZJ_GROUP_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return fromEnv.length ? fromEnv : this.opts.groupIds ?? [];
  }

  async pullSince(
    cursor: string | null,
    opts?: { groupIds?: string[] }
  ): Promise<{ messages: RawMessage[]; nextCursor: string }> {
    const groups = opts?.groupIds?.length ? opts.groupIds : this.groupIds();
    if (groups.length === 0) {
      console.warn(
        "[yzj] no group ids configured (set ATOM_YZJ_GROUP_IDS or sources.json groupIds); returning empty"
      );
      return { messages: [], nextCursor: cursor ?? "" };
    }

    const cli = this.opts.cli ?? process.env.ATOM_YZJ_CLI ?? "yzj-cli";
    const limit = Math.min(
      20,
      Math.max(1, Number(process.env.ATOM_YZJ_LIMIT ?? this.opts.limit ?? 20))
    );
    // First pull: newest. Subsequent: type=new from last msg id when cursor looks like a msgId.
    const queryType = cursor && cursor.length > 8 ? "new" : "newest";
    const messages: RawMessage[] = [];

    for (const groupId of groups) {
      try {
        const args = [
          "im",
          "message",
          "list",
          "--group-id",
          groupId,
          "--type",
          queryType,
          "--limit",
          String(limit),
        ];
        if (queryType === "new" && cursor) {
          args.push("--msg-id", cursor);
        }
        const out = await runCli(cli, args);
        const parsed = parseMessages(out, groupId);
        messages.push(...parsed);
      } catch (err) {
        console.warn(`[yzj] list failed for ${groupId}: ${(err as Error).message}`);
      }
    }

    // Prefer newest msgId as cursor (yzj msgIds are roughly time-sortable hex)
    const nextCursor =
      messages.map((m) => m.id).sort().at(-1) ?? cursor ?? "";
    return { messages, nextCursor };
  }
}

function runCli(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        reject(
          new Error(
            `${bin} not found on PATH (ENOENT). The Desk image installs Linux @yunzhijia/cli; a Mac yzj-cli bind-mount will not exec.`
          )
        );
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr || `exit ${code}`));
      else resolve(stdout);
    });
  });
}

function parseMessages(out: string, groupId: string): RawMessage[] {
  const trimmed = out.trim();
  if (!trimmed) return [];
  try {
    const data = JSON.parse(trimmed) as Record<string, unknown>;
    const list =
      (Array.isArray(data) && data) ||
      (Array.isArray((data as { data?: { list?: unknown } }).data?.list) &&
        (data as { data: { list: unknown[] } }).data.list) ||
      (Array.isArray((data as { list?: unknown }).list) &&
        (data as { list: unknown[] }).list) ||
      (Array.isArray((data as { messages?: unknown }).messages) &&
        (data as { messages: unknown[] }).messages) ||
      [];

    return (list as Record<string, unknown>[])
      .map((r) => {
        const id = String(r.msgId ?? r.id ?? r.messageId ?? "");
        const text = String(r.content ?? r.text ?? r.body ?? "");
        if (!id || !text.trim()) return null;
        const sendTime = String(r.sendTime ?? r.ts ?? r.createdAt ?? r.time ?? "");
        let ts = sendTime;
        // "2026-09-15 23:58:42.858" → ISO-ish
        if (/^\d{4}-\d{2}-\d{2} /.test(sendTime)) {
          ts = sendTime.replace(" ", "T") + "+08:00";
        }
        return {
          id,
          source: "yzj",
          groupId,
          author: r.fromOpenId
            ? String(r.fromOpenId)
            : r.author
              ? String(r.author)
              : undefined,
          text,
          ts: ts || new Date().toISOString(),
          raw: r,
        } satisfies RawMessage;
      })
      .filter((m): m is RawMessage => m !== null);
  } catch {
    console.warn("[yzj] non-JSON CLI output; ignoring");
    return [];
  }
}

/**
 * Recent Yunzhijia private chats (`type: 1`) via `yzj-cli im group recent`.
 * Returns ids only — never logs message contents. Caller applies recentDmLimit.
 */
export async function listRecentYzjPrivateChats(opts: {
  cli?: string;
  limit?: number;
} = {}): Promise<string[]> {
  const cli = opts.cli ?? process.env.ATOM_YZJ_CLI ?? "yzj-cli";
  const out = await runCli(cli, ["im", "group", "recent"]);
  const ids = parseRecentPrivateGroupIds(out);
  if (opts.limit == null) return ids;
  return ids.slice(0, Math.max(0, opts.limit));
}
