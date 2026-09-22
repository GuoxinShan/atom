# 07 · UI prototype

Status: **Desk is the implemented direction** — see [10-dispatch-desk.md](./10-dispatch-desk.md). The six-tab Control chrome is gone.

Open Desk at `http://127.0.0.1:8787` (`pnpm web`).

## Principles

- Calm triage desk, not a chat-GPT clone and not a Cursor Projects clone.
- Citations always visible; approve / reject is the primary verb.
- Listen → propose → **human gate** → route. Lead delegates; it does not execute code in-page.

## Daily focus

Default view is **Needs you** (human gates only). Suggested triage is the home screen. Lead composer, Listening details, workspaces, agents, outbound sinks, and atom/run logs are low-frequency — collapsed drawers or secondary nav. If a panel does not end in a human decision, it does not own the default view.

## Implemented shell

Top nav: **需要你拍板** (default) · **系统已处理** · **我的偏好** · **高级**.

| Region | What it is |
|---|---|
| Status strip | Last `atom run` if known, preference floors, Desk/Laya health (`GET /api/status`) |
| Center | **需要你拍板** — Suggested Approve/Reject nested under collapsible theme/project groups, checklist `human_gate_ack` (when any); outbound confirm only when a post is waiting. Empty: 「今天没有要你拍板的」+ that a clear queue is normal until watched groups produce new topics |
| Right rail | Selected **matter**: title, source chip, 【摘要】 / 【要你拍板】 / 【可选动作】, with 短 / 长 and 【原文】 on the same item (see [10-dispatch-desk.md](./10-dispatch-desk.md)) |
| 系统已处理 | Read-only 24h gate-digest: noise dropped / merged / outbound allow-drop-hold / auto_rate |
| 我的偏好 | `data/preference-memory.json` thresholds + blocklist; clamped PATCH; RSI dry-run/apply |
| Drawers | Listening, Lead, Matters (settled), Workspaces, Agents, Outbound — collapsed by default |
| 高级 | Atoms append-only log placeholder (collapsed) + Setup/cold-start |

## Not in v1

- Full Atoms log viewer (stub under **高级** only; use SQLite `events` / CLI).
- Blank “New Project” home chat.
- Outbound digest / chat-post confirm queue (no pending-confirm API yet; the slot is omitted until a post needs a gate).

## Visual direction

Light zinc inbox: page `#f7f7f8`, cards `#ffffff`, hairline `#e4e4e7`, text `#18181b` / muted `#71717a`, one cool accent `#6e7bf2`. Linear / Cursor Agents Window density — not copper editorial, no near-black charcoal, no purple SaaS.

## Agent-assisted setup

Empty states CTA: ask **Lead** (drawer) to wire a source or outbound sink. Agent proposes config → human confirms via NL → registry write.
