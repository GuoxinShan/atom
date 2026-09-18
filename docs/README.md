# ATOM docs

Authoritative contracts live alongside this tree on the Mac checkout:

- `02-atom-contract.md` — event / atom contract (`events` table)
- `06-extensibility.md` — SourceAdapter, ExtractAgent, registry, triggers, sinks
- `07-ui-prototype.md` / `10-dispatch-desk.md` — Desk UI (Lead + Listening + triage)
- `11-single-api.md` — Desk + CLI share one local HTTP daemon (no dual core path)

Runtime code in `packages/core` follows those contracts. The Desk server is the only process that loads core for side effects.
