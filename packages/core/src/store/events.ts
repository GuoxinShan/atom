import {
  AtomType,
  AtomTypeSchema,
  EventRecord,
  Ref,
  RefSchema,
} from "../schema/types.js";
import { newId } from "../schema/ids.js";
import { AtomDb, dbAll, dbGet, dbRun } from "./db.js";

export class EventWriterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventWriterError";
  }
}

export interface AppendEventInput {
  type: AtomType;
  subject_id: string;
  summary: string;
  detail?: Record<string, unknown>;
  refs?: Ref[];
  actor?: string;
  created_at?: string;
  id?: string;
}

const KNOWN = new Set(AtomTypeSchema.options);

export class EventStore {
  constructor(private readonly atomDb: AtomDb) {}

  append(input: AppendEventInput): EventRecord {
    if (!KNOWN.has(input.type)) {
      throw new EventWriterError(`Unknown event type: ${input.type}`);
    }

    const refs = input.refs ?? [];
    if (input.type === "candidate_proposed" && refs.length < 1) {
      throw new EventWriterError(
        "candidate_proposed requires at least one ref — rejected"
      );
    }

    for (const ref of refs) {
      RefSchema.parse(ref);
    }

    const record: EventRecord = {
      id: input.id ?? newId("evt"),
      type: input.type,
      subject_id: input.subject_id,
      summary: input.summary,
      detail_json: JSON.stringify(input.detail ?? {}),
      refs_json: JSON.stringify(refs),
      actor: input.actor ?? "system",
      created_at: input.created_at ?? new Date().toISOString(),
    };

    dbRun(
      this.atomDb,
      `INSERT INTO events (id, type, subject_id, summary, detail_json, refs_json, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.type,
        record.subject_id,
        record.summary,
        record.detail_json,
        record.refs_json,
        record.actor,
        record.created_at,
      ]
    );

    return record;
  }

  list(opts?: {
    type?: AtomType;
    subject_id?: string;
    limit?: number;
    /** Inclusive ISO-8601 lower bound on created_at (lexicographic; writer uses toISOString). */
    since?: string;
    /** Inclusive ISO-8601 upper bound on created_at. */
    until?: string;
  }): EventRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts?.type) {
      clauses.push("type = ?");
      params.push(opts.type);
    }
    if (opts?.subject_id) {
      clauses.push("subject_id = ?");
      params.push(opts.subject_id);
    }
    if (opts?.since) {
      clauses.push("created_at >= ?");
      params.push(opts.since);
    }
    if (opts?.until) {
      clauses.push("created_at <= ?");
      params.push(opts.until);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = opts?.limit ?? 500;
    const rows = dbAll(
      this.atomDb,
      `SELECT * FROM events ${where} ORDER BY created_at ASC LIMIT ?`,
      [...params, limit]
    );
    return rows.map((r) => r as unknown as EventRecord);
  }

  listNewest(opts?: { type?: AtomType; limit?: number }): EventRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts?.type) {
      clauses.push("type = ?");
      params.push(opts.type);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = opts?.limit ?? 20;
    const rows = dbAll(
      this.atomDb,
      `SELECT * FROM events ${where} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit]
    );
    return rows.map((r) => r as unknown as EventRecord);
  }

  getMeta(key: string): string | null {
    const row = dbGet(this.atomDb, `SELECT value FROM meta WHERE key = ?`, [key]);
    return row ? String(row.value) : null;
  }

  setMeta(key: string, value: string): void {
    dbRun(
      this.atomDb,
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value]
    );
  }
}
