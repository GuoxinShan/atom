import { SourceAdapter } from "../schema/types.js";
import { EventStore } from "../store/events.js";
import { refTokenForMessage } from "../schema/ids.js";

export async function ingestFromSource(
  store: EventStore,
  source: SourceAdapter,
  opts?: { groupIds?: string[] }
): Promise<{ ingested: number; nextCursor: string }> {
  const cursorKey = `cursor:${source.id}`;
  const cursor = store.getMeta(cursorKey);
  const { messages, nextCursor } = await source.pullSince(
    cursor,
    opts?.groupIds?.length ? { groupIds: opts.groupIds } : undefined
  );

  let ingested = 0;
  for (const msg of messages) {
    const existing = store.list({ type: "message_ingested", subject_id: msg.id, limit: 1 });
    if (existing.length > 0) continue;

    store.append({
      type: "message_ingested",
      subject_id: msg.id,
      summary: `${msg.author ?? "unknown"}: ${msg.text.slice(0, 80)}`,
      detail: {
        source: msg.source,
        groupId: msg.groupId,
        author: msg.author,
        text: msg.text,
        ts: msg.ts,
        adapter_id: source.id,
        cursor: nextCursor,
      },
      refs: [
        {
          token: refTokenForMessage(msg),
          kind: "im",
          digest: msg.text.slice(0, 80),
        },
      ],
      actor: "system",
      created_at: msg.ts || new Date().toISOString(),
    });
    ingested += 1;
  }

  store.setMeta(cursorKey, nextCursor);
  return { ingested, nextCursor };
}
