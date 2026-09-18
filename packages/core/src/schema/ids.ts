import { randomBytes } from "node:crypto";

export function newId(prefix = "evt"): string {
  const t = Date.now().toString(36);
  const r = randomBytes(6).toString("hex");
  return `${prefix}_${t}_${r}`;
}

export function refTokenForMessage(msg: { source: string; groupId?: string; id: string }): string {
  const group = msg.groupId ?? "unknown";
  return `${msg.source}:im:${group}:${msg.id}`;
}
