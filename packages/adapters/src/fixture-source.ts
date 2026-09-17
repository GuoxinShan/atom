import { readFileSync } from "node:fs";
import type { RawMessage, SourceAdapter } from "@atom/core";

export class FixtureSource implements SourceAdapter {
  readonly id: string;
  private readonly filePath: string;
  private readonly seedCursor?: string;

  constructor(opts: { id?: string; filePath: string; seedCursor?: string }) {
    this.id = opts.id ?? "fixture";
    this.filePath = opts.filePath;
    this.seedCursor = opts.seedCursor;
  }

  async pullSince(cursor: string | null): Promise<{
    messages: RawMessage[];
    nextCursor: string;
  }> {
    const messages = readJsonl(this.filePath, this.id);
    const from = cursor ?? this.seedCursor ?? null;
    const start = from ? messages.findIndex((m) => m.id === from) + 1 : 0;
    const slice =
      start <= 0 && from && !messages.some((m) => m.id === from)
        ? messages
        : messages.slice(Math.max(0, start));
    const last = slice.at(-1) ?? messages.at(-1);
    return { messages: slice, nextCursor: last?.id ?? from ?? "" };
  }
}

function readJsonl(path: string, sourceId: string): RawMessage[] {
  const text = readFileSync(path, "utf8");
  const out: RawMessage[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const raw = JSON.parse(trimmed) as Record<string, unknown>;
    const id = String(raw.id ?? "");
    const groupId = raw.groupId ? String(raw.groupId) : "fixture";
    if (!id) continue;
    out.push({
      id,
      sourceId,
      groupId,
      author: String(raw.author ?? "unknown"),
      text: String(raw.text ?? raw.body ?? ""),
      sentAt: String(raw.sentAt ?? new Date().toISOString()),
      token: String(raw.token ?? `yzj:im:${groupId}:${id}`),
      cursor: id,
    });
  }
  return out;
}
