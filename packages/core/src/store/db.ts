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
  | { kind: "sqljs"; db: SqlJsDatabase; filePath: string; persist: () => void };

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
    let db: SqlJsDatabase;
    if (fs.existsSync(filePath)) {
      const buf = fs.readFileSync(filePath);
      db = new SQL.Database(buf) as unknown as SqlJsDatabase;
    } else {
      db = new SQL.Database() as unknown as SqlJsDatabase;
    }
    db.run(SCHEMA);
    const persist = () => {
      const data = db.export();
      fs.writeFileSync(filePath, Buffer.from(data));
    };
    persist();
    return { kind: "sqljs", db, filePath, persist };
  }
}

export function dbAll(
  atomDb: AtomDb,
  sql: string,
  params: unknown[] = []
): Record<string, unknown>[] {
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
