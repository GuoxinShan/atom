# 09 · Agent providers（高自由度调度）

## Goal

**Lead / Extract / Coding / Execute** 都不是写死的实现，而是挂在可配置的 **Agent Provider** 上。

你可以：

- 本地 `grok` / `cursor-agent` CLI
- 打到 **Grok Bot webhook**（或任意 HTTP）
- 以后接 MCP / 别的 bot / 自建服务

同一角色可以换 provider，也可以按工作区覆盖。

## Roles

| role | 干什么 |
|---|---|
| `lead` | 懂用户 + 机器，改配置、路由工作区、决定派谁 |
| `extract` | 从种子消息产出带 refs 的候选 |
| `coding` | 按 handoff 在指定 cwd 改代码 |
| `execute` | 通用执行（测、脚本、运维动作）——仍受人审/确认策略约束 |

Heuristic **不是** extract provider，只是 seed gate。Docker 无 grok 登录时设 `ATOM_EXTRACT_AGENT=heuristic`：跳过 grok spawn，不产出候选（ingest / digest 仍跑）。

## Provider kinds

| kind | 调用方式 | 典型配置 |
|---|---|---|
| `local-cli` | spawn 本地二进制 | `bin`, `args`, `cwdMode` |
| `webhook` | HTTP POST JSON | `url`, `headers`, `secretEnv` |
| `grokbot-webhook` | webhook 特例 | `url`（Grok Bot inbound） |
| `http-json` | request/response JSON | `url`, `method` |
| `noop` | 只记账 | — |

`cwdMode`:

- `routed` — Lead 选出的 workspace path（默认 coding/execute）
- `atom` — ATOM 仓库根
- `fixed` — `cwd` 字段写死

## Config file: `data/agents.json`

```json
{
  "version": 1,
  "defaults": {
    "lead": "lead-local",
    "extract": "extract-grok-cli",
    "coding": "coding-grok-cli",
    "execute": "execute-grok-cli"
  },
  "providers": [
    {
      "id": "lead-local",
      "role": "lead",
      "kind": "local-cli",
      "bin": "builtin:lead",
      "notes": "in-process LeadAgent + leadApplyConfig"
    },
    {
      "id": "extract-grok-cli",
      "role": "extract",
      "kind": "local-cli",
      "bin": "grok",
      "cwdMode": "atom"
    },
    {
      "id": "coding-grok-cli",
      "role": "coding",
      "kind": "local-cli",
      "bin": "grok",
      "cwdMode": "routed"
    },
    {
      "id": "lead-grokbot",
      "role": "lead",
      "kind": "grokbot-webhook",
      "url": "https://YOUR_GROKBOT_WEBHOOK",
      "enabled": false
    }
  ],
  "workspaceOverrides": {
    "yzj": { "coding": "coding-grok-cli" },
    "atom": { "coding": "coding-grok-cli" }
  }
}
```

## Contract (request/response)

所有远程 provider 用同一 envelope，方便换通道：

```ts
type AgentRequest = {
  role: "lead" | "extract" | "coding" | "execute"
  runId: string
  utterance?: string          // lead 自然语言
  messages?: RawMessage[]     // extract seeds
  spec?: SpecDraft            // coding/execute
  route?: RouteDecision       // lead 已路由时带上
  briefing?: string
  workspacePath?: string
  policy?: { confirmOutbound?: boolean }
}

type AgentResponse = {
  ok: boolean
  summary: string
  // role-specific:
  configResult?: LeadConfigResult
  candidates?: CandidateProposal[]
  artifacts?: Array<{ path: string; kind: string }>
  atoms?: Array<{ type: string; detail: unknown }> // optional emissions
}
```

Webhook provider：`POST url` body=`AgentRequest`，期望 JSON `AgentResponse`。  
失败 → 写 `agent_failed` atom，不瞎重试轰炸。

## Freedom knobs

1. **换默认**：改 `defaults.extract` / `defaults.lead`
2. **按仓库覆盖**：`workspaceOverrides.yzj.coding = "coding-cursor-cli"`
3. **双活 Lead**：本地 Lead 做路由，复杂决策可 webhook 到 Grok Bot（`lead` 链）
4. **执行同构**：`execute` 与 `coding` 共用 provider 模型，只是 prompt/工具集不同
5. **UI / `atom lead`**：改 `agents.json` 或自然语言「抽取改用 webhook」

## Safety

- Outbound 发送仍要人确认（policy）
- Provider `enabled: false` 不可被路由选中
- 未知 kind → fail closed
