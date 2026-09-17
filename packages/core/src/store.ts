import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Actor, Atom, AtomType, Ref } from "./types.ts";

type EventRow = {
  id: string;
  type: string;
  subject_id: string;
  summary: string;
  detail_json: string;
  refs_json: string;
  actor: string;
  created_at: string;
};

export class AtomStore {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        refs_json TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_subject ON events(subject_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
      CREATE TABLE IF NOT EXISTS cursors (
        adapter_id TEXT PRIMARY KEY,
        cursor TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  append(atom: Atom): void {
    this.db
      .prepare(
        `INSERT INTO events (id, type, subject_id, summary, detail_json, refs_json, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        atom.id,
        atom.type,
        atom.subject_id,
        atom.summary,
        JSON.stringify(atom.detail ?? {}),
        JSON.stringify(atom.refs),
        atom.actor,
        atom.created_at,
      );
  }

  listAll(): Atom[] {
    const rows = this.db
      .prepare(`SELECT * FROM events ORDER BY created_at ASC, id ASC`)
      .all() as EventRow[];
    return rows.map(rowToAtom);
  }

  /**
   * Pull-API seam: atoms after `cursor` (last-seen id), optional type filter.
   * Later HTTP: `GET /atoms?since=<cursor>&type=…`. Stage-1 has no server.
   */
  listSince(
    cursor: string | null,
    opts: { types?: AtomType[]; limit?: number } = {},
  ): { atoms: Atom[]; nextCursor: string | null } {
    let atoms = this.listAll();
    if (opts.types && opts.types.length > 0) {
      const allow = new Set(opts.types);
      atoms = atoms.filter((a) => allow.has(a.type));
    }
    if (cursor) {
      const idx = atoms.findIndex((a) => a.id === cursor);
      atoms = idx >= 0 ? atoms.slice(idx + 1) : atoms;
    }
    const limit = opts.limit;
    if (typeof limit === "number" && limit >= 0) atoms = atoms.slice(0, limit);
    const last = atoms[atoms.length - 1];
    return { atoms, nextCursor: last?.id ?? cursor };
  }

  hasSubject(type: AtomType, subjectId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS ok FROM events WHERE type = ? AND subject_id = ? LIMIT 1`)
      .get(type, subjectId) as { ok: number } | undefined;
    return Boolean(row);
  }

  getCursor(adapterId: string): string | null {
    const row = this.db
      .prepare(`SELECT cursor FROM cursors WHERE adapter_id = ?`)
      .get(adapterId) as { cursor: string } | undefined;
    return row?.cursor ?? null;
  }

  setCursor(adapterId: string, cursor: string, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO cursors (adapter_id, cursor, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(adapter_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
      )
      .run(adapterId, cursor, updatedAt);
  }

  close(): void {
    this.db.close();
  }
}

function rowToAtom(row: EventRow): Atom {
  return {
    id: row.id,
    type: row.type as AtomType,
    subject_id: row.subject_id,
    summary: row.summary,
    detail: JSON.parse(row.detail_json) as unknown,
    refs: JSON.parse(row.refs_json) as Ref[],
    actor: row.actor as Actor,
    created_at: row.created_at,
  };
}
