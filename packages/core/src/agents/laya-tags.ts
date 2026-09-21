/**
 * Vocabulary for the extract → Laya theme/project tag gate.
 *
 * Labels are typed choice criteria (Laya never generates free text).
 * Prefer Chinese human titles (AI推进) over English slugs (Schedule Mcp).
 */

import fs from "node:fs";
import path from "node:path";
import type { WorkspaceEntry } from "./lead.js";
import {
  DEFAULT_TAG_LABELS,
  TAG_LABELS_CAP,
  TAG_NONE,
  type TagLabel,
} from "./laya.js";
import { loadGroupingWorkspaces, workspaceGroupTitle } from "../store/needs-groups.js";
import type { CandidateView } from "../schema/types.js";

function isHumanTagTitle(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 16) return false;
  if (t.includes("/") || /^https?:/i.test(t)) return false;
  if (/^(cand|spec|evt|chkitem|handoff|chk)_/i.test(t)) return false;
  if (/^[a-f0-9]{16,}$/i.test(t)) return false;
  return true;
}

function stripGroupDecor(raw: string): string {
  return raw.replace(/[【】\[\]]/g, "").replace(/\s+/g, " ").trim();
}

function preferChineseTitle(titles: string[]): string | undefined {
  const human = titles.map((t) => stripGroupDecor(t)).filter(isHumanTagTitle);
  const cjk = human.find((t) => /[\u3400-\u9fff]/.test(t));
  return cjk || human[0];
}

function pushLabel(out: TagLabel[], seen: Set<string>, label: TagLabel): void {
  const title = label.title.trim();
  if (!title || title.toLowerCase() === TAG_NONE || !isHumanTagTitle(title)) return;
  const key = title.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  for (const alias of label.aliases ?? []) {
    const a = alias.trim().toLowerCase();
    if (a) seen.add(a);
  }
  out.push({ ...label, title });
}

export function loadSourceGroupNames(repoRoot: string): string[] {
  const p = path.join(repoRoot, "data", "sources.json");
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8")) as {
      sources?: Array<{ groupNames?: Record<string, unknown> }>;
    };
    const names: string[] = [];
    for (const src of data.sources ?? []) {
      const gn = src.groupNames;
      if (!gn || typeof gn !== "object") continue;
      for (const v of Object.values(gn)) {
        if (typeof v === "string" && v.trim()) names.push(v);
      }
    }
    return names;
  } catch {
    return [];
  }
}

export function collectTagLabels(opts?: {
  workspaces?: WorkspaceEntry[];
  groupNames?: string[];
  existing?: Array<Pick<CandidateView, "theme" | "project" | "tags">>;
}): TagLabel[] {
  const out: TagLabel[] = [];
  const seen = new Set<string>();

  for (const label of DEFAULT_TAG_LABELS) pushLabel(out, seen, label);

  for (const ws of opts?.workspaces ?? []) {
    const title = preferChineseTitle([
      workspaceGroupTitle(ws),
      ...(ws.match ?? []),
      ...(ws.tags ?? []),
    ]);
    if (title) pushLabel(out, seen, { title, hint: ws.notes || title });
  }

  for (const raw of opts?.groupNames ?? []) {
    const title = preferChineseTitle([raw, stripGroupDecor(raw)]);
    if (title) pushLabel(out, seen, { title });
  }

  for (const cand of opts?.existing ?? []) {
    for (const raw of [cand.theme, cand.tags?.theme, cand.project, cand.tags?.project]) {
      if (typeof raw === "string" && raw.trim()) {
        pushLabel(out, seen, { title: stripGroupDecor(raw) });
      }
    }
  }

  return out.slice(0, TAG_LABELS_CAP);
}

export function tagLabelsForExtract(repoRoot: string | undefined, existing: CandidateView[]): TagLabel[] {
  if (!repoRoot) return collectTagLabels({ existing });
  return collectTagLabels({
    workspaces: loadGroupingWorkspaces(repoRoot),
    groupNames: loadSourceGroupNames(repoRoot),
    existing,
  });
}
