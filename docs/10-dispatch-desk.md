# 10 · Dispatch Desk (Lead UI)

Status: **locked direction** — implement this, not a Cursor Projects clone.

## Same energy as Cursor Projects

| Borrow | How ATOM uses it |
|---|---|
| Coordinator chat | Sticky **Lead** composer — config, route, “why this workspace” |
| Listening pill | Inbound sources + triggers (yzj groups, hooks, cron) |
| Shared context | `user-context.md` + `workspaces.json` + `agents.json` (not a growing Project folder) |
| Delegate, don’t execute | Lead routes / briefs; extract & coding providers do the work |

## Why it is *not* Projects

| Cursor Projects | ATOM Desk |
|---|---|
| Unit = long-lived **Project** (feature / migration) | Unit = **atom / candidate** with mandatory refs |
| Blank chat → plan → many coding agents | **Listen → propose → human gate → route** |
| Cloud-first computers | Local-first (Rock-Shan) + pluggable providers |
| Review after agents code | **Approve before** handoff / coding |
| Subscriptions mostly Slack/PR/CI | Subscriptions mostly **IM demand** + outbound atom webhooks |

Projects optimizes *shipping code over months*. ATOM optimizes *not losing cited demands from chat*.


## Daily focus (non-negotiable)

**Home = Needs you.** Only surfaces that need a human gate:

1. Suggested candidates (approve / reject / merge)
2. Checklist human_gate_ack
3. Outbound digest / chat post confirm (when enabled)

Everything else is **low-frequency** and must not compete for attention:

| Surface | Frequency | Placement |
|---|---|---|
| Lead NL config | occasional | collapsed composer / drawer |
| Sources / triggers / Listening detail | rare setup | left rail collapsed or Settings |
| Workspaces / agent providers | rare setup | drawer under gear |
| Atom / run log | debug only | secondary **Atoms** nav, not Desk home |
| Cold-start / doctor | new machine | Setup nav |

If a screen does not end in a human decision, it does not own the default view.

## Layout (v1)

```
┌─────────────┬──────────────────────────────┬──────────────────┐
│ Listening   │  Lead chat (coordinator)     │  Matter detail   │
│ · sources   │  + recent Lead replies       │  (selected cand/ │
│ · triggers  │                              │   spec/handoff)  │
│ Matters     ├──────────────────────────────┴──────────────────┤
│ · accepted  │  Triage board (Suggested / Accepted / Rejected) │
│ · handoffs  │  citations always visible                        │
└─────────────┴─────────────────────────────────────────────────┘
```

Top nav collapses to: **Desk** (default) · **Atoms** (log) · **Setup**.
Providers / workspaces / outbound sinks live as **drawers** inside Desk (gear on Listening / Lead), not six peer tabs.

## Primary verbs

1. Approve / Reject (triage)
2. Ask Lead (NL config + route explain)
3. Open Matter (spec → handoff → checklist → pr)

## Non-goals

- No fake “New Project” empty chat as the home screen
- No pretending Lead writes production code in-page
- No purple SaaS; keep dark editorial (charcoal + copper)
