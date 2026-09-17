# ATOM

> Append-only Timeline Of Matters · 事元

Machines propose. Humans decide. Every claim points at evidence.

Dogfood first on personal chat sources (e.g. Yunzhijia via local CLI). Overseas Slack-compatible product comes later. This repo currently holds **core design and contracts only** — no runtime yet.

## One-liner

Cited demand pool on an append-only **ATOM** feed — human gates all the way to land.

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
| [02-atom-contract](docs/02-atom-contract.md) | Core contract for the ATOM feed |
| [03-stages](docs/03-stages.md) | Stage doors and human gates |
| [04-stack](docs/04-stack.md) | Week-1 tech stack |
| [05-non-goals](docs/05-non-goals.md) | Explicit non-goals and competitor stance |

## Status

- Design: in progress (v0)
- Runtime: not started
- License: MIT (intended)

## Naming

| Thing | Name |
|---|---|
| **Product** | **ATOM** (*Append-only Timeline Of Matters* / 事元) |
| Unit of change | atom (one append-only record) |
| Persistence table | `events` (implementation detail — **not** the product name) |
| Old working title | vouch (retired) |
