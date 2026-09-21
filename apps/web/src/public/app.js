const PAGES = ["needs-you", "processed", "preferences", "advanced"];

const state = {
  page: "needs-you",
  candidates: [],
  groups: [],
  groupOpen: {},
  alreadyDone: [],
  specs: [],
  checklists: [],
  sources: [],
  machines: {},
  meta: {},
  status: null,
  digest: null,
  preference: null,
  rsiPreview: null,
  prefNote: "",
  prefNoteFail: false,
  selectedId: null,
  selectedKind: "candidate",
  handoffNote: "",
  ackNote: "",
};

const statusStrip = document.getElementById("status-strip");
const queue = document.getElementById("needs-queue");
const transcript = document.getElementById("lead-transcript");

/** Known source ids → names a person already uses. Do not invent beyond this. */
const SOURCE_LABELS = {
  "yzj-ai-advance": "AI推进",
  yzj: "云之家",
  fixture: "示例",
};

const KIND_LABELS = {
  yzj: "云之家",
  fixture: "示例",
  manual: "手动",
  webhook: "Webhook",
  "local-cli": "本机 CLI",
  "grokbot-webhook": "Grok Bot",
  log: "日志",
  cli: "命令",
  file: "文件",
  im: "消息",
  doc: "文档",
  meeting: "会议",
  url: "链接",
  git: "Git",
  personal: "个人",
  work: "工作",
};

const ROLE_LABELS = {
  lead: "Lead",
  extract: "提取",
  coding: "编码",
  execute: "执行",
};

const STATUS_LABELS = {
  suggested: "待拍板",
  accepted: "已通过",
  rejected: "已拒绝",
  merged: "已合并",
  already_done: "已在仓库/历史进度关闭",
  spec: "规格",
};

const PIPELINE_LABELS = {
  run: "全流程",
  ingest: "接入",
  extract: "提取",
};

const CHECK_KEY_LABELS = {
  tests_green: "测试通过",
  evidence_linked: "已附证据",
  summary_written: "已写说明",
  human_gate_ack: "人工确认",
};

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function looksTechnicalId(value) {
  const s = String(value ?? "").trim();
  if (!s) return true;
  if (/^(cand|spec|evt|chkitem|handoff|chk)_/i.test(s)) return true;
  if (/:(im|doc|git|file|url):/.test(s)) return true;
  if (/^[a-f0-9]{16,}$/i.test(s)) return true;
  if (/^[a-z]+_[a-z0-9]{6,}$/i.test(s) && !s.includes("-")) return true;
  return false;
}

function shortSlug(id) {
  const s = String(id ?? "").trim();
  if (!s) return "";
  if (looksTechnicalId(s)) {
    const head = s.split(/[_:]/).find((p) => p && !/^[a-f0-9]+$/i.test(p)) || "项目";
    return `${head}…`;
  }
  if (s.length > 22) return `${s.slice(0, 16)}…`;
  return s;
}

function firstHuman(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (!s || looksTechnicalId(s)) continue;
    return s;
  }
  return "";
}

function kindLabel(kind) {
  if (!kind) return "";
  return KIND_LABELS[kind] || firstHuman(kind) || "";
}

function statusLabel(status) {
  if (!status) return "";
  return STATUS_LABELS[status] || firstHuman(status) || "";
}

function roleLabel(role) {
  if (!role) return "";
  return ROLE_LABELS[role] || firstHuman(role) || shortSlug(role);
}

function basenamePath(p) {
  const s = String(p ?? "").trim();
  if (!s) return "";
  const parts = s.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) || s;
}

function relativeTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (Math.abs(sec) < 45) return "刚刚";
  if (sec < 3600) return `${Math.max(1, Math.floor(sec / 60))} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  if (sec < 86400 * 8) return `${Math.floor(sec / 86400)} 天前`;
  return d.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function copyIdButton(id) {
  if (!id) return "";
  return `<button type="button" class="copy-id" data-copy-id="${escapeHtml(
    id
  )}" title="复制 ID" aria-label="复制 ID">复制 ID</button>`;
}

function pill(text, extraClass = "") {
  const t = String(text ?? "").trim();
  if (!t) return "";
  return `<span class="pill${extraClass ? " " + extraClass : ""}">${escapeHtml(t)}</span>`;
}

function groupNameForId(groupId) {
  if (!groupId) return "";
  for (const s of state.sources) {
    const name = s.groupNames?.[groupId];
    if (name) return String(name);
  }
  return "";
}

function sourceTitle(s) {
  const groupNames = Object.values(s.groupNames || {}).map((n) => String(n).trim()).filter(Boolean);
  return (
    firstHuman(s.name, s.label, s.title, s.displayName, s.groupName, groupNames[0]) ||
    SOURCE_LABELS[s.id] ||
    kindLabel(s.kind) ||
    shortSlug(s.id)
  );
}

function labelForRef(ref) {
  const token = String(ref?.token ?? "");
  const parts = token.split(":");
  const sourceHint = parts[0] || "";
  const kindHint = ref?.kind || parts[1] || "";
  const groupId = parts[2] || "";
  const groupName = groupNameForId(groupId);
  return (
    firstHuman(groupName, SOURCE_LABELS[sourceHint], kindLabel(kindHint), SOURCE_LABELS[ref?.source]) ||
    ""
  );
}

