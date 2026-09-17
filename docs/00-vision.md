# 00 · Vision

## Problem

Product talk dies in chat. Meetings and group threads produce requests that never become trackable work — or become PRD prose nobody trusts.

Existing tools either:

- wait for a meeting bot and spit a document, or
- require `@bot` on a Slack thread, or
- promise full auto SDLC and fail the trust test.

## Bet

The scarce thing is not “smarter PRD writing”. It is an **incremental demand pool** where:

1. every candidate requirement has **mandatory source refs**,
2. the system runs **daily without being summoned**,
3. humans only **approve / reject / merge**,
4. later stages (spec → code handoff → test evidence → land) reuse the same **append-only event feed**.

## Dogfood path

1. Self-use on real work chat (Yunzhijia first).
2. Prove the habit: open the daily digest for two weeks.
3. Only then generalize adapters (Slack) and charge overseas (MoR), avoiding China ICP/payment as the first gauntlet.

## Success (stage 1)

- Daily digest appears without manual scrape.
- Each candidate links to original message ids.
- Accept/reject leaves an auditable trail.
- Author actually uses it before building stage 2+.
