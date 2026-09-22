# 12 · Operating plan (v0) — 干饭人 PM lock

Status: **recommended default** for the next 2 weeks of dogfood.
Owner: Guoxin (human gates) · ATOM daemon (timed pull) · Lead (route/brief only).

## 1. Positioning (one sentence)

ATOM is a **cited demand inbox + human triage desk**, not a coding factory and not Cursor Projects.

- In: 云之家 (scoped groups) → seeds → Grok extract → noise/merge → Done gate → theme tag → Needs you
- Out: accepted → spec → handoff pack in the right workspace → checklist → you decide PR
- Not in: auto-code, auto-merge, auto-post to 云之家, multi-tenant SaaS

## 2. Daily rhythm (作息)

| When (Asia/Shanghai) | Who | What |
|---|---|---|
| You start it | `pnpm desk` (compose + Mac progress-scan helper) or `docker compose up -d` / `pnpm serve` | Desk API + in-process poll on Rock-Shan. **Not** a login item / LaunchAgent; compose uses `restart: "no"`. |
| Weekdays 08:00–20:00, every 15m | Desk daemon + host helper | Refresh `data/progress-snapshot.json` (Mac git/`gh`), then the same pipeline as `POST /api/run` for `yzj-ai-advance` (configured groups ∪ ~8 recent private chats). Skip nights/weekends/overlap. Scan fail → last snapshot, poll continues. |
| After a morning tick | 干饭人 / you | `pnpm atom gate-digest` — paste the markdown if you want a gate-acceptance line in the group; JSON is `GET /api/gate-digest` |
| When you ship / after PRs land | (automatic) | Next 15m tick picks up merged PRs / git log. Hard-refresh Desk. One-shot `pnpm atom progress-scan` is optional. |
| Anytime | You | Open Desk → **Needs you** (通过 / 拒绝, then 规格待审 → 派给 Lead). Hard-refresh `:8787`. |
| After triage | You | `pnpm atom preference-rsi` (dry-run) then `--apply` if the deltas look right |

Toggle the poll in `data/triggers.json` (`id: poll-yzj-15m`). Restart the container / serve after edits. `ATOM_CRON=0` disables the timer.

**Dogfood (Mac):** no LaunchAgents. Start Desk yourself:

```bash
pnpm desk                    # scripts/desk-up.sh — compose + Mac progress-scan --loop
# open http://127.0.0.1:8787
# one-time: docker compose exec desk yzj-cli auth login --device
# Laya remains http://127.0.0.1:8790 on the Mac (LAYA_URL=http://host.docker.internal:8790 in compose)
# After rebuild: wait ≤15m (or first in-window tick) and confirm
#   stat data/progress-snapshot.json   # mtime moved without hand-running progress-scan
#   docker compose logs desk | grep 'progress via='
pnpm desk:down               # helper + compose; keeps yzj/grok named volumes (login)
```

Host `pnpm serve` is still valid. Do not reinstall `com.guoxinshan.atom.serve` or `com.guoxinshan.atom.morning-run`. Live 云之家 ingest from Docker: Linux `@yunzhijia/cli` is **in the image**; one-time `docker compose exec desk yzj-cli auth login --device` (no host sidecar, no Mac binary bind-mount) — see README **Yunzhijia from Docker**.

Rules:
- Autonomous job may **only** ingest + extract + write digest projection (+ Done-gate `already_done` closes for already-shipped matches; never auto-accept, never auto-send).
- Never auto-approve, never auto-handoff `--run`, never send 云之家 without confirm.
- If serve is down, there is no timed pull (the timer lives in the daemon). Start compose / `pnpm serve` when you want the poll; do not add a second DB writer path.

## 3. After Accept (交付边界)

```
Approve
  → spec_drafted (auto, already) — card leaves Needs-you candidate queue
  → 规格待审 on Desk (human: 批准规格 / 退回修改)
  → spec_approved
  → you click 派给 Lead (confirm) → handoff_exported local pack
  → checklist (tests / evidence / summary / human_gate_ack)
  → pr-open only after checklist passed
  → coding agent --run: OFF by default; only when you pass --run
```

Week 1 lock:
- **Accept = “值得跟”**, not “开写”. No coding, no Yunzhijia, no Lead dispatch on accept.
- Spec review is a separate human gate. 派给 Lead is a third, confirm-gated click.
- Repeated 派给 Lead does not duplicate packs.
- Coding stays confirm-gated; ATOM stops at a good brief + path unless `--run`.

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
- Laya merge gate on extract folds new twins into an existing Needs-you item (open-item window ranked by title/body/ref near-duplicate; paraphrases merge at `same_request` ≥ 0.72)
- **Done gate** (after noise/merge, before theme tag) matches suggested cards against `data/progress-snapshot.json` (atom / yzj / ai-advance merged PRs, closed issues, recent main\|master commits) plus Desk accept/reject/merge history plus high-confidence 云之家 completion talk (`discourse` on that snapshot: 已完成 / 搞定 / 上线了, from messages already ingested — not a second pull). Repo title/stem hits need workspace affinity or shared distinctive tokens; atom meta PRs (Desk / Done-gate / chore) are not evidence that yzj / ai-advance product work is done. Chat hits need the completion subject to cover the card title and must not cross themes. Hit → `already_done` (off Needs-you). Repo/history reason 「已在仓库/历史进度关闭」; 云之家 reason 「云之家进度关闭」. Uncertain, vague chat, theme mismatch, or repo-scan fail → stay suggested
- Host-side refresh: 15m cron writes `data/progress-scan.request.json`; Mac helper (`pnpm atom progress-scan --loop` / `pnpm desk`) scans git/`gh` into `data/progress-snapshot.json` and **preserves** `discourse`. The Done gate (same tick, after ingest) folds 云之家 completions from SQLite into that field. Fail-open if the helper is down or no yzj messages are ingested. One-shot `pnpm atom progress-scan` still works. Do not docker-exec the scan. Hard-refresh Desk.
- One-shot backfill of twins created *before* that gate: `pnpm atom merge-sweep` then `--apply` (Laya up; dry-run default)
- One-shot theme/project tag backfill of untagged / 「其他」 / pre-allowlist suggested cards: `pnpm atom tag-backfill` then `--apply` (title/body divert + kebab aliases remap locally without new vocabulary; Laya up for remaining leftovers; dry-run default)
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
1. `pnpm desk` (or compose + `progress-scan --loop`) keeps `atom serve` alive when you start it. In-process 15m poll (`data/triggers.json` `poll-yzj-15m`) refreshes the progress snapshot then extract / Done gate. No LaunchAgents.
2. Routing haystack fix (上文 §5)
3. Desk empty state copy: “今天没有要你拍板的” + last run time
4. Doc link from README → this plan

### Week 2 — only if Week 1 feels sticky
1. Optional tighter hours / extra source in `data/triggers.json` (no LaunchAgent)
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
