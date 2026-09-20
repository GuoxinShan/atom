import { CandidateStatus, CandidateView, Ref } from "../schema/types.js";
import { EventStore } from "./events.js";

function parseRefs(raw: string): Ref[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as Ref[]) : [];
  } catch {
    return [];
  }
}

function parseDetail(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Fold events into candidate projections. */
export function projectCandidates(store: EventStore): CandidateView[] {
  const events = store.list({ limit: 5000 });
  const map = new Map<string, CandidateView>();

  for (const ev of events) {
    const detail = parseDetail(ev.detail_json);
    const refs = parseRefs(ev.refs_json);

    if (ev.type === "candidate_proposed") {
      map.set(ev.subject_id, {
        id: ev.subject_id,
        title: String(detail.title ?? ev.summary),
        body: String(detail.body ?? ""),
        confidence: Number(detail.confidence ?? 0.5),
        status: "suggested",
        refs,
        updated_at: ev.created_at,
        cluster_key: detail.cluster_key ? String(detail.cluster_key) : undefined,
      });
      continue;
    }

    const cur = map.get(ev.subject_id);
    if (!cur) continue;

    if (ev.type === "decision_accepted") {
      cur.status = "accepted";
      cur.updated_at = ev.created_at;
    } else if (ev.type === "decision_rejected") {
      cur.status = "rejected";
      cur.updated_at = ev.created_at;
    } else if (ev.type === "decision_merged") {
      cur.status = "merged";
      cur.updated_at = ev.created_at;
      const mergedIds = Array.isArray(detail.merged_ids)
        ? (detail.merged_ids as string[])
        : [];
      for (const loser of mergedIds) {
        const other = map.get(loser);
        if (other) {
          other.status = "merged";
          other.updated_at = ev.created_at;
        }
      }
      // Laya duplicate fold: subject is the loser; attach refs onto the survivor
      // without taking it off the Needs-you queue.
      const mergedInto = detail.merged_into ? String(detail.merged_into) : undefined;
      if (mergedInto) {
        const survivor = map.get(mergedInto);
        if (survivor) {
          const seen = new Set(survivor.refs.map((r) => r.token));
          for (const r of refs) {
            if (!seen.has(r.token)) {
              survivor.refs.push(r);
              seen.add(r.token);
            }
          }
          survivor.updated_at = ev.created_at;
        }
      }
    }
  }

  return [...map.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function candidatesByStatus(
  store: EventStore,
  status?: CandidateStatus
): CandidateView[] {
  const all = projectCandidates(store);
  return status ? all.filter((c) => c.status === status) : all;
}
