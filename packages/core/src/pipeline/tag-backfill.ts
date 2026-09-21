/**
 * One-shot Needs-you theme/project tag backfill.
 *
 * Live extract only tags *new* proposals (#25/#26). Older suggested cards stay
 * untagged (heuristic buckets like 「AI推进·Stenography Lingee」 / Schedule Mcp)
 * or carry pre-allowlist kebab / free-form titles that Desk maps to 「其他」.
 * This sweep re-runs the same Laya tag gate used at extract, then persists
 * closed Chinese vocabulary titles via `candidate_tagged` (overlay; status
 * and refs stay put).
 *
 * Dry-run is the default (no events). `--apply` writes. Only `suggested`
 * cards. Fail-open per card: timeout / parse / Laya down leaves that card
 * unchanged. Idempotent: canonical non-其他 allowlist themes are skipped;
 * unchanged Laya results are not re-written.
 */

import { newId } from "../schema/ids.js";
import type { CandidateTags, CandidateView } from "../schema/types.js";
import { EventStore } from "../store/events.js";
import { listOpenSuggested } from "./merge-sweep.js";
import { persistCandidateTags } from "./extract.js";
import {
  LayaClient,
  layaTagsToDetail,
  type LayaTagGate,
} from "../agents/laya.js";
import {
  loadThemeVocabulary,
  stripLabelDecor,
  tagLabelsForExtract,
  tryMapAllowlist,
  type ThemeVocabulary,
} from "../agents/theme-vocabulary.js";

export type TagBackfillVia = "laya" | "allowlist";

export type TagBackfillItem = {
  id: string;
  title: string;
  theme?: string;
  project?: string;
  via: TagBackfillVia;
  reason: string;
};

export type TagBackfillResult = {
  apply: boolean;
  considered: number;
  tagged: number;
  skipped: number;
  failOpen: boolean;
  layaAvailable: boolean;
  reason?: string;
  items: TagBackfillItem[];
};

function optionalHuman(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s || undefined;
}

export function storedTheme(cand: Pick<CandidateView, "theme" | "tags">): string | undefined {
  return optionalHuman(cand.theme) ?? optionalHuman(cand.tags?.theme);
}

export function storedProject(cand: Pick<CandidateView, "project" | "tags">): string | undefined {
  return optionalHuman(cand.project) ?? optionalHuman(cand.tags?.project);
}

/** Unique non-其他 allowlist hit, or undefined. */
export function uniqueAllowlistTitle(
  raw: string | undefined,
  labels: ThemeVocabulary["themes"],
  other: string
): string | undefined {
  const mapped = tryMapAllowlist(raw, labels);
  if (!mapped || mapped === other) return undefined;
  return mapped;
}

export function isCanonicalAllowlistTitle(
  raw: string | undefined,
  labels: ThemeVocabulary["themes"],
  other: string
): boolean {
  if (!raw) return false;
  const mapped = uniqueAllowlistTitle(raw, labels, other);
  return Boolean(mapped && mapped === stripLabelDecor(raw));
}

/**
 * Suggested cards that already carry a canonical non-其他 theme need no work.
 * Kebab/alias titles that uniquely map are local allowlist remaps.
 * Untagged / 「其他」 / unmapped leftover titles need a Laya tag call.
 */
export function classifyTagBackfill(
  cand: CandidateView,
  vocab: ThemeVocabulary
): "skip" | "allowlist" | "laya" {
  if (cand.status !== "suggested") return "skip";
  const theme = storedTheme(cand);
  if (isCanonicalAllowlistTitle(theme, vocab.themes, vocab.other)) return "skip";
  if (uniqueAllowlistTitle(theme, vocab.themes, vocab.other)) return "allowlist";
  return "laya";
}

function tagsEqual(
  cand: CandidateView,
  persisted: { theme?: string; project?: string }
): boolean {
  const curTheme = storedTheme(cand);
  const curProject = storedProject(cand);
  return (curTheme ?? "") === (persisted.theme ?? "") && (curProject ?? "") === (persisted.project ?? "");
}

function itemFrom(
  cand: CandidateView,
  persisted: { theme?: string; project?: string },
  via: TagBackfillVia,
  reason: string
): TagBackfillItem {
  return {
    id: cand.id,
    title: cand.title,
    ...(persisted.theme ? { theme: persisted.theme } : {}),
    ...(persisted.project ? { project: persisted.project } : {}),
    via,
    reason,
  };
}

function allowlistPersisted(
  cand: CandidateView,
  vocab: ThemeVocabulary
): { theme?: string; project?: string; tags?: CandidateTags } {
  const theme = uniqueAllowlistTitle(storedTheme(cand), vocab.themes, vocab.other);
  const project = uniqueAllowlistTitle(storedProject(cand), vocab.projects, vocab.other);
  return persistCandidateTags({
    ...(theme ? { theme } : {}),
    ...(project ? { project } : {}),
  });
}

export function appendCandidateTagged(
  store: EventStore,
  input: {
    candidateId: string;
    title: string;
    persisted: { theme?: string; project?: string; tags?: CandidateTags };
    via: TagBackfillVia;
    gate?: LayaTagGate;
  }
): void {
  store.append({
    type: "candidate_tagged",
    subject_id: input.candidateId,
    summary: `tagged ${input.via}: ${input.title}`,
    detail: {
      ...input.persisted,
      via: input.via,
      ...(input.gate ? { laya_tags: layaTagsToDetail(input.gate) } : {}),
    },
    actor: "system:laya-tags",
  });
}

