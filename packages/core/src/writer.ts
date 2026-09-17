import { TYPES_REQUIRING_REFS, type Atom, type NewAtom } from "./types.ts";
import { AtomTypeSchema, RefSchema } from "./schema.ts";
import { newId, nowIso } from "./ids.ts";
import type { AtomStore } from "./store.ts";

export class AtomWriterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtomWriterError";
  }
}

export function writeAtom(store: AtomStore, input: NewAtom): Atom {
  const type = AtomTypeSchema.parse(input.type);
  const refs = (input.refs ?? []).map((r) => RefSchema.parse(r));
  if (TYPES_REQUIRING_REFS.has(type) && refs.length < 1) {
    throw new AtomWriterError(`${type} requires ≥1 ref`);
  }
  const atom: Atom = {
    id: newId(),
    type,
    subject_id: input.subject_id,
    summary: input.summary,
    detail: input.detail ?? {},
    refs,
    actor: input.actor,
    created_at: nowIso(),
  };
  store.append(atom);
  return atom;
}
