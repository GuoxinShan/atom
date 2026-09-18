# 12 · Operating plan (v0) — 干饭人 PM lock

Status: **recommended default** for the next 2 weeks of dogfood.
Owner: Guoxin (human gates) · ATOM daemon (timed pull) · Lead (route/brief only).

## 1. Positioning (one sentence)

ATOM is a **cited demand inbox + human triage desk**, not a coding factory and not Cursor Projects.

- In: 云之家 (scoped groups) → seeds → Grok extract → Needs you
- Out: accepted → spec → handoff pack in the right workspace → checklist → you decide PR
- Not in: auto-code, auto-merge, auto-post to 云之家, multi-tenant SaaS

## 2. Daily rhythm (作息)

| When (Asia/Shanghai) | Who | What |
|---|---|---|
| Boot / login | launchd | `pnpm atom serve` stays up on Rock-Shan (Desk API) |
| 09:30 workdays | launchd / cron | `POST /api/run` (yzj default groups only) → local digest |
| Anytime | You | Open Desk → **Needs you** only (approve / reject / checklist ack) |
| 18:30 optional | cron | second `run` if you want evening catch-up (default **off** week 1) |

Rules:
- Autonomous job may **only** ingest + extract + write digest projection.
- Never auto-approve, never auto-handoff `--run`, never send 云之家 without confirm.
- If serve is down, timed job fails loud (log + optional Mac notification); it does not spawn a second DB writer path.

## 3. After Accept (交付边界)

```
Approve
  → spec_drafted (auto, already)
  → handoff_exported to routed workspace (auto on Approve? NO in week 1)
  → you click Handoff when ready (Desk)
  → checklist (tests / evidence / summary / human_gate_ack)
  → pr-open only after checklist passed
  → coding agent --run: OFF by default; only when you pass --run or a future explicit Desk toggle
```

Week 1 lock:
- **Accept = “值得跟”**, not “开写”.
- Handoff is a separate human click (keeps Needs you calm).
- Coding stays confirm-gated; ATOM stops at a good brief + path.

Week 2+ (only if handoffs pile up unused): optional “Accept & handoff” one-click still **without** `--run`.

## 4. Sources & noise (群 / 标准)

Default on:
- `yzj` → **Agentic Working 验证** only

Default off (enable via Lead NL when you mean it):
- `yzj-ai-advance` → 【AI推进】

Noise (reject / never seed) — already partly in `noise.ts`, keep strict:
- Bot digests (`【来自…自动发送】`, `【AI产出·`)
- `收到✅` / 台账确认
- Raw log lines / stack traces
- Pure meeting-schedule smalltalk without a deliverable ask

Keep as candidates (human decides):
- @someone + 能不能/帮忙/缺了/不通/要支持
- Explicit product/CLI/agent asks (e.g. 上下文图谱单机版)

Duplicate policy:
- Same `cluster_key` / same primary ref token → skip on extract (`skipped`)
- Desk: if two suggested share the same ref token, show one and offer “拒重复”

## 5. Lead routing (fix the known bias)

Hard preference order when scoring workspaces:
1. Explicit product names: `ATOM` / `atom` → `atom`
2. Company product rails: `AI推进` / `lingee` / `1023` → `ai-advance` or `yzj` per existing map
3. **Do not** let bare words `云之家` / `yzj-cli` inside an ask steal routing to `yzj` if the ask is about another product (e.g. 上下文图谱 CLI)
4. Unsure → `atom` only for personal/side asks; otherwise leave unrouted and ask in Lead chat

Week 1 engineering: strip or down-weight tooling mentions in haystack (keep human title/body product nouns).

## 6. Two-week execution

### Week 1 — make dogfood boring
1. launchd plist: keep `atom serve` alive + 09:30 `curl -X POST localhost:8787/api/run`
2. Routing haystack fix (上文 §5)
3. Desk empty state copy: “今天没有要你拍板的” + last run time
4. Doc link from README → this plan

### Week 2 — only if Week 1 feels sticky
1. Optional 18:30 run
2. “Accept & handoff” (still no auto `--run`)
3. Dedup UI for same-ref duplicates
4. Wire one outbound sink to a **draft** (not send) for nightly digest confirm

## 7. Explicit non-goals (next month)

- Cursor Projects clone / long-lived Project chat as home
- Auto PR merge / zero-touch SDLC
- Opening 【AI推进】 by default
- China-first SaaS packaging / ICP path
- Replacing Grok CLI extract with raw model HTTP

## 8. Success bar (dogfood)

After 5 workdays:
- You open Desk ≤ 1×/day and clear Needs you in &lt; 10 minutes
- At least 3 accepted items have handoffs you actually used or consciously deferred
- Zero surprise 云之家 sends
- Timed run succeeded ≥ 4/5 mornings without you babysitting serve
