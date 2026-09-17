import type { Candidate, CandidateStatus } from "@atom/core";

const COLUMNS: { status: CandidateStatus; label: string; kicker: string }[] = [
  { status: "suggested", label: "Suggested", kicker: "awaiting a human" },
  { status: "accepted", label: "Accepted", kicker: "in the pool" },
  { status: "rejected", label: "Rejected", kicker: "kept in the feed" },
];

export function renderKanban(candidates: Candidate[], dbPath: string): string {
  const counts = Object.fromEntries(
    COLUMNS.map((col) => [col.status, candidates.filter((c) => c.status === col.status).length]),
  ) as Record<CandidateStatus, number>;

  return `<!doctype html>
<html lang="zh-Hans">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ATOM · 事元</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,460;9..144,600&family=IBM+Plex+Mono:wght@400;500&family=Outfit:wght@360;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div class="grain" aria-hidden="true"></div>
  <header class="mast">
    <div class="brand">
      <p class="mark">ATOM</p>
      <h1>事元 <span>Append-only Timeline Of Matters</span></h1>
    </div>
    <dl class="stats">
      <div><dt>Suggested</dt><dd>${counts.suggested ?? 0}</dd></div>
      <div><dt>Accepted</dt><dd>${counts.accepted ?? 0}</dd></div>
      <div><dt>Rejected</dt><dd>${counts.rejected ?? 0}</dd></div>
    </dl>
  </header>
  <p class="lede">Machines propose. Humans decide. Every card still points at a message token — the <code>events</code> table is the only writable feed.</p>
  <main class="board">
    ${COLUMNS.map((col) => renderColumn(col, candidates.filter((c) => c.status === col.status))).join("")}
  </main>
  <footer>
    <span>local projection</span>
    <span class="sep"></span>
    <span>${escapeHtml(dbPath)}</span>
    <span class="sep"></span>
    <span>approve writes a decision atom — history is never deleted</span>
  </footer>
</body>
</html>`;
}

function renderColumn(
  col: { status: CandidateStatus; label: string; kicker: string },
  items: Candidate[],
): string {
  const cards =
    items.length === 0
      ? `<p class="empty">${emptyCopy(col.status)}</p>`
      : items.map(renderCard).join("");
  return `<section class="col" data-status="${col.status}">
    <header>
      <h2>${col.label}</h2>
      <p>${col.kicker}</p>
      <em>${items.length}</em>
    </header>
    <div class="stack">${cards}</div>
  </section>`;
}

function emptyCopy(status: CandidateStatus): string {
  if (status === "suggested") return "Run pnpm atom run — the pool is empty.";
  if (status === "accepted") return "Nothing accepted yet.";
  return "Rejected items stay auditable here.";
}

function renderCard(c: Candidate): string {
  const refs = c.refs
    .map((r) => `<code title="${escapeHtml(r.digest ?? "")}">${escapeHtml(r.token)}</code>`)
    .join("");
  const actions =
    c.status === "suggested"
      ? `<div class="actions">
          <form method="post" action="/candidates/${encodeURIComponent(c.id)}/accept"><button class="ok" type="submit">Accept</button></form>
          <form method="post" action="/candidates/${encodeURIComponent(c.id)}/reject"><button class="no" type="submit">Reject</button></form>
        </div>`
      : `<p class="stamp">${c.status} · ${escapeHtml(c.updated_at.slice(0, 16).replace("T", " "))}</p>`;
  const pct = Math.round(c.confidence * 100);
  return `<article class="card">
    <div class="card-top">
      <h3>${escapeHtml(c.title)}</h3>
      <span class="conf">${pct}</span>
    </div>
    <div class="meter"><i style="width:${pct}%"></i></div>
    <p class="body">${escapeHtml(c.body)}</p>
    <div class="refs">${refs || "<span class='warn'>missing refs</span>"}</div>
    ${actions}
  </article>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
