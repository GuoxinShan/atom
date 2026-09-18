import fs from "node:fs";
import path from "node:path";
import { RawMessage, SourceAdapter } from "@atom/core";

export class FixtureSource implements SourceAdapter {
  readonly id: string;
  constructor(
    private readonly filePath: string,
    id = "fixture"
  ) {
    this.id = id;
  }

  async pullSince(cursor: string | null): Promise<{ messages: RawMessage[]; nextCursor: string }> {
    const abs = path.resolve(this.filePath);
    const text = fs.readFileSync(abs, "utf8");
    const all: RawMessage[] = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RawMessage);

    const start = cursor ? Number(cursor) || 0 : 0;
    const messages = all.slice(start);
    const nextCursor = String(all.length);
    return { messages, nextCursor };
  }
}
