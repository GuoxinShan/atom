import fs from "node:fs";
import path from "node:path";
import { AgentProviderRegistry } from "../registry/agents.js";

export interface LeadConfigResult {
  ok: boolean;
  message: string;
  changed?: string[];
}

type SourcesFile = {
  sources: Array<{
    id: string;
    kind: string;
    enabled?: boolean;
    groupIds?: string[];
    groupNames?: Record<string, string>;
    path?: string;
    cli?: string;
    limit?: number;
  }>;
  defaultSourceId?: string;
  defaultExtractAgent?: string;
  extract?: Record<string, unknown>;
};

type SubsFile = {
  subscriptions: Array<{
    id: string;
    url: string;
    enabled?: boolean;
    types?: string[];
  }>;
};

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

function writeJson(p: string, data: unknown) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/**
 * Natural-language-ish config intents for the Lead agent.
 * Examples:
 * - 打开 AI推进 群 / enable yzj-ai-advance
 * - 只要 Agentic Working
 * - 订阅加 https://example.com/hook
 * - 关掉出站订阅 xxx
 */
export function leadApplyConfig(repoRoot: string, utterance: string): LeadConfigResult {
  const text = utterance.trim();
  const lower = text.toLowerCase();
  const sourcesPath = path.join(repoRoot, "data", "sources.json");
  const subsPath = path.join(repoRoot, "data", "subscriptions.json");
  const changed: string[] = [];

  if (!fs.existsSync(sourcesPath)) {
    return { ok: false, message: "data/sources.json missing — run cold-start first" };
  }

  const sources = readJson<SourcesFile>(sourcesPath);

  // enable AI推进
  if (/ai推进|yzj-ai-advance|打开.*推进|启用.*推进/.test(text) || /enable.*ai-advance/.test(lower)) {
    const s = sources.sources.find((x) => x.id === "yzj-ai-advance");
    if (!s) return { ok: false, message: "source yzj-ai-advance not found" };
    s.enabled = true;
    // also merge groups into primary yzj allowlist for convenience
    const primary = sources.sources.find((x) => x.id === "yzj");
    if (primary && s.groupIds?.length) {
      primary.groupIds = Array.from(new Set([...(primary.groupIds ?? []), ...s.groupIds]));
      primary.groupNames = { ...(primary.groupNames ?? {}), ...(s.groupNames ?? {}) };
    }
    writeJson(sourcesPath, sources);
    changed.push("sources.json");
    return { ok: true, message: "已启用【AI推进】订阅（并入 yzj groupIds）", changed };
  }

  // only Agentic Working
  if (/只要.*agentic|仅.*验证群|关掉.*推进|只要.*工作验证|only.*agentic/.test(text + lower)) {
    const primary = sources.sources.find((x) => x.id === "yzj");
    const adv = sources.sources.find((x) => x.id === "yzj-ai-advance");
    if (primary) {
      primary.groupIds = ["6a98ef36e4b073377732ef7b"];
      primary.groupNames = {
        "6a98ef36e4b073377732ef7b": "灵基Chat · Agentic Working 验证",
      };
      primary.enabled = true;
    }
    if (adv) adv.enabled = false;
    sources.defaultSourceId = "yzj";
    writeJson(sourcesPath, sources);
    changed.push("sources.json");
    return { ok: true, message: "已限定只订阅 Agentic Working 验证群", changed };
  }

  // set default extract agent
  if (/用grok抽|agentic抽|抽取.*grok|extract.*grok/.test(text + lower)) {
    sources.defaultExtractAgent = "grok-cli";
    writeJson(sourcesPath, sources);
    changed.push("sources.json");
    return { ok: true, message: "默认抽取已设为 grok-cli（启发式仅做种子门）", changed };
  }

  // add outbound webhook
  const urlMatch = text.match(/https?:\/\/\S+/);
  if ((/订阅|webhook|出站/.test(text) || /subscribe/.test(lower)) && urlMatch) {
    const subs = fs.existsSync(subsPath)
      ? readJson<SubsFile>(subsPath)
      : { subscriptions: [] };
    const id = `sub_${Date.now().toString(36)}`;
    subs.subscriptions.push({ id, url: urlMatch[0].replace(/[，。]$/, ""), enabled: true });
    writeJson(subsPath, subs);
    changed.push("subscriptions.json");
    return { ok: true, message: `已添加出站订阅 ${id} → ${urlMatch[0]}`, changed };
  }

  // agent provider switches
  if (/抽取.*(webhook|grokbot)|extract.*(webhook|grokbot)/.test(text + lower)) {
    const reg = new AgentProviderRegistry(repoRoot);
    const id = /grokbot/.test(lower) ? "lead-grokbot-webhook" : "extract-webhook";
    // for extract specifically:
    const extractId = /抽取/.test(text) || /extract/.test(lower)
      ? (/grokbot/.test(lower) ? "extract-webhook" : "extract-webhook")
      : id;
    try {
      if (/抽取|extract/.test(text + lower)) {
        // enable extract-webhook if url already set; else instruct
        const cfgA = reg.load();
        const p = cfgA.providers.find((x) => x.id === "extract-webhook");
        if (!p?.url) {
          return { ok: false, message: "先在 data/agents.json 给 extract-webhook 填 url，或说：配置抽取webhook https://..." };
        }
        p.enabled = true;
        cfgA.defaults.extract = "extract-webhook";
        reg.save(cfgA);
        return { ok: true, message: "抽取已切到 extract-webhook", changed: ["agents.json"] };
      }
    } catch (e) {
      return { ok: false, message: String(e) };
    }
  }

  if (/抽取.*本地grok|extract.*grok-cli|用本地grok抽/.test(text + lower)) {
    const reg = new AgentProviderRegistry(repoRoot);
    reg.setDefault("extract", "extract-grok-cli");
    return { ok: true, message: "抽取已切回本地 extract-grok-cli", changed: ["agents.json"] };
  }

  if (/主agent.*webhook|lead.*webhook|lead.*grokbot|主调度.*webhook|主调度.*grokbot/.test(text + lower)) {
    const reg = new AgentProviderRegistry(repoRoot);
    const cfgA = reg.load();
    const p = cfgA.providers.find((x) => x.id === "lead-grokbot-webhook");
    const urlMatch = text.match(/https?:\/\/\S+/);
    if (urlMatch && p) {
      p.url = urlMatch[0].replace(/[，。]$/, "");
      p.enabled = true;
      cfgA.defaults.lead = "lead-grokbot-webhook";
      reg.save(cfgA);
      return { ok: true, message: `主 Agent 已切到 Grok Bot webhook：${p.url}`, changed: ["agents.json"] };
    }
    if (p && !p.url) {
      return { ok: false, message: "请带上 webhook URL：主agent用webhook https://..." };
    }
    if (p) {
      p.enabled = true;
      cfgA.defaults.lead = "lead-grokbot-webhook";
      reg.save(cfgA);
      return { ok: true, message: "主 Agent 已切到 lead-grokbot-webhook（沿用已有 url）", changed: ["agents.json"] };
    }
  }

  if (/主agent.*本地|lead.*local|主调度.*本地/.test(text + lower)) {
    const reg = new AgentProviderRegistry(repoRoot);
    reg.setDefault("lead", "lead-local");
    return { ok: true, message: "主 Agent 已切回 lead-local", changed: ["agents.json"] };
  }

  const agentUrl = text.match(/配置(抽取|coding|执行|主agent|lead)?\s*(webhook)?\s*(https?:\/\/\S+)/i);
  if (agentUrl) {
    const reg = new AgentProviderRegistry(repoRoot);
    const cfgA = reg.load();
    const url = agentUrl[3].replace(/[，。]$/, "");
    const which = (agentUrl[1] || "抽取").toLowerCase();
    let id = "extract-webhook";
    let role: "extract" | "coding" | "execute" | "lead" = "extract";
    if (/coding|代码/.test(which)) { id = "coding-webhook"; role = "coding"; }
    else if (/执行|execute/.test(which)) { id = "execute-webhook"; role = "execute"; }
    else if (/主|lead/.test(which)) { id = "lead-grokbot-webhook"; role = "lead"; }
    const p = cfgA.providers.find((x) => x.id === id);
    if (!p) return { ok: false, message: `missing provider ${id}` };
    p.url = url;
    p.enabled = true;
    cfgA.defaults[role] = id;
    reg.save(cfgA);
    return { ok: true, message: `${role} 已指向 ${id} → ${url}`, changed: ["agents.json"] };
  }

  if (/有哪些agent|列出agent|list agents|agent提供者/.test(text + lower)) {
    const reg = new AgentProviderRegistry(repoRoot);
    const cfgA = reg.load();
    const lines = cfgA.providers.map((p) => {
      const mark = cfgA.defaults[p.role] === p.id ? "*" : " ";
      return `${mark} ${p.id} role=${p.role} kind=${p.kind} enabled=${p.enabled !== false} url=${p.url || "-"}`;
    });
    return {
      ok: true,
      message: `defaults=${JSON.stringify(cfgA.defaults)}\n` + lines.join("\n"),
    };
  }

    // list help
  if (/有哪些源|列出源|list sources|订阅源/.test(text + lower)) {
    const lines = sources.sources.map((s) => {
      const g = (s.groupIds ?? []).join(",") || "-";
      return `- ${s.id} kind=${s.kind} enabled=${s.enabled !== false} groups=${g}`;
    });
    return { ok: true, message: "当前源：\n" + lines.join("\n") };
  }


  if (/订阅.*cli|cli订阅|出站.*cli/.test(text + lower)) {
    const binMatch = text.match(/cli\s+(\S+)/i) || text.match(/用\s*(\S+)\s*接/);
    const bin = binMatch ? binMatch[1] : "echo";
    const subsPath = path.join(repoRoot, "data", "subscriptions.json");
    const subs = fs.existsSync(subsPath)
      ? JSON.parse(fs.readFileSync(subsPath, "utf8"))
      : { subscriptions: [] };
    const id = `cli_${Date.now().toString(36)}`;
    subs.subscriptions = subs.subscriptions || [];
    subs.subscriptions.push({ id, kind: "cli", enabled: true, bin, args: [], types: ["*"] });
    fs.writeFileSync(subsPath, JSON.stringify(subs, null, 2) + "\n");
    return { ok: true, message: `已添加 CLI 订阅 ${id} bin=${bin}`, changed: ["subscriptions.json"] };
  }

  if (/订阅.*文件|file订阅|jsonl/.test(text + lower)) {
    const subsPath = path.join(repoRoot, "data", "subscriptions.json");
    const subs = fs.existsSync(subsPath)
      ? JSON.parse(fs.readFileSync(subsPath, "utf8"))
      : { subscriptions: [] };
    const id = `file_${Date.now().toString(36)}`;
    subs.subscriptions = subs.subscriptions || [];
    subs.subscriptions.push({
      id,
      kind: "file",
      enabled: true,
      path: "out/subscriptions/events.jsonl",
      types: ["*"],
    });
    fs.writeFileSync(subsPath, JSON.stringify(subs, null, 2) + "\n");
    return { ok: true, message: `已添加文件订阅 ${id} → out/subscriptions/events.jsonl`, changed: ["subscriptions.json"] };
  }

    return {
    ok: false,
    message:
      "没听懂配置意图。可以试：\n" +
      "- 打开 AI推进 群\n" +
      "- 只要 Agentic Working\n" +
      "- 用 grok 抽\n" +
      "- 订阅加 https://example.com/hook\n" +
      "- 订阅cli notify\n" +
      "- 订阅文件 jsonl\n" +
      "- 有哪些源",
  };
}