export async function runTagBackfill(
  store: EventStore,
  opts?: {
    /** default false — print / return items only; true writes candidate_tagged */
    apply?: boolean;
    /** inject Laya client; `false` skips Laya (tests / LAYA_ENABLED=0) */
    laya?: LayaClient | false;
    repoRoot?: string;
  }
): Promise<TagBackfillResult> {
  const apply = opts?.apply === true;
  const open = listOpenSuggested(store);
  const considered = open.length;
  const vocab = loadThemeVocabulary(opts?.repoRoot);
  const labels = tagLabelsForExtract(opts?.repoRoot);

  const allowlist: CandidateView[] = [];
  const needsLaya: CandidateView[] = [];
  let skipped = 0;
  for (const cand of open) {
    const kind = classifyTagBackfill(cand, vocab);
    if (kind === "skip") skipped += 1;
    else if (kind === "allowlist") allowlist.push(cand);
    else needsLaya.push(cand);
  }

  const items: TagBackfillItem[] = [];

  const writeItem = (
    cand: CandidateView,
    persisted: { theme?: string; project?: string; tags?: CandidateTags },
    via: TagBackfillVia,
    reason: string,
    gate?: LayaTagGate
  ) => {
    if (!persisted.theme && !persisted.project) {
      skipped += 1;
      return;
    }
    if (tagsEqual(cand, persisted)) {
      skipped += 1;
      return;
    }
    items.push(itemFrom(cand, persisted, via, reason));
    if (apply) {
      appendCandidateTagged(store, {
        candidateId: cand.id,
        title: cand.title,
        persisted,
        via,
        gate,
      });
      console.log(
        `[tag-backfill] ${via} ${cand.id} theme=${persisted.theme ?? "-"} project=${persisted.project ?? "-"}: ${cand.title}`
      );
    } else {
      console.log(
        `[tag-backfill] dry-run ${via} ${cand.id} theme=${persisted.theme ?? "-"} project=${persisted.project ?? "-"}: ${cand.title}`
      );
    }
  };

  for (const cand of allowlist) {
    writeItem(cand, allowlistPersisted(cand, vocab), "allowlist", "allowlist-map");
  }

  const laya =
    opts?.laya === false ? null : opts?.laya ?? LayaClient.fromEnv({ repoRoot: opts?.repoRoot });

  if (!needsLaya.length) {
    return {
      apply,
      considered,
      tagged: items.length,
      skipped,
      failOpen: false,
      layaAvailable: true,
      items,
    };
  }

  if (!laya?.isEnabled()) {
    skipped += needsLaya.length;
    return {
      apply,
      considered,
      tagged: items.length,
      skipped,
      failOpen: true,
      layaAvailable: false,
      reason: "laya-disabled",
      items,
    };
  }

  let layaAvailable = await laya.ensureUp();
  if (!layaAvailable) {
    console.warn("[tag-backfill] Laya unavailable — fail-open (untagged cards unchanged)");
    skipped += needsLaya.length;
    return {
      apply,
      considered,
      tagged: items.length,
      skipped,
      failOpen: true,
      layaAvailable: false,
      reason: "laya-unavailable",
      items,
    };
  }

  const runId = apply ? newId("agent") : undefined;
  if (apply && runId) {
    store.append({
      type: "agent_started",
      subject_id: runId,
      summary: `tag-backfill start: open=${considered} laya=${needsLaya.length}`,
      detail: {
        kind: "tag-backfill",
        apply: true,
        open: considered,
        laya: needsLaya.length,
        allowlist: allowlist.length,
      },
      actor: "system:laya-tags",
    });
  }

  let failOpen = false;

  try {
    for (const cand of needsLaya) {
      if (laya.unavailable) {
        failOpen = true;
        layaAvailable = false;
        skipped += 1;
        continue;
      }

      const gate = await laya.tagCandidate({
        title: cand.title,
        body: cand.body,
        themeLabels: labels.themes,
        projectLabels: labels.projects,
      });
      if (gate.failOpen) {
        failOpen = true;
        skipped += 1;
        continue;
      }

      const persisted = persistCandidateTags(
        { theme: storedTheme(cand), project: storedProject(cand), tags: cand.tags },
        gate
      );
      writeItem(cand, persisted, "laya", gate.reason, gate);
    }

    if (apply && runId) {
      store.append({
        type: "agent_completed",
        subject_id: runId,
        summary: `tag-backfill done: tagged=${items.length}`,
        detail: {
          kind: "tag-backfill",
          apply: true,
          considered,
          tagged: items.length,
          skipped,
          fail_open: failOpen,
        },
        actor: "system:laya-tags",
      });
    }

    return {
      apply,
      considered,
      tagged: items.length,
      skipped,
      failOpen,
      layaAvailable: layaAvailable && !laya.unavailable,
      items,
    };
  } catch (err) {
    if (apply && runId) {
      store.append({
        type: "agent_failed",
        subject_id: runId,
        summary: "tag-backfill failed",
        detail: { kind: "tag-backfill", error: (err as Error).message },
        actor: "system:laya-tags",
      });
    }
    throw err;
  }
}