function citeLabels(refs) {
  const labels = [];
  const seen = new Set();
  for (const r of refs || []) {
    const label = labelForRef(r);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

function metaLine({ sources = [], status = "", when = "", extra = [], quiet = false } = {}) {
  if (quiet) {
    const bits = [
      ...sources,
      status ? statusLabel(status) || status : "",
      ...extra,
      when,
    ]
      .map((s) => String(s ?? "").trim())
      .filter(Boolean);
    if (!bits.length) return "";
    return `<div class="meta-line quiet">${bits
      .map((b) => `<span>${escapeHtml(b)}</span>`)
      .join('<span class="dot">·</span>')}</div>`;
  }
  const bits = [
    ...sources.map((s) => pill(s)),
    status ? pill(statusLabel(status) || status) : "",
    ...extra.map((x) => pill(x)),
    when ? `<span class="when">${escapeHtml(when)}</span>` : "",
  ].filter(Boolean);
  if (!bits.length) return "";
  return `<div class="meta-line">${bits.join("")}</div>`;
}

function migratePage(name) {
  const raw = String(name ?? "").trim();
  if (raw === "desk") return "needs-you";
  if (raw === "atoms" || raw === "setup") return "advanced";
  if (PAGES.includes(raw)) return raw;
  return "needs-you";
}

function pageFromHash() {
  return migratePage((location.hash || "").replace(/^#\/?/, ""));
}

function showPage(name, opts = {}) {
  const page = migratePage(name);
  state.page = page;
  document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
  document.querySelectorAll(".nav button").forEach((b) => b.classList.remove("active"));
  document.getElementById(`page-${page}`)?.classList.add("active");
  document.querySelector(`.nav button[data-page="${page}"]`)?.classList.add("active");
  if (!opts.skipHash) {
    const next = `#${page}`;
    if (location.hash !== next) history.replaceState(null, "", next);
  }
  if (page === "needs-you") loadDesk();
  if (page === "processed") loadProcessed();
  if (page === "preferences") loadPreferences();
  if (page === "advanced") loadSetup();
  loadStatus();
}

document.getElementById("nav").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-page]");
  if (!btn) return;
  showPage(btn.dataset.page);
});

async function fetchJson(url, fallback) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } catch {
    return fallback;
  }
}

function setListening(on) {
  const el = document.getElementById("listening-pill");
  if (el) el.hidden = !on;
}

function renderSources(data) {
  const root = document.getElementById("sources-list");
  root.innerHTML = "";
  const list = data.sources || [];
  const anyOn = list.some((s) => s.enabled !== false);
  setListening(anyOn);
  if (!list.length) {
    root.innerHTML = '<p class="hint tiny">No sources in data/sources.json</p>';
    return;
  }
  for (const s of list) {
    const on = s.enabled !== false;
    const el = document.createElement("div");
    el.className = `source ${on ? "on" : "off"}`;
    const title = sourceTitle(s);
    const groups = Object.values(s.groupNames || {})
      .map((n) => String(n).trim())
      .filter(Boolean)
      .filter((n, i, arr) => arr.indexOf(n) === i && n !== title);
    const kind = kindLabel(s.kind);
    const subBits = [kind && kind !== title ? kind : "", s.path ? basenamePath(s.path) : ""].filter(
      Boolean
    );
    el.innerHTML = `
      <div class="row">
        <h3>${escapeHtml(title)}</h3>
        <span class="pill ${on ? "on" : "off"}">${on ? "on" : "off"}</span>
      </div>
      ${subBits.length ? `<div class="sub">${escapeHtml(subBits.join(" · "))}</div>` : ""}
      ${groups.length ? `<div>${groups.map((n) => pill(n)).join("")}</div>` : ""}
    `;
    root.appendChild(el);
  }
}

function renderTriggers(data, missing) {
  const root = document.getElementById("triggers-list");
  root.innerHTML = "";
  if (missing) {
    root.innerHTML =
      '<p class="hint tiny">No /api/triggers — see <code>data/triggers.json</code></p>';
    return;
  }
  const list = data.triggers || [];
  if (!list.length) {
    root.innerHTML = '<p class="hint tiny">No triggers configured.</p>';
    return;
  }
  for (const t of list) {
    const on = t.enabled !== false;
    const el = document.createElement("div");
    el.className = `trigger ${on ? "on" : "off"}`;
    const pipeline = PIPELINE_LABELS[t.pipeline] || firstHuman(t.pipeline);
    const title =
      firstHuman(t.name, t.label, t.title, t.displayName) ||
      [kindLabel(t.kind), pipeline].filter(Boolean).join(" · ") ||
      shortSlug(t.id);
    const extra =
      t.config?.path ||
      (t.kind === "cron" && t.config?.everyMinutes != null
        ? `every ${t.config.everyMinutes}m`
        : "");
    el.innerHTML = `
      <div class="row">
        <h3>${escapeHtml(title)}</h3>
        <span class="pill ${on ? "on" : "off"}">${on ? "on" : "off"}</span>
      </div>
      ${extra ? `<div class="sub">${escapeHtml(extra)}</div>` : ""}
    `;
    root.appendChild(el);
  }
}

function specForCandidate(candidateId) {
  return state.specs.filter((s) => s.candidate_id === candidateId).at(-1);
}

function buildMatters() {
  const accepted = state.candidates.filter((c) => c.status === "accepted");
  const rows = [];
  const seenSpec = new Set();
  for (const c of accepted) {
    const spec = specForCandidate(c.id);
    if (spec) seenSpec.add(spec.id);
    rows.push({
      key: spec?.id || c.id,
      candidateId: c.id,
      specId: spec?.id,
      title: firstHuman(spec?.title, c.title) || "未命名事项",
      kind: spec ? "spec" : "accepted",
      status: c.status,
      updatedAt: c.updated_at,
      refs: spec?.refs || c.refs || [],
    });
  }
  for (const s of state.specs) {
    if (seenSpec.has(s.id)) continue;
    const cand = state.candidates.find((c) => c.id === s.candidate_id);
    rows.push({
      key: s.id,
      candidateId: s.candidate_id,
      specId: s.id,
      title: firstHuman(s.title) || "未命名事项",
      kind: "spec",
      status: cand?.status || "spec",
      refs: s.refs || [],
    });
  }
  return rows;
}

function renderMatters() {
  const root = document.getElementById("matters-list");
  root.innerHTML = "";
  const accepted = buildMatters();
  const rejected = state.candidates.filter((c) => c.status === "rejected");
  if (!accepted.length && !rejected.length) {
    root.innerHTML = '<p class="hint tiny">Accept or reject a candidate; settled work lives here, not on home.</p>';
    return;
  }
  for (const m of accepted) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `matter${state.selectedId === m.key || state.selectedId === m.candidateId ? " selected" : ""}`;
    btn.dataset.select = m.specId || m.candidateId;
    btn.innerHTML = `
      <h3>${escapeHtml(m.title)}</h3>
      ${metaLine({ sources: citeLabels(m.refs), status: m.status || m.kind, when: relativeTime(m.updatedAt) })}
    `;
    root.appendChild(btn);
  }
  for (const c of rejected) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `matter${state.selectedId === c.id ? " selected" : ""}`;
    btn.dataset.select = c.id;
    btn.innerHTML = `
      <h3>${escapeHtml(firstHuman(c.title) || "未命名事项")}</h3>
      ${metaLine({ sources: citeLabels(c.refs), status: "rejected", when: relativeTime(c.updated_at) })}
    `;
    root.appendChild(btn);
  }
}

