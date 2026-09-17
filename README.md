# vouch

> Every demand, vouched.

Append-only demand feed with mandatory citations and human gates.

Dogfood first on personal chat sources (e.g. Yunzhijia via local CLI). Overseas Slack-compatible product comes later. This repo currently holds **core design and contracts only** — no runtime yet.

Append-only **demand feed** with mandatory citations and human gates.

Dogfood first on personal chat sources (e.g. Yunzhijia via local CLI). Overseas Slack-compatible product comes later. This repo currently holds **core design and contracts only** — no runtime yet.

## One-liner

Machines propose. Humans decide. Every claim points at evidence.

## Stages (build in order)

1. **Demand pool** — ingest messages → propose candidates with refs → approve / reject / merge
2. **Spec** — accepted items become testable acceptance criteria
3. **Handoff** — export to existing coding agents (Cursor / Codex), do not build a coding model
4. **Evidence** — tests / screenshots packaged against criteria
5. **Land** — PR + release checklist; merge/release stay human-gated

## Docs

| Doc | What it is |
|---|---|
| [00-vision](docs/00-vision.md) | Why this exists and what we refuse to be |
| [01-architecture](docs/01-architecture.md) | Layers, single source of truth, projections |
| [02-event-contract](docs/02-event-contract.md) | 事元 / event feed — the core contract |
| [03-stages](docs/03-stages.md) | Stage doors and human gates |
| [04-stack](docs/04-stack.md) | Week-1 tech stack |
| [05-non-goals](docs/05-non-goals.md) | Explicit non-goals and competitor stance |

## Status

- Design: in progress (v0)
- Runtime: not started
- License: MIT (intended)

## Name

**vouch** — no citation, no candidate. Machines propose; humans decide.

