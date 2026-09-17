import type { Atom, Candidate, RawMessage } from "./types.ts";

type ProposedDetail = {
  title?: unknown;
  body?: unknown;
  confidence?: unknown;
  cluster_key?: unknown;
  source_adapter_id?: unknown;
  raw?: unknown;
  cursor?: unknown;
};

export function projectCandidates(atoms: Atom[]): Candidate[] {
  const map = new Map<string, Candidate>();
  for (const atom of atoms) {
    if (atom.type === "candidate_proposed") {
      const detail = (atom.detail ?? {}) as ProposedDetail;
      map.set(atom.subject_id, {
        id: atom.subject_id,
        title: String(detail.title ?? atom.summary),
        body: String(detail.body ?? ""),
        confidence: Number(detail.confidence ?? 0),
        cluster_key:
          typeof detail.cluster_key === "string" ? detail.cluster_key : undefined,
        status: "suggested",
        refs: [...atom.refs],
        updated_at: atom.created_at,
      });
      continue;
    }
    const current = map.get(atom.subject_id);
    if (!current) continue;
    if (atom.type === "decision_accepted") current.status = "accepted";
    if (atom.type === "decision_rejected") current.status = "rejected";
    if (atom.type === "decision_merged") current.status = "merged";
    if (atom.refs.length > 0) {
      const seen = new Set(current.refs.map((r) => r.token));
      for (const ref of atom.refs) {
        if (!seen.has(ref.token)) {
          current.refs.push(ref);
          seen.add(ref.token);
        }
      }
    }
    current.updated_at = atom.created_at;
  }
  return [...map.values()];
}

export function projectMessages(atoms: Atom[]): RawMessage[] {
  const out: RawMessage[] = [];
  for (const atom of atoms) {
    if (atom.type !== "message_ingested") continue;
    const detail = (atom.detail ?? {}) as ProposedDetail;
    const raw = (detail.raw ?? {}) as Partial<RawMessage>;
    out.push({
      id: atom.subject_id,
      sourceId: String(detail.source_adapter_id ?? raw.sourceId ?? "unknown"),
      groupId: raw.groupId,
      author: raw.author ?? "unknown",
      text: raw.text ?? "",
      sentAt: raw.sentAt ?? atom.created_at,
      token: raw.token ?? `msg:${atom.subject_id}`,
      cursor: typeof detail.cursor === "string" ? detail.cursor : raw.cursor,
    });
  }
  return out;
}

export function existingClusterKeys(candidates: Candidate[]): Set<string> {
  return new Set(
    candidates
      .map((c) => c.cluster_key)
      .filter((k): k is string => typeof k === "string" && k.length > 0),
  );
}