function findSelected() {
  const id = state.selectedId;
  if (!id) return null;
  const chk = state.checklists.find((c) => c.subjectId === id);
  if (chk && state.selectedKind === "checklist") {
    return { kind: "checklist", checklist: chk, id: chk.subjectId, candidateId: chk.candidateId };
  }
  const spec = state.specs.find((s) => s.id === id);
  if (spec) {
    const cand = state.candidates.find((c) => c.id === spec.candidate_id);
    return { kind: "spec", spec, cand, id: spec.id, candidateId: spec.candidate_id };
  }
  const cand = state.candidates.find((c) => c.id === id);
  if (!cand) return null;
  const linked = specForCandidate(cand.id);
  return {
    kind: linked ? "spec" : "candidate",
    spec: linked,
    cand,
    id: linked?.id || cand.id,
    candidateId: cand.id,
  };
}

function checkItemLabel(item) {
  return firstHuman(item.label, CHECK_KEY_LABELS[item.key], item.key) || "清单项";
}

function renderDetail() {
  const root = document.getElementById("matter-detail");
  const sel = findSelected();
  if (!sel) {
    root.innerHTML = `
      <h2>Matter</h2>
      <p class="empty">Pick something in Needs you. Approve, reject, or ack — Lead stays in the drawer and does not code here.</p>
    `;
    return;
  }
  if (sel.kind === "checklist") {
    const chk = sel.checklist;
    const items = chk.items || [];
    const listHtml = items.length
      ? `<ul class="check-list">${items
          .map(
            (i) =>
              `<li class="${i.done ? "done" : ""}">${escapeHtml(checkItemLabel(i))}</li>`
          )
          .join("")}</ul>`
      : "";
    const canAck = chk.awaitingHumanAck && !chk.passed;
    const linked = state.candidates.find((c) => c.id === chk.candidateId);
    const when = relativeTime(linked?.updated_at);
    root.innerHTML = `
      <div class="detail-kicker">
        <h2>确认清单</h2>
        ${copyIdButton(chk.subjectId)}
      </div>
      <h3>${escapeHtml(firstHuman(chk.title, linked?.title) || "确认清单")}</h3>
      ${metaLine({
        sources: citeLabels(linked?.refs),
        status: chk.passed ? "accepted" : "suggested",
        when,
        extra: [chk.awaitingHumanAck && !chk.passed ? "等人确认" : ""],
      })}
      ${listHtml}
      ${
        canAck
          ? `<button type="button" class="cta primary" data-ack="${escapeHtml(chk.subjectId)}">Ack human gate</button>`
          : `<p class="empty">${chk.passed ? "清单已通过。" : "其余项还在 CLI 侧完成。"}</p>`
      }
      ${state.ackNote ? `<pre class="handoff-out">${escapeHtml(state.ackNote)}</pre>` : ""}
    `;
    return;
  }
  const title = firstHuman(sel.spec?.title, sel.cand?.title) || "未命名事项";
  const body = sel.spec?.body || sel.cand?.body || "";
  const refs = sel.spec?.refs || sel.cand?.refs || [];
  const status = sel.cand?.status || (sel.kind === "spec" ? "spec" : "");
  const canHandoff = status === "accepted" || sel.kind === "spec";
  const handoffId = sel.spec?.id || sel.candidateId;
  const sources = citeLabels(refs);
  const citeCount = (refs || []).length;
  const citeHint = citeCount
    ? `<p class="cite-hint">${
        sources.length
          ? `来自 ${escapeHtml(sources.join("、"))} · ${citeCount} 条引用`
          : `${citeCount} 条引用`
      }</p>`
    : "";
  root.innerHTML = `
    <div class="detail-kicker">
      <h2>Matter</h2>
      ${copyIdButton(sel.candidateId || sel.id)}
    </div>
    <h3>${escapeHtml(title)}</h3>
    ${metaLine({ sources, status, when: relativeTime(sel.cand?.updated_at) })}
    <p class="body">${escapeHtml(body)}</p>
    ${citeHint}
        ${
      sel.spec?.acceptance_criteria?.length
        ? `<h2 class="subhead" style="margin-top:14px">Criteria</h2><div class="body">${sel.spec.acceptance_criteria
            .map((c) => escapeHtml(c))
            .join("\n")}</div>`
        : ""
    }
    ${
      status === "suggested"
        ? `<div class="card-actions">
            <button type="button" data-act="approve" data-id="${escapeHtml(sel.candidateId)}">Approve</button>
            <button type="button" data-act="reject" data-id="${escapeHtml(sel.candidateId)}">Reject</button>
          </div>`
        : ""
    }
    <button type="button" class="cta primary" data-handoff="${escapeHtml(handoffId)}" ${
      canHandoff ? "" : "disabled"
    }>Handoff</button>
    ${state.handoffNote ? `<pre class="handoff-out">${escapeHtml(state.handoffNote)}</pre>` : ""}
  `;
}

function awaitingChecklists() {
  return (state.checklists || []).filter((c) => c.awaitingHumanAck && !c.passed);
}

function formatLastActivity(info) {
  const iso = info?.lastRunAt || info?.lastExtractAt;
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const label = info.lastRunAt ? "上次 run" : "上次 extract";
  const when = d.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  return `${label} ${when}`;
}

function isGroupOpen(key) {
  if (Object.prototype.hasOwnProperty.call(state.groupOpen, key)) return Boolean(state.groupOpen[key]);
  return true;
}

function isOtherGroup(g) {
  const title = String(g?.title ?? "").trim();
  const key = String(g?.key ?? "");
  return title === "其他" || key === "heuristic:other";
}

function groupSummaryHtml(title, count) {
  const n = Number(count) || 0;
  const label = firstHuman(title) || "其他";
  return `<summary class="needs-group-summary" aria-label="${escapeHtml(
    `${label}，${n} 张，展开或收起`
  )}"><span class="group-chevron" aria-hidden="true"></span><span class="group-title">${escapeHtml(
    label
  )}</span><span class="group-count">${n}</span></summary>`;
}

