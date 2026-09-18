import { EventStore } from "../store/events.js";

export const META_LAST_EXTRACT = "last_extract_at";
export const META_LAST_RUN = "last_run_at";

export interface RuntimeMeta {
  lastExtractAt: string | null;
  lastRunAt: string | null;
}

function isIso(s: string | null): s is string {
  if (!s) return false;
  return !Number.isNaN(Date.parse(s));
}

function looksLikeExtract(ev: { summary: string; detail_json: string }): boolean {
  if (/extract/i.test(ev.summary)) return true;
  try {
    const d = JSON.parse(ev.detail_json) as { kind?: string };
    return d.kind === "extract";
  } catch {
    return false;
  }
}

export function recordExtractFinished(store: EventStore, at = new Date()): void {
  store.setMeta(META_LAST_EXTRACT, at.toISOString());
}

export function recordRunFinished(store: EventStore, at = new Date()): void {
  store.setMeta(META_LAST_RUN, at.toISOString());
}

/** Real timestamps only — never invent a last-run clock. */
export function readRuntimeMeta(store: EventStore): RuntimeMeta {
  let lastExtractAt = store.getMeta(META_LAST_EXTRACT);
  const lastRunAtRaw = store.getMeta(META_LAST_RUN);
  if (!isIso(lastExtractAt)) {
    const ev = store.listNewest({ type: "agent_completed", limit: 30 }).find(looksLikeExtract);
    lastExtractAt = ev?.created_at ?? null;
  }
  return {
    lastExtractAt: isIso(lastExtractAt) ? lastExtractAt : null,
    lastRunAt: isIso(lastRunAtRaw) ? lastRunAtRaw : null,
  };
}
