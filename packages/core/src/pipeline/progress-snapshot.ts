import fs from "node:fs";
import path from "node:path";

/** v1 progress sources — existing `data/workspaces.json` ids only. */
export const PROGRESS_WORKSPACE_IDS = ["atom", "yzj", "ai-advance"] as const;
export type ProgressWorkspaceId = (typeof PROGRESS_WORKSPACE_IDS)[number];

export const PROGRESS_SNAPSHOT_FILE = "data/progress-snapshot.json";

export type ProgressItemKind = "pr" | "issue" | "commit";

export type ProgressItem = {
  kind: ProgressItemKind;
  title: string;
  body?: string;
  url?: string;
  sha?: string;
  number?: number;
  at?: string;
  workspace_id: string;
};

export type ProgressWorkspaceScan = {
  id: string;
  path: string;
  available: boolean;
  fail_open: boolean;
  reason?: string;
  preserved?: boolean;
  preserved_from?: string;
  items: ProgressItem[];
};

export type ProgressSnapshot = {
  version: 1;
  generated_at: string;
  source: "progress-scan";
  since_days: number;
  workspaces: ProgressWorkspaceScan[];
};

export function isProgressWorkspaceId(id: string): id is ProgressWorkspaceId {
  return (PROGRESS_WORKSPACE_IDS as readonly string[]).includes(id);
}

export function progressSnapshotPath(repoRoot: string): string {
  return path.join(repoRoot, PROGRESS_SNAPSHOT_FILE);
}

function asItem(raw: unknown, workspaceId: string): ProgressItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind === "pr" || o.kind === "issue" || o.kind === "commit" ? o.kind : null;
  const title = typeof o.title === "string" ? o.title.trim() : "";
  if (!kind || !title) return null;
  const body = typeof o.body === "string" ? o.body : undefined;
  const url = typeof o.url === "string" ? o.url : undefined;
  const sha = typeof o.sha === "string" ? o.sha : undefined;
  const number = typeof o.number === "number" && Number.isFinite(o.number) ? o.number : undefined;
  const at = typeof o.at === "string" ? o.at : undefined;
  return {
    kind,
    title,
    ...(body ? { body } : {}),
    ...(url ? { url } : {}),
    ...(sha ? { sha } : {}),
    ...(number != null ? { number } : {}),
    ...(at ? { at } : {}),
    workspace_id: typeof o.workspace_id === "string" && o.workspace_id ? o.workspace_id : workspaceId,
  };
}

function asWorkspace(raw: unknown): ProgressWorkspaceScan | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim() : "";
  if (!id) return null;
  const wsPath = typeof o.path === "string" ? o.path : "";
  const itemsRaw = Array.isArray(o.items) ? o.items : [];
  const items = itemsRaw.map((it) => asItem(it, id)).filter((it): it is ProgressItem => Boolean(it));
  return {
    id,
    path: wsPath,
    available: o.available === true,
    fail_open: o.fail_open === true,
    reason: typeof o.reason === "string" && o.reason.trim() ? o.reason.trim() : undefined,
    preserved: o.preserved === true ? true : undefined,
    preserved_from: typeof o.preserved_from === "string" ? o.preserved_from : undefined,
    items,
  };
}

/** Read snapshot. Missing / unreadable → null (Done gate fail-opens repo matching). */
export function loadProgressSnapshot(repoRoot: string): ProgressSnapshot | null {
  const p = progressSnapshotPath(repoRoot);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    if (raw.version !== 1) return null;
    const workspaces = Array.isArray(raw.workspaces)
      ? raw.workspaces.map(asWorkspace).filter((w): w is ProgressWorkspaceScan => Boolean(w))
      : [];
    return {
      version: 1,
      generated_at: typeof raw.generated_at === "string" ? raw.generated_at : "",
      source: "progress-scan",
      since_days: typeof raw.since_days === "number" && Number.isFinite(raw.since_days) ? raw.since_days : 90,
      workspaces,
    };
  } catch {
    return null;
  }
}

export function writeProgressSnapshot(repoRoot: string, snapshot: ProgressSnapshot): string {
  const p = progressSnapshotPath(repoRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  return p;
}

/** Keep previous items when a workspace is unavailable this run (Docker / missing git). */
export function preserveUnavailableWorkspaces(
  next: ProgressSnapshot,
  prev: ProgressSnapshot | null
): ProgressSnapshot {
  if (!prev?.workspaces.length) return next;
  const byId = new Map(prev.workspaces.map((w) => [w.id, w]));
  return {
    ...next,
    workspaces: next.workspaces.map((ws) => {
      if (ws.available || ws.items.length) return ws;
      const old = byId.get(ws.id);
      if (!old?.items.length) return ws;
      return {
        ...ws,
        items: old.items,
        preserved: true,
        preserved_from: prev.generated_at,
        reason: ws.reason
          ? `${ws.reason} (kept ${old.items.length} prior items)`
          : `unavailable — kept ${old.items.length} prior items`,
      };
    }),
  };
}