function renderSuggestedCard(c) {
  const card = document.createElement("article");
  const selected =
    state.selectedKind !== "checklist" &&
    (state.selectedId === c.id || specForCandidate(c.id)?.id === state.selectedId);
  card.className = `item needs-card${selected ? " selected" : ""}`;
  card.dataset.select = c.id;
  const title = firstHuman(c.title) || "未命名事项";
  const summary = (c.body || "").trim();
  card.innerHTML = `
        <h3>${escapeHtml(title)}</h3>
        ${summary ? `<p class="card-summary">${escapeHtml(summary.slice(0, 220))}</p>` : ""}
        ${metaLine({
          sources: citeLabels(c.refs),
          status: c.status,
          when: relativeTime(c.updated_at),
          quiet: true,
        })}
        <div class="card-actions">
          <button type="button" data-act="approve" data-id="${escapeHtml(c.id)}">Approve</button>
          <button type="button" data-act="reject" data-id="${escapeHtml(c.id)}">Reject</button>
        </div>
      `;
  return card;
}

function fallbackNeedsGroups(suggested) {
  const buckets = new Map();
  for (const c of suggested) {
    const theme = firstHuman(c.theme, c.tags?.theme);
    const project = firstHuman(c.project, c.tags?.project);
    const stem = firstHuman(c.cluster_key) || "";
    let key;
    let title;
    let kind;
    if (theme) {
      key = `theme:${theme.toLowerCase()}`;
      title = theme;
      kind = "theme";
    } else if (project) {
      key = `project:${project.toLowerCase()}`;
      title = project;
      kind = "project";
    } else if (stem && !looksTechnicalId(stem)) {
      key = `heuristic:stem:${stem.toLowerCase()}`;
      title = stem;
      kind = "heuristic";
    } else {
      key = "heuristic:other";
      title = "其他";
      kind = "heuristic";
    }
    if (!buckets.has(key)) buckets.set(key, { key, title, kind, candidate_ids: [] });
    buckets.get(key).candidate_ids.push(c.id);
  }
  return [...buckets.values()];
}

function renderQueue() {
  const suggested = state.candidates.filter((c) => c.status === "suggested");
  const acks = awaitingChecklists();
  const outbound = 0;
  const counts = document.getElementById("gate-counts");
  if (counts) {
    const bits = [`${suggested.length} suggested`];
    if (acks.length) bits.push(`${acks.length} checklist`);
    if (outbound) bits.push(`${outbound} outbound`);
    counts.textContent = bits.join(" · ");
  }
  queue.innerHTML = "";

  if (!suggested.length && !acks.length && !outbound) {
    queue.innerHTML = `
      <div class="empty-desk">
        <p class="clear">今天没有要你拍板的</p>
        <p class="clear-meta">队列空着是正常的。新卡片来自你盯着的群里出现的新话题。</p>
      </div>
    `;
    return;
  }

  if (suggested.length) {
    const section = document.createElement("section");
    section.className = "needs-board";
    const byId = Object.fromEntries(suggested.map((c) => [c.id, c]));
    const groups =
      Array.isArray(state.groups) && state.groups.length ? state.groups : fallbackNeedsGroups(suggested);
    const seen = new Set();
    for (const g of groups) {
      const cards = (g.candidate_ids || []).map((id) => byId[id]).filter(Boolean);
      if (!cards.length) continue;
      for (const c of cards) seen.add(c.id);
      const wrap = document.createElement("details");
      const other = isOtherGroup(g);
      wrap.className = `needs-group${other ? " is-other" : ""}`;
      wrap.dataset.groupKey = g.key || "";
      wrap.dataset.groupKind = g.kind || "heuristic";
      wrap.open = isGroupOpen(g.key || "heuristic:other");
      wrap.innerHTML = groupSummaryHtml(g.title, cards.length);
      for (const c of cards) wrap.appendChild(renderSuggestedCard(c));
      section.appendChild(wrap);
    }
    const leftovers = suggested.filter((c) => !seen.has(c.id));
    if (leftovers.length) {
      const wrap = document.createElement("details");
      wrap.className = "needs-group is-other";
      wrap.dataset.groupKey = "heuristic:other";
      wrap.dataset.groupKind = "heuristic";
      wrap.open = isGroupOpen("heuristic:other");
      wrap.innerHTML = groupSummaryHtml("其他", leftovers.length);
      for (const c of leftovers) wrap.appendChild(renderSuggestedCard(c));
      section.appendChild(wrap);
    }
    queue.appendChild(section);
  }

  if (acks.length) {
    const section = document.createElement("section");
    section.className = "needs-board";
    section.innerHTML = `<h2 class="needs-board-label">确认清单 <span>${acks.length}</span></h2>`;
    for (const chk of acks) {
      const card = document.createElement("article");
      const selected = state.selectedKind === "checklist" && state.selectedId === chk.subjectId;
      card.className = `item needs-card${selected ? " selected" : ""}`;
      card.dataset.selectChecklist = chk.subjectId;
      const linked = state.candidates.find((c) => c.id === chk.candidateId);
      card.innerHTML = `
        <h3>${escapeHtml(firstHuman(chk.title, linked?.title) || "确认清单")}</h3>
        <p class="card-summary">其余项已完成，等你确认。ATOM 不会自动代点。</p>
        ${metaLine({
          sources: citeLabels(linked?.refs),
          extra: ["等人确认"],
          when: relativeTime(linked?.updated_at),
          quiet: true,
        })}
        <div class="card-actions">
          <button type="button" data-ack="${escapeHtml(chk.subjectId)}">Ack</button>
        </div>
      `;
      section.appendChild(card);
    }
    queue.appendChild(section);
  }
}

