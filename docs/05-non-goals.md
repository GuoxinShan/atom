# 05 · Non-goals

## Not building

- Another generic “Slack thread → PRD” bot
- Full coding agent / Devin clone
- Zero-touch SDLC with no human gates
- Clone of company 灵基 / AI推进 product surfaces
- China-first SaaS with ICP as day-one requirement
- Dual state machines (chat tool + our DB both authoritative)
- China ICP, MoR billing, or a hosted SaaS control plane
- Frontend / Next / web UI until a designed prototype exists (Stage-1 is CLI + Markdown digest only)
- HTTP webhook **receiver** / cron daemon in Stage-1 (TriggerRegistry stubs only)
- Outbound webhook **POST** / pull HTTP API in Stage-1 (SubscriptionRegistry + `onAtom` stubs only)

## Competitor stance

Open-source and SaaS already cover meeting bots and on-demand PRD generation (examples in research notes: agent-pm, workforce0-style pipelines, resetDocs-class products, meeting-notes templates).

**Differentiation we claim:** daily incremental pool + mandatory citations + approve queue + event feed that survives into spec/evidence — starting where the author’s real chat lives.

If the product becomes “just generate a PRD from pasted text”, delete the project and use a skill instead.

## IP note

Company design documents inspired *discipline* (gates, refs, append-only feed). This repo must not copy proprietary schemas, prompts, or code from employer repositories.
