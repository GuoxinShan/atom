const state = {
  page: "desk",
  candidates: [],
  specs: [],
  checklists: [],
  selectedId: null,
  selectedKind: "candidate",
  handoffNote: "",
  ackNote: "",
};

const meta = document.getElementById("meta");
const queue = document.getElementById("needs-queue");
const transcript = document.getElementById("lead-transcript");

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
    const groups = (s.groupIds || [])
      .map((g) => {
        const name = s.groupNames?.[g] || g;
        return `<span class="pill">${escapeHtml(name)}</span>`;
      })
      .join("");
    el.innerHTML = `
      <div class="row">
        <h3>${escapeHtml(s.id)}</h3>
        <span class="pill ${on ? "on" : "off"}">${on ? "on" : "off"}</span>
      </div>
      <div class="sub">${escapeHtml(s.kind)}${s.path ? " · " + escapeHtml(s.path) : ""}</div>
      <div>${groups}</div>
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
    const extra = t.config?.path || t.pipeline || "";
    el.innerHTML = `
      <div class="row">
        <h3>${escapeHtml(t.id)}</h3>
        <span class="pill ${on ? "on" : "off"}">${on ? "on" : "off"}</span>
      </div>
      <div class="sub">${escapeHtml(t.kind || "")}${extra ? " · " + escapeHtml(extra) : ""}</div>
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
      title: spec?.title || c.title,
      kind: spec ? "spec" : "accepted",
    });
  }
  for (const s of state.specs) {
    if (seenSpec.has(s.id)) continue;
    rows.push({
      key: s.id,
      candidateId: s.candidate_id,
      specId: s.id,
      title: s.title,
      kind: "spec",
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
      <span class="pill">${escapeHtml(m.kind)}</span>
    `;
    root.appendChild(btn);
  }
  for (const c of rejected) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `matter${state.selectedId === c.id ? " selected" : ""}`;
    btn.dataset.select = c.id;
    btn.innerHTML = `
      <h3>${escapeHtml(c.title)}</h3>
      <span class="pill off">rejected</span>
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
    const items = (chk.items || [])
      .map((i) => `- [${i.done ? "x" : " "}] ${i.key}`)
      .join("\n");
    root.innerHTML = `
      <h2>Checklist gate</h2>
      <div class="meta-id">${escapeHtml(chk.subjectId)}</div>
      <h3>${escapeHtml(chk.title || "Checklist")}</h3>
      <p class="body">${escapeHtml(items)}</p>
      <button type="button" class="cta primary" data-ack="${escapeHtml(chk.subjectId)}">Ack human gate</button>
      ${state.ackNote ? `<pre class="handoff-out">${escapeHtml(state.ackNote)}</pre>` : ""}
    `;
    return;
  }
  const title = sel.spec?.title || sel.cand?.title || "Untitled";
  const body = sel.spec?.body || sel.cand?.body || "";
  const refs = sel.spec?.refs || sel.cand?.refs || [];
  const status = sel.cand?.status || "spec";
  const canHandoff = status === "accepted" || sel.kind === "spec";
  const handoffId = sel.spec?.id || sel.candidateId;
  const refHtml =
    refs.map((r) => `<span class="pill">${escapeHtml(r.token)}</span>`).join("") ||
    '<span class="pill">no refs</span>';
  root.innerHTML = `
    <h2>Matter</h2>
    <div class="meta-id">${escapeHtml(sel.candidateId || "")}${sel.spec ? " · " + escapeHtml(sel.spec.id) : ""}</div>
    <h3>${escapeHtml(title)}</h3>
    <p class="body">${escapeHtml(body)}</p>
    <div class="refs">${refHtml}</div>
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
    queue.innerHTML =
      '<p class="clear">You\'re clear. Nothing needs a human gate. Listening, Lead, and providers stay in drawers.</p>';
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
      const refs = (c.refs || [])
        .map((r) => `<span class="pill">${escapeHtml(r.token)}</span>`)
        .join("");
      card.innerHTML = `
        <h3>${escapeHtml(c.title)}</h3>
        <p>${escapeHtml((c.body || "").slice(0, 220))}</p>
        <div class="refs">${refs || '<span class="pill">no refs</span>'}</div>
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
      card.innerHTML = `
        <h3>${escapeHtml(chk.title || chk.subjectId)}</h3>
        <p>All required items are done except <code>human_gate_ack</code>. ATOM will not auto-ack.</p>
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
  for (const w of data.workspaces || []) {
    const el = document.createElement("div");
    el.className = "drawer-row";
    el.innerHTML = `
      <div class="row">
        <h3>${escapeHtml(w.id)}</h3>
        <span class="pill">${escapeHtml(w.machine)}</span>
      </div>
      <div class="sub">${escapeHtml(w.path)}</div>
      <div>${(w.match || []).slice(0, 4).map((m) => `<span class="pill">${escapeHtml(m)}</span>`).join("")}</div>
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
    el.innerHTML = `
      <div class="row">
        <h3>${escapeHtml(p.id)}</h3>
        <span class="pill ${p.enabled === false ? "off" : "on"}">${p.enabled === false ? "off" : "on"}</span>
      </div>
      <div class="sub">${escapeHtml(p.role)} · ${escapeHtml(p.kind)}${isDefault ? " · default" : ""}</div>
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
    el.innerHTML = `
      <div class="row">
        <h3>${escapeHtml(s.id)}</h3>
        <span class="pill ${s.enabled === false ? "off" : "on"}">${s.enabled === false ? "off" : "on"}</span>
      </div>
      <div class="sub">${escapeHtml(s.kind || "webhook")} · ${escapeHtml(s.url || s.bin || s.path || "")}</div>
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

document.getElementById("page-desk").addEventListener("click", async (e) => {
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
        state.handoffNote = `ok · ${pack.id || ""} → ${pack.path || pack.target || ""}`;
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
        state.ackNote = "acked · checklist passed";
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
  const [cands, specs, sources, triggersRes, workspaces, agents, subs, checks] = await Promise.all([
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
  ]);
  state.candidates = cands.candidates || [];
  state.specs = specs.specs || [];
  state.checklists = checks.checklists || [];
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