function renderWorkspaces(data) {
  const root = document.getElementById("ws-list");
  root.innerHTML = "";
  const machines = data.machines || state.machines || {};
  for (const w of data.workspaces || []) {
    const el = document.createElement("div");
    el.className = "drawer-row";
    const machine = machines[w.machine];
    const machineName = firstHuman(machine?.label, machine?.displayName, w.machineLabel) || "";
    const matchHint = Array.isArray(w.match) ? w.match.find((m) => firstHuman(m)) : "";
    const title =
      firstHuman(w.name, w.label, w.title, w.displayName, matchHint) ||
      SOURCE_LABELS[w.id] ||
      shortSlug(w.id);
    const sub = firstHuman(w.notes) || [kindLabel(w.kind), w.path].filter(Boolean).join(" · ");
    el.innerHTML = `
      <div class="row">
        <h3>${escapeHtml(title)}</h3>
        ${machineName ? pill(machineName) : ""}
      </div>
      ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ""}
    `;
    root.appendChild(el);
  }
  if (!root.children.length) {
    root.innerHTML = '<p class="hint tiny">No workspaces.json entries.</p>';
  }
}

function renderAgents(data) {
  const root = document.getElementById("agents-list");
  root.innerHTML = "";
  const defaults = data.defaults || {};
  for (const p of data.providers || []) {
    const isDefault = defaults[p.role] === p.id;
    const el = document.createElement("div");
    el.className = "drawer-row";
    const title =
      firstHuman(p.name, p.label, p.title, p.displayName) ||
      [roleLabel(p.role), kindLabel(p.kind)].filter(Boolean).join(" · ") ||
      shortSlug(p.id);
    const subBits = [firstHuman(p.notes), isDefault ? "默认" : ""].filter(Boolean);
    el.innerHTML = `
      <div class="row">
        <h3>${escapeHtml(title)}</h3>
        <span class="pill ${p.enabled === false ? "off" : "on"}">${p.enabled === false ? "off" : "on"}</span>
      </div>
      ${subBits.length ? `<div class="sub">${escapeHtml(subBits.join(" · "))}</div>` : ""}
    `;
    root.appendChild(el);
  }
  if (!root.children.length) {
    root.innerHTML = '<p class="hint tiny">No agents.json providers.</p>';
  }
}

function renderSubs(data) {
  const root = document.getElementById("subs-list");
  root.innerHTML = "";
  const list = data.subscriptions || [];
  if (!list.length) {
    root.innerHTML = '<p class="hint tiny">No outbound subscriptions. Ask Lead: 订阅加 https://…</p>';
    return;
  }
  for (const s of list) {
    const el = document.createElement("div");
    el.className = "drawer-row";
    const dest = firstHuman(s.url, basenamePath(s.path), s.bin);
    const named = firstHuman(s.name, s.label, s.title, s.displayName, s.notes);
    const title =
      named || [kindLabel(s.kind), dest].filter(Boolean).join(" · ") || shortSlug(s.id);
    const sub = named ? [kindLabel(s.kind), dest].filter(Boolean).join(" · ") : "";
    el.innerHTML = `
      <div class="row">
        <h3>${escapeHtml(title)}</h3>
        <span class="pill ${s.enabled === false ? "off" : "on"}">${s.enabled === false ? "off" : "on"}</span>
      </div>
      ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ""}
    `;
    root.appendChild(el);
  }
}

function selectMatter(id, kind = "candidate") {
  if (!id) return;
  state.selectedId = id;
  state.selectedKind = kind;
  state.handoffNote = "";
  state.ackNote = "";
  renderMatters();
  renderQueue();
  renderDetail();
}

