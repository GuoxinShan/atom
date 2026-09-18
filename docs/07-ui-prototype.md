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

Top nav: **Desk** (default) · **Atoms** (stub) · **Setup**.

| Region | What it is |
|---|---|
| Center | **Needs you** — Suggested approve/reject, checklist `human_gate_ack` (when any); outbound confirm only when a post is waiting |
| Right rail | Selected **matter** (title, body, refs, Approve/Reject/Handoff/Ack) |
| Drawers | Listening, Lead, Matters (settled), Workspaces, Agents, Outbound — collapsed by default |

## Not in v1

- Full Atoms log viewer (stub page only; use SQLite `events` / CLI).
- Blank “New Project” home chat.
- Outbound digest / chat-post confirm queue (no pending-confirm API yet; the slot is omitted until a post needs a gate).

## Visual direction

Dark editorial: charcoal ground, copper `#c4a574` accent, Agents Window / Projects density without purple SaaS clichés.

## Agent-assisted setup

Empty states CTA: ask **Lead** (drawer) to wire a source or outbound sink. Agent proposes config → human confirms via NL → registry write.
