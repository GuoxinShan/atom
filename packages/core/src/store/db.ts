import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export type SqlJsDatabase = {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  prepare(sql: string): {
    bind(params?: unknown[]): void;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
    run(params?: unknown[]): void;
  };
  export(): Uint8Array;
  close?: () => void;
};

export type BetterDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
  pragma(s: string): unknown;
};

export type AtomDb =
  | { kind: "better-sqlite3"; db: BetterDatabase; filePath: string }
  | {
      kind: "sqljs";
      db: SqlJsDatabase;
      filePath: string;
      persist: () => void;
      /** Reload in-memory DB if another process rewrote the file. */
      refresh: () => void;
      mtimeMs: number;
      SQL: { Database: new (data?: ArrayLike<number>) => SqlJsDatabase };
    };

const require = createRequire(import.meta.url);

const SCHEMA = `
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
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_subject ON events(subject_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function defaultDbPath(repoRoot: string): string {
  return path.join(repoRoot, "data", "atom.sqlite");
}

function fileMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

export async function openDb(filePath: string): Promise<AtomDb> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  try {
    const Database = require("better-sqlite3") as new (f: string) => BetterDatabase;
    const db = new Database(filePath);
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    return { kind: "better-sqlite3", db, filePath };
  } catch (err) {
    console.warn(
      `[atom] better-sqlite3 unavailable (${(err as Error).message}); falling back to sql.js`
    );
    const initSqlJs = (await import("sql.js")).default;
    const SQL = await initSqlJs();
    const existed = fs.existsSync(filePath);
    let db: SqlJsDatabase;
    if (existed) {
      const buf = fs.readFileSync(filePath);
      db = new SQL.Database(buf) as unknown as SqlJsDatabase;
    } else {
      db = new SQL.Database() as unknown as SqlJsDatabase;
    }
    db.run(SCHEMA);

    const state = {
      db,
      mtimeMs: fileMtimeMs(filePath),
    };

    const persist = () => {
      const data = state.db.export();
      const tmp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, Buffer.from(data));
      fs.renameSync(tmp, filePath);
      state.mtimeMs = fileMtimeMs(filePath);
    };

    const refresh = () => {
      const mt = fileMtimeMs(filePath);
      if (!mt || mt <= state.mtimeMs) return;
      const buf = fs.readFileSync(filePath);
      try {
        state.db.close?.();
      } catch {
        /* ignore */
      }
      state.db = new SQL.Database(buf) as unknown as SqlJsDatabase;
      state.mtimeMs = mt;
    };

    // Only create the file if missing — never rewrite an existing DB on open
    // (that race is what killed Desk when CLI opened the same sql.js file).
    if (!existed) persist();

    return {
      kind: "sqljs",
      get db() {
        return state.db;
      },
      filePath,
      persist,
      refresh,
      get mtimeMs() {
        return state.mtimeMs;
      },
      SQL,
    };
  }
}

export function dbAll(
  atomDb: AtomDb,
  sql: string,
  params: unknown[] = []
): Record<string, unknown>[] {
  if (atomDb.kind === "sqljs") atomDb.refresh();
  if (atomDb.kind === "better-sqlite3") {
    return atomDb.db.prepare(sql).all(...params);
  }
  const stmt = atomDb.db.prepare(sql);
  stmt.bind(params);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

export function dbRun(atomDb: AtomDb, sql: string, params: unknown[] = []): void {
  if (atomDb.kind === "sqljs") atomDb.refresh();
  if (atomDb.kind === "better-sqlite3") {
    atomDb.db.prepare(sql).run(...params);
    return;
  }
  atomDb.db.run(sql, params);
  atomDb.persist();
}

export function dbGet(
  atomDb: AtomDb,
  sql: string,
  params: unknown[] = []
): Record<string, unknown> | undefined {
  const rows = dbAll(atomDb, sql, params);
  return rows[0];
}
