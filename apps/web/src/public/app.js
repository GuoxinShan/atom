const cols = [
  { key: "suggested", title: "Suggested" },
  { key: "accepted", title: "Accepted" },
  { key: "rejected", title: "Rejected" },
];

const meta = document.getElementById("meta");
const board = document.getElementById("board");

function showPage(name) {
  document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
  document.querySelectorAll(".nav button").forEach((b) => b.classList.remove("active"));
  document.getElementById(`page-${name}`)?.classList.add("active");
  document.querySelector(`.nav button[data-page="${name}"]`)?.classList.add("active");
  if (name === "board") loadBoard();
  if (name === "sources") loadSources();
  if (name === "subscriptions") loadSubs();
  if (name === "workspaces") loadWorkspaces();
  if (name === "agents") loadAgents();
  if (name === "setup") loadSetup();
}

document.getElementById("nav").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-page]");
  if (!btn) return;
  showPage(btn.dataset.page);
});

async function loadBoard() {
  const res = await fetch("/api/candidates");
  const data = await res.json();
  const list = data.candidates || [];
  meta.textContent = `${list.length} candidates · ${new Date().toLocaleString()}`;
  board.innerHTML = "";
  for (const col of cols) {
    const items = list.filter((c) => c.status === col.key);
    const el = document.createElement("section");
    el.className = "col";
    el.innerHTML = `<h2>${col.title} <b>${items.length}</b></h2>`;
    for (const c of items) {
      const card = document.createElement("article");
      card.className = "item";
      const refs = (c.refs || [])
        .map((r) => `<span class="pill">${escapeHtml(r.token)}</span>`)
        .join("");
      card.innerHTML = `
        <h3>${escapeHtml(c.title)}</h3>
        <p>${escapeHtml((c.body || "").slice(0, 160))}</p>
        <div class="refs">${refs || '<span class="pill">no refs</span>'}</div>
        ${
          c.status === "suggested"
            ? `<div class="card-actions">
                <button data-act="approve" data-id="${c.id}">Approve</button>
                <button data-act="reject" data-id="${c.id}">Reject</button>
              </div>`
            : ""
        }
      `;
      el.appendChild(card);
    }
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "Nothing here.";
      el.appendChild(empty);
    }
    board.appendChild(el);
  }
}

board?.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  btn.disabled = true;
  await fetch(`/api/${act}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  await loadBoard();
});

async function loadSources() {
  const data = await fetch("/api/sources").then((r) => r.json());
  const root = document.getElementById("sources-list");
  root.innerHTML = "";
  for (const s of data.sources || []) {
    const card = document.createElement("div");
    card.className = "card";
    const groups = (s.groupIds || [])
      .map((g) => {
        const name = s.groupNames?.[g] || g;
        return `<span class="pill">${escapeHtml(name)}</span>`;
      })
      .join("");
    card.innerHTML = `
      <h3>${escapeHtml(s.id)} <span class="pill">${s.enabled === false ? "off" : "on"}</span></h3>
      <div class="sub">kind=${escapeHtml(s.kind)} · defaultExtract=${escapeHtml(data.defaultExtractAgent || "")}</div>
      <div>${groups || '<span class="pill">no groups</span>'}</div>
    `;
    root.appendChild(card);
  }
}

async function loadSubs() {
  const data = await fetch("/api/subscriptions").then((r) => r.json());
  const root = document.getElementById("subs-list");
  root.innerHTML = "";
  const list = data.subscriptions || [];
  if (!list.length) {
    root.innerHTML = '<p class="hint">还没有出站订阅。让 Lead：「订阅加 https://…」</p>';
    return;
  }
  for (const s of list) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<h3>${escapeHtml(s.id)} <span class="pill">${escapeHtml(s.kind || "webhook")}</span></h3>
      <div class="sub">${escapeHtml(s.url || s.bin || s.path || "")}</div>
      <span class="pill">${s.enabled === false ? "off" : "on"}</span>
      <div>${(s.types || ["*"]).map((x) => `<span class="pill">${escapeHtml(x)}</span>`).join("")}</div>`;
    root.appendChild(card);
  }
}

async function loadWorkspaces() {
  const data = await fetch("/api/workspaces").then((r) => r.json());
  const root = document.getElementById("ws-list");
  root.innerHTML = "";
  for (const w of data.workspaces || []) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <h3>${escapeHtml(w.id)} <span class="pill">${escapeHtml(w.machine)}</span></h3>
      <div class="sub">${escapeHtml(w.path)}</div>
      <div class="sub">${escapeHtml(w.notes || "")}</div>
      <div>${(w.match || []).map((m) => `<span class="pill">${escapeHtml(m)}</span>`).join("")}</div>
    `;
    root.appendChild(card);
  }
}

async function loadSetup() {
  const data = await fetch("/api/setup").then((r) => r.json());
  meta.textContent = data.ready ? "cold-start READY" : "cold-start needs attention";
  const root = document.getElementById("setup-list");
  root.innerHTML = "";
  for (const c of data.checks || []) {
    const el = document.createElement("div");
    el.className = "check";
    el.innerHTML = `
      <div class="st ${c.status}">${c.status.toUpperCase()}</div>
      <div>
        <div class="title">${escapeHtml(c.title)}</div>
        <div class="detail">${escapeHtml(c.detail)}</div>
        ${c.fix && c.status !== "ok" ? `<div class="detail">fix: ${escapeHtml(c.fix)}</div>` : ""}
      </div>`;
    root.appendChild(el);
  }
}

document.getElementById("lead-send").addEventListener("click", async () => {
  const input = document.getElementById("lead-input");
  const out = document.getElementById("lead-result");
  const utterance = input.value.trim();
  if (!utterance) return;
  out.textContent = "…";
  const res = await fetch("/api/lead", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ utterance }),
  });
  const data = await res.json();
  out.textContent = (data.ok ? "OK " : "NO ") + (data.message || JSON.stringify(data));
  await loadSources();
  await loadSubs();
});

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

showPage("board");


async function loadAgents() {
  const data = await fetch("/api/agents").then((r) => r.json());
  const root = document.getElementById("agents-list");
  root.innerHTML = "";
  const defaults = data.defaults || {};
  for (const p of data.providers || []) {
    const card = document.createElement("div");
    card.className = "card";
    const isDefault = defaults[p.role] === p.id;
    card.innerHTML = `
      <h3>${escapeHtml(p.id)} ${isDefault ? '<span class="pill">default</span>' : ""}
        <span class="pill">${escapeHtml(p.role)}</span>
        <span class="pill">${escapeHtml(p.kind)}</span>
        <span class="pill">${p.enabled === false ? "off" : "on"}</span></h3>
      <div class="sub">${escapeHtml(p.notes || "")}</div>
      <div class="sub">bin=${escapeHtml(p.bin || "-")} cwdMode=${escapeHtml(p.cwdMode || "-")}</div>
      <div class="sub">url=${escapeHtml(p.url || "-")}</div>
    `;
    root.appendChild(card);
  }
}

document.getElementById("agent-lead-send")?.addEventListener("click", async () => {
  const input = document.getElementById("agent-lead-input");
  const out = document.getElementById("agent-lead-result");
  const utterance = input.value.trim();
  if (!utterance) return;
  out.textContent = "…";
  const res = await fetch("/api/lead", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ utterance }),
  });
  const data = await res.json();
  out.textContent = (data.ok ? "OK " : "NO ") + (data.message || JSON.stringify(data));
  await loadAgents();
});
