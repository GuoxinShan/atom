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
| Boot / login | launchd `com.guoxinshan.atom.serve` | `pnpm serve` stays up on Rock-Shan (Desk API + in-process poll) |
| Weekdays 08:00–20:00, every 15m | Desk daemon | Same pipeline as `POST /api/run` for `yzj-ai-advance` (configured groups ∪ ~8 recent private chats). Skip nights/weekends/overlap. |
| After a morning tick | 干饭人 / you | `pnpm atom gate-digest` — paste the markdown if you want a gate-acceptance line in the group; JSON is `GET /api/gate-digest` |
| Anytime | You | Open Desk → **Needs you** only (approve / reject / checklist ack) |
| After triage | You | `pnpm atom preference-rsi` (dry-run) then `--apply` if the deltas look right |

Toggle the poll in `data/triggers.json` (`id: poll-yzj-15m`). Restart serve after edits. `ATOM_CRON=0` disables the timer.

**Dogfood (Mac):** pull, restart **only** `com.guoxinshan.atom.serve`, then disable/remove the old morning-run agent:

```bash
launchctl kickstart -k gui/$(id -u)/com.guoxinshan.atom.serve
launchctl bootout gui/$(id -u)/com.guoxinshan.atom.morning-run
rm -f ~/Library/LaunchAgents/com.guoxinshan.atom.morning-run.plist
```

Rules:
- Autonomous job may **only** ingest + extract + write digest projection.
- Never auto-approve, never auto-handoff `--run`, never send 云之家 without confirm.
- If serve is down, there is no timed pull (the timer lives in the daemon). Keep `com.guoxinshan.atom.serve` loaded; do not add a second DB writer path.

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
- `yzj-ai-advance` → **【AI推进】** only

Default off:
- `yzj` → Agentic Working 验证 (noise / others' work — stay off)

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
- Laya merge gate on extract folds new twins into an existing Needs-you item
- One-shot backfill of twins created *before* that gate: `pnpm atom merge-sweep` then `--apply` (Laya up; dry-run default)
- Desk: if two suggested share the same ref token, show one and offer “拒重复”

## 5. Lead routing (fix the known bias)

Hard preference order when scoring workspaces:
1. Explicit product names: `ATOM` / `atom` → `atom`
2. Company product rails: `AI推进` / `lingee` / `1023` → `ai-advance` or `yzj` per existing map
3. **Do not** let bare words `云之家` / `yzj-cli` inside an ask steal routing to `yzj` if the ask is about another product (e.g. 上下文图谱 CLI)
4. Unsure → `atom` only for personal/side asks; otherwise leave unrouted and ask in Lead chat

Week 1 engineering: score title + acceptance only; strip generic tooling mentions from the haystack (see `LeadAgent.routeSpec` + `fixtures/lead-routing.json`).

## 6. Two-week execution

### Week 1 — make dogfood boring
1. launchd plist: keep `atom serve` alive. In-process 15m poll (`data/triggers.json` `poll-yzj-15m`). Remove `com.guoxinshan.atom.morning-run`.
2. Routing haystack fix (上文 §5)
3. Desk empty state copy: “今天没有要你拍板的” + last run time
4. Doc link from README → this plan

### Week 2 — only if Week 1 feels sticky
1. Optional tighter hours / extra source in `data/triggers.json` (no second LaunchAgent)
2. “Accept & handoff” (still no auto `--run`)
3. Dedup UI for same-ref duplicates
4. Wire one outbound sink to a **draft** (not send) for nightly digest confirm — `pnpm atom outbound-check` / `POST /api/outbound-check` first; Desk remains the send authority.
5. Optional daily `pnpm atom preference-rsi --apply` after Desk is cleared (clamped floors; never retrains Laya; never sends 云之家).
6. Optional `pnpm atom gate-digest` after the morning `run` (read-only; paste markdown; never sends 云之家).

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
- Timed run succeeded ≥ 4/5 workdays without you babysitting serve (watch `[cron:poll-yzj-15m] ok` in serve logs)
