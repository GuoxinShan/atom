import { RawMessage } from "../schema/types.js";

const DEMAND_SEED: RegExp[] = [
  /希望|需要|能不能|可以加|必须|应该|需求|请帮|帮忙|要不要|是否需要|待办|修一下|支持|接入|配置|发布|落地|合入|联调|排障|缺了|不通|失败|缺陷/i,
  /\b(need|please|should|must|add|ship|want|require|fix|support|feature|bug)\b/i,
  /@\S+.{0,40}(帮|看|改|查|支持)/,
];

const NOISE: RegExp[] = [
  /^收到✅/,
  /已记入本周台账/,
  /午饭|天气|牛肉面/,
  /^\[\d{4}-\d{2}-\d{2}.*\]\s*\[/,
  /http-nio-|com\.kingdee/,
  /^那是公共逻辑/,
  /不需要改啥/,
  /^【来自Grok Bot自动发送】/,
  /^【来自ZCode自动发送】/,
  /^【AI产出·/,
  /^【W\d+ /,
];

/**
 * Heuristic only shortlists messages as *candidate seeds* for the agentic extractor.
 * It must not emit candidate_proposed atoms by itself.
 */
export class HeuristicCandidateGate {
  readonly id = "heuristic-gate";

  filter(messages: RawMessage[]): RawMessage[] {
    return messages.filter((m) => {
      const text = (m.text ?? "").trim();
      if (!text || text.length < 8) return false;
      if (NOISE.some((p) => p.test(text))) return false;
      return DEMAND_SEED.some((p) => p.test(text));
    });
  }
}
