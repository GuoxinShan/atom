const state = {
  page: "desk",
  candidates: [],
  specs: [],
  checklists: [],
  sources: [],
  machines: {},
  meta: {},
  selectedId: null,
  selectedKind: "candidate",
  handoffNote: "",
  ackNote: "",
};

const meta = document.getElementById("meta");
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

function metaLine({ sources = [], status = "", when = "", extra = [] } = {}) {
  const bits = [
    ...sources.map((s) => pill(s)),
    status ? pill(statusLabel(status) || status) : "",
    ...extra.map((x) => pill(x)),
    when ? `<span class="when">${escapeHtml(when)}</span>` : "",
  ].filter(Boolean);
  if (!bits.length) return "";
  return `<div class="meta-line">${bits.join("")}</div>`;
}

function showPage(name) {
  state.page = name;
  document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
  document.querySelectorAll(".nav button").forEach((b) => b.classList.remove("active"));
  document.getElementById(`page-${name}`)?.classList.add("active");
  document.querySelector(`.nav button[data-page="${name}"]`)?.classList.add("active");
  if (name === "desk") loadDesk();
  if (name === "setup") loadSetup();
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
    const extra = t.config?.path || "";
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

function renderQueue() {
  const suggested = state.candidates.filter((c) => c.status === "suggested");
  const acks = awaitingChecklists();
  const outbound = 0;
  meta.textContent = `${suggested.length + acks.length} need you`;
  const counts = document.getElementById("gate-counts");
  if (counts) {
    const bits = [`${suggested.length} suggested`];
    if (acks.length) bits.push(`${acks.length} checklist`);
    if (outbound) bits.push(`${outbound} outbound`);
    counts.textContent = bits.join(" · ");
  }
  queue.innerHTML = "";

  if (!suggested.length && !acks.length && !outbound) {
    const when = formatLastActivity(state.meta);
    queue.innerHTML = `<p class="clear">今天没有要你拍板的</p>${
      when ? `<p class="clear-meta">${escapeHtml(when)}</p>` : ""
    }`;
    return;
  }

  if (suggested.length) {
    const section = document.createElement("section");
    section.className = "col suggested";
    section.innerHTML = `<h2>Suggested <b>${suggested.length}</b></h2>`;
    for (const c of suggested) {
      const card = document.createElement("article");
      const selected = state.selectedKind !== "checklist" && (state.selectedId === c.id || specForCandidate(c.id)?.id === state.selectedId);
      card.className = `item${selected ? " selected" : ""}`;
      card.dataset.select = c.id;
      const title = firstHuman(c.title) || "未命名事项";
      const summary = (c.body || "").trim();
      card.innerHTML = `
        <h3>${escapeHtml(title)}</h3>
        ${summary ? `<p>${escapeHtml(summary.slice(0, 220))}</p>` : ""}
        ${metaLine({
          sources: citeLabels(c.refs),
          status: c.status,
          when: relativeTime(c.updated_at),
        })}
        <div class="card-actions">
          <button type="button" data-act="approve" data-id="${escapeHtml(c.id)}">Approve</button>
          <button type="button" data-act="reject" data-id="${escapeHtml(c.id)}">Reject</button>
        </div>
      `;
      section.appendChild(card);
    }
    queue.appendChild(section);
  }

  if (acks.length) {
    const section = document.createElement("section");
    section.className = "col suggested";
    section.innerHTML = `<h2>Checklist <b>${acks.length}</b></h2>`;
    for (const chk of acks) {
      const card = document.createElement("article");
      const selected = state.selectedKind === "checklist" && state.selectedId === chk.subjectId;
      card.className = `item${selected ? " selected" : ""}`;
      card.dataset.selectChecklist = chk.subjectId;
      const linked = state.candidates.find((c) => c.id === chk.candidateId);
      card.innerHTML = `
        <h3>${escapeHtml(firstHuman(chk.title, linked?.title) || "确认清单")}</h3>
        <p>其余项已完成，等你确认。ATOM 不会自动代点。</p>
        ${metaLine({
          sources: citeLabels(linked?.refs),
          extra: ["等人确认"],
          when: relativeTime(linked?.updated_at),
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

document.getElementById("page-desk").addEventListener("click", async (e) => {
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
  meta.textContent = data.ready ? "cold-start READY" : "cold-start needs attention";
  const root = document.getElementById("setup-list");
  root.innerHTML = "";
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

showPage("desk");

document.querySelectorAll(".drawers details").forEach((d) => {
  d.addEventListener("toggle", () => {
    if (!d.open) return;
    document.querySelectorAll(".drawers details").forEach((other) => {
      if (other !== d) other.open = false;
    });
  });
});
