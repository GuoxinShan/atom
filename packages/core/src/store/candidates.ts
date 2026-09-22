import { CandidateStatus, CandidateTags, CandidateView, Ref } from "../schema/types.js";
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

function optionalText(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s || undefined;
}

function overlayTags(
  cur: CandidateView,
  detail: Record<string, unknown>,
  updatedAt: string
): void {
  const tags = parseTags(detail.tags);
  const theme = optionalText(detail.theme) ?? tags?.theme;
  const project = optionalText(detail.project) ?? tags?.project;
  if (theme) cur.theme = theme;
  else delete cur.theme;
  if (project) cur.project = project;
  else delete cur.project;
  if (tags) cur.tags = tags;
  else delete cur.tags;
  cur.updated_at = updatedAt;
}

function parseTags(raw: unknown): CandidateTags | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const theme = optionalText(o.theme);
  const project = optionalText(o.project);
  const rest = { ...o };
  delete rest.theme;
  delete rest.project;
  if (!theme && !project && Object.keys(rest).length === 0) return undefined;
  return {
    ...(theme ? { theme } : {}),
    ...(project ? { project } : {}),
    ...rest,
  };
}

/** Fold events into candidate projections. */
export function projectCandidates(store: EventStore): CandidateView[] {
  const events = store.list({ limit: 5000 });
  const map = new Map<string, CandidateView>();

  for (const ev of events) {
    const detail = parseDetail(ev.detail_json);
    const refs = parseRefs(ev.refs_json);

    if (ev.type === "candidate_proposed") {
      const tags = parseTags(detail.tags);
      const theme = optionalText(detail.theme) ?? tags?.theme;
      const project = optionalText(detail.project) ?? tags?.project;
      map.set(ev.subject_id, {
        id: ev.subject_id,
        title: String(detail.title ?? ev.summary),
        body: String(detail.body ?? ""),
        confidence: Number(detail.confidence ?? 0.5),
        status: "suggested",
        refs,
        updated_at: ev.created_at,
        cluster_key: optionalText(detail.cluster_key),
        ...(theme ? { theme } : {}),
        ...(project ? { project } : {}),
        ...(tags ? { tags } : {}),
      });
      continue;
    }

    const cur = map.get(ev.subject_id);
    if (!cur) continue;

    if (ev.type === "decision_accepted") {
      cur.status = "accepted";
      cur.updated_at = ev.created_at;
      delete cur.keep_open;
      delete cur.disposition;
      delete cur.reject_reason;
      delete cur.closed_reason;
    } else if (ev.type === "decision_rejected") {
      cur.status = "rejected";
      cur.updated_at = ev.created_at;
      delete cur.keep_open;
      const reason = optionalText(detail.reason);
      const label = optionalText(detail.reason_label);
      if (reason) cur.reject_reason = reason;
      else delete cur.reject_reason;
      const alreadyDone =
        reason === "already_done" || optionalText(detail.disposition) === "already_done";
      const irrelevant =
        reason === "irrelevant" || optionalText(detail.disposition) === "irrelevant";
      if (alreadyDone) {
        cur.disposition = "already_done";
        cur.closed_reason = label ?? "已在仓库/历史进度关闭";
      } else if (irrelevant) {
        cur.disposition = "irrelevant";
        cur.closed_reason = label ?? "同类已标无关";
      } else {
        delete cur.disposition;
        if (label) cur.closed_reason = label;
        else delete cur.closed_reason;
      }
    } else if (ev.type === "decision_reopened") {
      cur.status = "suggested";
      cur.updated_at = ev.created_at;
      cur.keep_open = true;
      delete cur.disposition;
      delete cur.reject_reason;
      delete cur.closed_reason;
    } else if (ev.type === "candidate_tagged") {
      overlayTags(cur, detail, ev.created_at);
    } else if (ev.type === "decision_merged") {
      cur.status = "merged";
      cur.updated_at = ev.created_at;
      const mergedInto = detail.merged_into ? String(detail.merged_into) : undefined;
      if (mergedInto) cur.merged_into = mergedInto;
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
