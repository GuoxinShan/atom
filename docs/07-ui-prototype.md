# 07 · UI prototype (design)

Status: **design only** — implement after visual sign-off. No ugly scaffold UI.

## Principles

- Calm triage desk, not chat-GPT clone.
- Citations always visible; accept/reject is the primary verb.
- Sources & triggers are first-class screens (agent can configure both).

## Screens

1. **Today** — digest of new suggested candidates with ref chips.
2. **Queue** — approve / reject / merge; evidence drawer.
3. **Sources** — dynamic registry; “Configure with agent”.
4. **Triggers** — cron + webhook + IM hook + manual; enable/disable.
5. **Atoms** — append-only log viewer (read-only power user).

## Visual direction

Dark editorial: charcoal ground, copper/amber accent, generous whitespace, Linear-level density without purple SaaS clichés.

## Agent-assisted setup

Empty states CTA: “Ask agent to wire a source / trigger”. Agent proposes config → human confirms → registry write → optional test pull.
