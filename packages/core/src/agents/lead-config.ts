import fs from "node:fs";
import path from "node:path";

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

  // list help
  if (/有哪些源|列出源|list sources|订阅源/.test(text + lower)) {
    const lines = sources.sources.map((s) => {
      const g = (s.groupIds ?? []).join(",") || "-";
      return `- ${s.id} kind=${s.kind} enabled=${s.enabled !== false} groups=${g}`;
    });
    return { ok: true, message: "当前源：\n" + lines.join("\n") };
  }

  return {
    ok: false,
    message:
      "没听懂配置意图。可以试：\n" +
      "- 打开 AI推进 群\n" +
      "- 只要 Agentic Working\n" +
      "- 用 grok 抽\n" +
      "- 订阅加 https://example.com/hook\n" +
      "- 有哪些源",
  };
}