async function actOnCandidate(act, id) {
  await fetch(`/api/${act}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  state.selectedId = id;
  state.selectedKind = "candidate";
  await loadDesk();
}

async function copyId(id, btn) {
  if (!id) return;
  try {
    await navigator.clipboard.writeText(id);
    if (btn) {
      btn.textContent = "已复制";
      setTimeout(() => {
        if (btn.isConnected) btn.textContent = "复制 ID";
      }, 1200);
    }
  } catch {
    if (btn) {
      btn.textContent = "复制失败";
      setTimeout(() => {
        if (btn.isConnected) btn.textContent = "复制 ID";
      }, 1200);
    }
  }
}

queue.addEventListener("toggle", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLDetailsElement)) return;
  if (!el.classList.contains("needs-group")) return;
  const key = el.dataset.groupKey;
  if (key) state.groupOpen[key] = el.open;
});

document.getElementById("page-needs-you").addEventListener("click", async (e) => {
  const copyBtn = e.target.closest("button[data-copy-id]");
  if (copyBtn) {
    e.stopPropagation();
    await copyId(copyBtn.dataset.copyId, copyBtn);
    return;
  }
  const actBtn = e.target.closest("button[data-act]");
  if (actBtn) {
    e.stopPropagation();
    actBtn.disabled = true;
    await actOnCandidate(actBtn.dataset.act, actBtn.dataset.id);
    return;
  }
  const handoffBtn = e.target.closest("[data-handoff]");
  if (handoffBtn && !handoffBtn.disabled) {
    e.stopPropagation();
    handoffBtn.disabled = true;
    state.handoffNote = "…";
    renderDetail();
    try {
      const res = await fetch("/api/handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: handoffBtn.dataset.handoff }),
      });
      const data = await res.json();
      if (!res.ok) {
        state.handoffNote = data.error || JSON.stringify(data);
      } else {
        const pack = data.pack || {};
        const dest = pack.path || pack.target || "完成";
        state.handoffNote = `已交接 → ${dest}`;
      }
    } catch (err) {
      state.handoffNote = String(err);
    }
    renderDetail();
    return;
  }
  const ackBtn = e.target.closest("[data-ack]");
  if (ackBtn && !ackBtn.disabled) {
    e.stopPropagation();
    ackBtn.disabled = true;
    state.selectedId = ackBtn.dataset.ack;
    state.selectedKind = "checklist";
    state.ackNote = "…";
    renderDetail();
    try {
      const res = await fetch("/api/checklist-ack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: ackBtn.dataset.ack, ack: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        state.ackNote = data.error || JSON.stringify(data);
        renderDetail();
      } else {
        state.ackNote = "已确认 · 清单通过";
        await loadDesk();
      }
    } catch (err) {
      state.ackNote = String(err);
      renderDetail();
    }
    return;
  }
  const chk = e.target.closest("[data-select-checklist]");
  if (chk) {
    selectMatter(chk.dataset.selectChecklist, "checklist");
    return;
  }
  if (e.target.closest("summary.needs-group-summary")) return;
  const selectable = e.target.closest("[data-select]");
  if (selectable) selectMatter(selectable.dataset.select);
});

function seedTranscript() {
  if (transcript.dataset.seeded) return;
  transcript.dataset.seeded = "1";
  appendBubble(
    "lead",
    "Lead coordinates — it does not write production code in this page.\nTry: 有哪些源 · 打开 AI推进 群 · 只要 Agentic Working"
  );
}

function appendBubble(who, text, fail = false) {
  const el = document.createElement("div");
  el.className = `bubble ${who}${fail ? " fail" : ""}`;
  el.innerHTML = `<span class="who">${who === "user" ? "You" : "Lead"}</span>${escapeHtml(text)}`;
  transcript.appendChild(el);
  transcript.scrollTop = transcript.scrollHeight;
}

document.getElementById("lead-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("lead-input");
  const send = document.getElementById("lead-send");
  const utterance = input.value.trim();
  if (!utterance) return;
  appendBubble("user", utterance);
  input.value = "";
  send.disabled = true;
  try {
    const res = await fetch("/api/lead", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ utterance }),
    });
    const data = await res.json();
    const msg = data.message || JSON.stringify(data);
    appendBubble("lead", msg, !data.ok);
    await loadDesk();
  } catch (err) {
    appendBubble("lead", String(err), true);
  } finally {
    send.disabled = false;
    input.focus();
  }
});

async function loadDesk() {
  seedTranscript();
  const [cands, specs, sources, triggersRes, workspaces, agents, subs, checks, runtime] =
    await Promise.all([
      fetchJson("/api/candidates", { candidates: [] }),
      fetchJson("/api/specs", { specs: [] }),
      fetchJson("/api/sources", { sources: [] }),
      fetch("/api/triggers")
        .then(async (r) => ({ ok: r.ok, data: r.ok ? await r.json() : null }))
        .catch(() => ({ ok: false, data: null })),
      fetchJson("/api/workspaces", { workspaces: [] }),
      fetchJson("/api/agents", { providers: [] }),
      fetchJson("/api/subscriptions", { subscriptions: [] }),
      fetchJson("/api/checklists", { checklists: [], awaitingHumanAck: [] }),
      fetchJson("/api/meta", {}),
    ]);
  state.candidates = cands.candidates || [];
  state.groups = Array.isArray(cands.groups) ? cands.groups : [];
  state.specs = specs.specs || [];
  state.checklists = checks.checklists || [];
  state.sources = sources.sources || [];
  state.machines = workspaces.machines || {};
  state.meta = {
    lastExtractAt: runtime.lastExtractAt || null,
    lastRunAt: runtime.lastRunAt || null,
  };
  renderSources(sources);
  renderTriggers(triggersRes.data || {}, !triggersRes.ok);
  renderMatters();
  renderQueue();
  renderDetail();
  renderWorkspaces(workspaces);
  renderAgents(agents);
  renderSubs(subs);
}

async function loadSetup() {
  const data = await fetchJson("/api/setup", { checks: [], ready: false });
  const root = document.getElementById("setup-list");
  root.innerHTML = "";
  if (!data.ready) {
    const note = document.createElement("p");
    note.className = "hint tiny";
    note.textContent = "cold-start needs attention";
    root.appendChild(note);
  }
  for (const c of data.checks || []) {
    const el = document.createElement("div");
    el.className = "check";
    el.innerHTML = `
      <div class="st ${escapeHtml(c.status)}">${escapeHtml(String(c.status || "").toUpperCase())}</div>
      <div>
        <div class="title">${escapeHtml(c.title)}</div>
        <div class="detail">${escapeHtml(c.detail)}</div>
        ${c.fix && c.status !== "ok" ? `<div class="detail">fix: ${escapeHtml(c.fix)}</div>` : ""}
      </div>`;
    root.appendChild(el);
  }
}

function fmtFloor(n) {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : "n/a";
}

function fmtPct(rate) {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return "n/a";
  return `${Math.round(rate * 100)}%`;
}

function layaStatusLabel(laya) {
  if (!laya) return "";
  if (laya.enabled === false) return "Laya 关闭";
  if (laya.ok === true) return "Laya 在线";
  if (laya.ok === false) return "Laya 未连上";
  return "";
}

function renderStatus() {
  if (!statusStrip) return;
  const s = state.status || {};
  const bits = [];
  const when = formatLastActivity({
    lastRunAt: s.lastRunAt || state.meta.lastRunAt,
    lastExtractAt: s.lastExtractAt || state.meta.lastExtractAt,
  });
  bits.push(when || "尚无 atom run");
  const floors = s.preference?.floors;
  if (floors) {
    bits.push(
      `门槛 noise ${fmtFloor(floors.noise)} / merge ${fmtFloor(floors.merge)} / outbound ${fmtFloor(floors.outbound)}`
    );
  }
  if (s.desk?.ok) bits.push("Desk 正常");
  const laya = layaStatusLabel(s.laya);
  if (laya) bits.push(laya);
  statusStrip.textContent = bits.join(" · ");
}

async function loadStatus() {
  const data = await fetchJson("/api/status", null);
  if (data && data.ok) {
    state.status = data;
    if (data.lastRunAt || data.lastExtractAt) {
      state.meta = {
        lastRunAt: data.lastRunAt || state.meta.lastRunAt || null,
        lastExtractAt: data.lastExtractAt || state.meta.lastExtractAt || null,
      };
    }
  } else {
    state.status = { desk: { ok: false } };
  }
  renderStatus();
}

function renderProcessed() {
  const root = document.getElementById("processed-root");
  const d = state.digest;
  const done = Array.isArray(state.alreadyDone) ? state.alreadyDone : [];
  if (!d && !done.length) {
    root.innerHTML = '<p class="processed-note">读不到 gate-digest。确认 Desk API 在跑，然后刷新。</p>';
    return;
  }
  const extract = d?.extract || {};
  const merge = d?.merge || {};
  const outbound = d?.outbound || {};
  const proxies = d?.proxies || {};
  const desk = d?.desk || {};
  const windowLabel = d?.window_hours != null ? `${d.window_hours}h` : "24h";
  const doneCards = done
    .map((c) => {
      const reason = firstHuman(c.closed_reason) || "已在仓库/历史进度关闭";
      return `<article class="item processed-card" data-done-id="${escapeHtml(c.id)}">
        <h3>${escapeHtml(firstHuman(c.title) || "未命名事项")}</h3>
        <p class="card-summary">${escapeHtml(reason)}</p>
        ${metaLine({
          sources: citeLabels(c.refs),
          extra: ["自动关闭"],
          when: relativeTime(c.updated_at),
          quiet: true,
        })}
        <div class="card-actions">
          <button type="button" class="ghost" data-reopen="${escapeHtml(c.id)}">仍要我跟</button>
        </div>
      </article>`;
    })
    .join("");
  root.innerHTML = `
    <p class="processed-note">窗口 ${escapeHtml(windowLabel)} · 只读 · 未发云之家、未改门槛、未训练 Laya。</p>
    <div class="stat-grid">
      <div class="stat-card">
        <span class="num">${escapeHtml(String(extract.noise_dropped ?? 0))}</span>
        <span class="lbl">噪音已丢弃</span>
        ${
          extract.laya_noise_dropped
            ? `<span class="sub">其中 Laya ${escapeHtml(String(extract.laya_noise_dropped))}</span>`
            : ""
        }
      </div>
      <div class="stat-card">
        <span class="num">${escapeHtml(String(merge.merged ?? 0))}</span>
        <span class="lbl">已合并重复</span>
        <span class="sub">Needs you 仍开 ${escapeHtml(String(merge.open ?? 0))}</span>
      </div>
      <div class="stat-card">
        <span class="num">${escapeHtml(String(extract.already_done ?? done.length))}</span>
        <span class="lbl">进度已关闭</span>
        <span class="sub">已在仓库/历史进度关闭</span>
      </div>
      <div class="stat-card">
        <span class="num">${escapeHtml(
          `${outbound.allow ?? 0} / ${outbound.drop ?? 0} / ${outbound.hold ?? 0}`
        )}</span>
        <span class="lbl">出站 allow / drop / hold</span>
        <span class="sub">检查 ${escapeHtml(String(outbound.checks ?? 0))} 次</span>
      </div>
      <div class="stat-card">
        <span class="num">${escapeHtml(fmtPct(proxies.auto_rate))}</span>
        <span class="lbl">自动处理率 auto_rate</span>
        <span class="sub">${escapeHtml(proxies.auto_rate_note || "")}</span>
      </div>
    </div>
    <p class="processed-note">Desk 拍板：通过 ${escapeHtml(String(desk.accepted ?? 0))} · 拒绝 ${escapeHtml(
      String(desk.rejected ?? 0)
    )} · 待拍板 ${escapeHtml(String(desk.suggested ?? 0))}</p>
    ${
      done.length
        ? `<div class="processed-done">
            <h3 class="processed-done-head">自动关闭</h3>
            ${doneCards}
          </div>`
        : '<p class="processed-note">尚无「已在仓库/历史进度关闭」的卡片。</p>'
    }
    ${
      d?.markdown
        ? `<details><summary>原始 markdown</summary><pre class="rsi-preview">${escapeHtml(
            d.markdown
          )}</pre></details>`
        : ""
    }
  `;
}

async function loadProcessed() {
  const [digest, cands] = await Promise.all([
    fetchJson("/api/gate-digest?since=24h", null),
    fetchJson("/api/candidates", { candidates: [] }),
  ]);
  state.digest = digest && digest.ok !== false ? digest : null;
  const list = Array.isArray(cands.candidates) ? cands.candidates : [];
  state.alreadyDone = list.filter(
    (c) =>
      c.status === "rejected" &&
      (c.disposition === "already_done" || c.reject_reason === "already_done")
  );
  renderProcessed();
}

function chipRow(items, kind) {
  if (!items.length) return `<p class="pref-meta">（空）</p>`;
  return `<div class="chips">${items
    .map(
      (p) =>
        `<span class="chip">${escapeHtml(p)}${
          kind === "block"
            ? `<button type="button" data-block-remove="${escapeHtml(p)}" aria-label="移除">×</button>`
            : ""
        }</span>`
    )
    .join("")}</div>`;
}

function rsiSummary(rsi) {
  if (!rsi) return "尚无 preference-rsi 记录。试算后可写入（现有 POST /api/preference-rsi）。";
  const d = rsi.deltas || {};
  return `${relativeTime(rsi.at) || rsi.at} · reason=${rsi.reason} changed=${rsi.changed}
noise ${fmtFloor(rsi.before?.noise)}→${fmtFloor(rsi.after?.noise)}（Δ ${fmtFloor(d.noise)}）
merge ${fmtFloor(rsi.before?.merge)}→${fmtFloor(rsi.after?.merge)}（Δ ${fmtFloor(d.merge)}）
outbound ${fmtFloor(rsi.before?.outbound)}→${fmtFloor(rsi.after?.outbound)}（Δ ${fmtFloor(d.outbound)}）`;
}

function renderPreferences() {
  const root = document.getElementById("preferences-root");
  const pack = state.preference;
  if (!pack) {
    root.innerHTML = '<p class="processed-note">读不到 preference memory。</p>';
    return;
  }
  const mem = pack.memory || {};
  const th = mem.thresholds || { noise: 0.8, merge: 0.8, outbound: 0.8 };
  const flash = state.prefNote
    ? `<p class="pref-flash${state.prefNoteFail ? " fail" : ""}">${escapeHtml(state.prefNote)}</p>`
    : "";
  const preview = state.rsiPreview
    ? `<pre class="rsi-preview">${escapeHtml(
        `试算 reason=${state.rsiPreview.reason} changed=${state.rsiPreview.changed}
noise ${fmtFloor(state.rsiPreview.before?.noise)}→${fmtFloor(state.rsiPreview.after?.noise)}
merge ${fmtFloor(state.rsiPreview.before?.merge)}→${fmtFloor(state.rsiPreview.after?.merge)}
outbound ${fmtFloor(state.rsiPreview.before?.outbound)}→${fmtFloor(state.rsiPreview.after?.outbound)}
allow +${(state.rsiPreview.added_allowlist || []).join(" | ") || "无"}
block +${(state.rsiPreview.added_blocklist || []).join(" | ") || "无"}`
      )}</pre>`
    : "";
  root.innerHTML = `
    <div class="pref-block">
      <h3>来源</h3>
      <p class="pref-meta">
        真实来源：<code>${escapeHtml(pack.source_of_truth || "data/preference-memory.json")}</code>
        ${pack.exists ? "（文件在）" : "（文件尚未写出，下面是默认门槛 0.80）"}<br />
        更新时间：${escapeHtml(mem.updated_at ? relativeTime(mem.updated_at) : "从未写入")}
      </p>
    </div>
    <div class="pref-block">
      <h3>门槛（0.70–0.95，保存时夹紧）</h3>
      <div class="pref-grid">
        <div class="pref-field">
          <label for="pref-noise">noise</label>
          <input id="pref-noise" type="number" min="0.7" max="0.95" step="0.02" value="${escapeHtml(
            String(th.noise)
          )}" />
        </div>
        <div class="pref-field">
          <label for="pref-merge">merge</label>
          <input id="pref-merge" type="number" min="0.7" max="0.95" step="0.02" value="${escapeHtml(
            String(th.merge)
          )}" />
        </div>
        <div class="pref-field">
          <label for="pref-outbound">outbound</label>
          <input id="pref-outbound" type="number" min="0.7" max="0.95" step="0.02" value="${escapeHtml(
            String(th.outbound)
          )}" />
        </div>
      </div>
      <div class="pref-actions">
        <button type="button" class="primary" id="pref-save-floors">保存门槛</button>
      </div>
    </div>
    <div class="pref-block">
      <h3>屏蔽词 blocklist</h3>
      <p class="pref-meta">命中标题/正文的候选当噪音丢掉。至少 4 个字符。允许列表只读（由 RSI 维护）。</p>
      ${chipRow(mem.blocklist || [], "block")}
      <form class="chip-add" id="pref-block-form">
        <input id="pref-block-input" maxlength="24" placeholder="加一条屏蔽词" />
        <button type="submit" class="primary">添加</button>
      </form>
      <h3 class="subhead">允许列表 allowlist</h3>
      ${chipRow(mem.allowlist || [], "allow")}
    </div>
    <div class="pref-block">
      <h3>上次 RSI</h3>
      <p class="pref-meta">${escapeHtml(rsiSummary(pack.last_rsi))}</p>
      <div class="rsi-actions">
        <button type="button" id="pref-rsi-dry">试算 RSI</button>
        <button type="button" class="primary" id="pref-rsi-apply">写入 RSI</button>
      </div>
      ${preview}
      ${flash}
    </div>
  `;
}

async function loadPreferences() {
  const data = await fetchJson("/api/preference-memory", null);
  state.preference = data && (data.memory || data.ok !== false) ? data : null;
  renderPreferences();
}

async function patchPreference(body) {
  try {
    const res = await fetch("/api/preference-memory", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      state.prefNote = data.error || JSON.stringify(data);
      state.prefNoteFail = true;
    } else {
      state.preference = data;
      state.prefNote = data.changed ? "已写入 preference-memory.json（已夹紧，未训练 Laya）" : "没有变化";
      state.prefNoteFail = false;
    }
  } catch (err) {
    state.prefNote = String(err);
    state.prefNoteFail = true;
  }
  renderPreferences();
  loadStatus();
}

async function runRsi(apply) {
  try {
    const res = await fetch("/api/preference-rsi", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apply: apply === true }),
    });
    const data = await res.json();
    if (!res.ok) {
      state.prefNote = data.error || JSON.stringify(data);
      state.prefNoteFail = true;
    } else {
      state.rsiPreview = data;
      state.prefNote = apply
        ? data.changed
          ? "已写入 RSI（preference-rsi --apply）"
          : `RSI ${data.reason}，未改文件`
        : `试算完成 reason=${data.reason}（未写文件）`;
      state.prefNoteFail = false;
      if (apply) await loadPreferences();
    }
  } catch (err) {
    state.prefNote = String(err);
    state.prefNoteFail = true;
  }
  renderPreferences();
  loadStatus();
}

document.getElementById("page-preferences").addEventListener("click", async (e) => {
  const save = e.target.closest("#pref-save-floors");
  if (save) {
    save.disabled = true;
    await patchPreference({
      thresholds: {
        noise: Number(document.getElementById("pref-noise")?.value),
        merge: Number(document.getElementById("pref-merge")?.value),
        outbound: Number(document.getElementById("pref-outbound")?.value),
      },
    });
    return;
  }
  const remove = e.target.closest("[data-block-remove]");
  if (remove) {
    remove.disabled = true;
    await patchPreference({ blocklist_remove: [remove.dataset.blockRemove] });
    return;
  }
  const dry = e.target.closest("#pref-rsi-dry");
  if (dry) {
    dry.disabled = true;
    await runRsi(false);
    return;
  }
  const applyBtn = e.target.closest("#pref-rsi-apply");
  if (applyBtn) {
    applyBtn.disabled = true;
    await runRsi(true);
  }
});

document.getElementById("page-preferences").addEventListener("submit", async (e) => {
  const form = e.target.closest("#pref-block-form");
  if (!form) return;
  e.preventDefault();
  const input = document.getElementById("pref-block-input");
  const value = input?.value.trim() || "";
  if (value.length < 4) {
    state.prefNote = "屏蔽词至少 4 个字符（与 RSI 规则相同）";
    state.prefNoteFail = true;
    renderPreferences();
    return;
  }
  await patchPreference({ blocklist_add: [value] });
});

document.getElementById("page-processed")?.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-reopen]");
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  try {
    const res = await fetch("/api/reopen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: btn.dataset.reopen, note: "仍要我跟" }),
    });
    const data = await res.json();
    if (!res.ok) {
      btn.disabled = false;
      btn.textContent = data.error || "无法重开";
      return;
    }
    await loadProcessed();
    await loadDesk();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = String(err);
  }
});

window.addEventListener("hashchange", () => {
  const page = pageFromHash();
  if (page !== state.page) showPage(page, { skipHash: true });
});

showPage(pageFromHash());

document.querySelectorAll(".drawers details").forEach((d) => {
  d.addEventListener("toggle", () => {
    if (!d.open) return;
    document.querySelectorAll(".drawers details").forEach((other) => {
      if (other !== d) other.open = false;
    });
  });
});
