# 10 · Dispatch Desk (Lead UI)

Status: **locked direction** — implemented in `apps/web` as Desk (not a Cursor Projects clone).

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

1. Suggested candidates (approve / reject / merge) — **display-grouped** by stored `theme` / `project` tags mapped onto the closed Chinese vocabulary in `data/theme-vocabulary.json` (Laya writes these after extract when it is up; timeout/5xx leave cards untagged). Untagged / 「其他」 / weak titles **divert** onto that same list from title/body; leftover heuristic buckets whose workspace title is a canonical theme (e.g. AI推进) collapse into the theme group. Else a workspace + title-stem / `cluster_key` heuristic. Same-request merge folds near-duplicate cards; groups nest distinct cards. The **Done gate** (after noise/merge, before theme tag) matches repo progress + Desk history + high-confidence 云之家「已完成」talk; hits leave this queue as `already_done`.
2. **规格待审** — after accept, the auto-drafted spec (title / body / acceptance criteria). Distinct from the candidate queue. 批准规格 / 退回修改, then confirm-gated **派给 Lead** (local pack; no coding unless CLI `--run`).
3. Checklist human_gate_ack
4. Outbound digest / chat post confirm (when enabled)

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

Home is **Needs you**, not a coordinator chat and not a three-column settled board.

```
┌────────────────────────────────────────┬──────────────────┐
│ 需要你拍板 (Needs you) — default home  │ Matter detail    │
│ · Suggested, folded by theme/project   │ 【摘要】         │
│   (通过 / 拒绝 still per card)         │ 【要你拍板】     │
│ · 规格待审 (批准规格 / 退回 / 派给 Lead)│ 【可选动作】     │
│ · Checklist ack (when any)             │ 短 / 长          │
│ · Outbound confirm (when enabled)      │ ▸ Listening      │
│                                        │ ▸ Lead           │
│                                        │ ▸ Matters        │
│                                        │ ▸ Workspaces     │
│                                        │ ▸ Agents         │
│                                        │ ▸ Outbound       │
└────────────────────────────────────────┴──────────────────┘
```

## Brief interaction

Needs-you cards, the opened theme group, and the matter detail share one contract. It is how Desk presents gates that already exist. It is not a new agent, routine, or chat.

1. **【摘要】** — what changed, plus why this is on Needs you (cite + one short reason). The summary is already on screen. Desk does not ask whether you want to see it.
2. **【要你拍板】** — the decision, urgency first within a theme group (higher confidence, then older `updated_at`; display only). Each option is a verb plus one line of consequence:
   - **A 通过** — 记为已通过，草稿进「规格待审」。不外发、不开工。 / **B 拒绝** — 移出今天的队列。只记在本机。
   - **A 批准规格** — 记为已批准。还不会写交接包，也不会外发。 / **B 退回修改** — 留在规格待审。
   - **A 派给 Lead** — 确认后写出本机交接包。不编码、不发云之家。 / **B 退回修改** — 回到待审，不写交接包。
   - **A 仍要我跟** — 重新放回 Needs you。只改本机。 / **B 保持关闭** — 留在系统已处理。
3. **【可选动作】** — **回群同步** and **先记下**. Default is do not send. 回群同步 stays disabled (`即将推出 · 不会发送`) until an outbound send is actually wired. 先记下 writes a local note in this browser. Neither sends 云之家, and Desk never auto-sends 云之家.

**Confirm** (`window.confirm`) runs only before **派给 Lead** and any future 发群. 通过, 拒绝, 批准规格, 退回修改, 确认清单, 仍要我跟, 保持关闭, and 先记下 apply on the first click.

**短 / 长** on the matter detail swaps the same item between short (title + 【摘要】 + the two action sections) and long (full body and 验收标准, or the spec edit form) without leaving the item or reloading the queue.

Empty Needs you stays **今天没有要你拍板的**.

Accepted / Rejected are settled — they live under the **Matters** drawer, not the home queue.

When Needs you has zero suggested and zero `awaitingHumanAck`, Desk shows calm copy: **今天没有要你拍板的**, plus that an empty queue is normal and new cards appear when watched groups have new topics. Last `atom run` time, preference floors, and cheap Desk/Laya health live on a one-line **status strip** (`GET /api/status`) — no invented clocks.

Top nav (Chinese labels, English page keys):

1. **需要你拍板** (`needs-you`) — default home
2. **系统已处理** (`processed`) — read-only last-24h gate-digest (noise dropped / merged / already_done / outbound allow-drop-hold / auto_rate) plus auto-closed cards labeled **已在仓库/历史进度关闭** or **云之家进度关闭**. 「仍要我跟」 reopens that card onto Needs you. Accepted specs show **已通过 → spec 待审 → 已批准 → 已派 Lead**.
3. **我的偏好** (`preferences`) — view + clamped light-edit of `data/preference-memory.json`; RSI via existing `POST /api/preference-rsi`
4. **高级** (`advanced`) — Atoms append-only log placeholder (collapsed) + spec 进度 + cold-start/Setup. Not the home screen; backend log/API unchanged.

Lead / Listening / providers / workspaces / outbound stay **collapsed drawers** on Needs you, not peer tabs.

## Primary verbs

1. Approve / Reject (triage)
2. 批准规格 / 退回修改 / 派给 Lead (spec review; only handoff / 发群 is confirm-gated)
3. Ask Lead (NL config + route explain)
4. Open Matter (spec → handoff → checklist → pr)

## Non-goals

- No fake “New Project” empty chat as the home screen
- No pretending Lead writes production code in-page
- No purple SaaS; keep a light zinc inbox + one indigo accent (`#6e7bf2`), Linear / Cursor Agents Window density
