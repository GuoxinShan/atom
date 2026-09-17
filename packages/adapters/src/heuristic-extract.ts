import type { ExtractAgent, ProposedCandidate, RawMessage, Ref } from "@atom/core";

const SIGNAL =
  /(需要|需求|建议|希望|能不能|可以加上|请实现|请支持|加一个|必须|实现一下|feature|need to|should|bug|缺陷|待办|todo)/i;
const NOISE = /^(好的|收到|ok+|嗯+|哈哈+|谢谢|thx|👍+|yes|no)$/i;

export class HeuristicExtractAgent implements ExtractAgent {
  readonly id = "heuristic";

  async propose(input: { messages: RawMessage[] }): Promise<ProposedCandidate[]> {
    const out: ProposedCandidate[] = [];
    for (const msg of input.messages) {
      const text = msg.text.trim();
      if (text.length < 8 || NOISE.test(text)) continue;
      if (!SIGNAL.test(text)) continue;
      const ref: Ref = {
        token: msg.token,
        kind: "im",
        digest: text.slice(0, 48),
      };
      out.push({
        title: titleFrom(text),
        body: `${msg.author}: ${text}`,
        confidence: confidence(text),
        cluster_key: `msg:${msg.id}`,
        refs: [ref],
      });
    }
    return out;
  }
}

function titleFrom(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 42 ? `${one.slice(0, 42)}…` : one;
}

function confidence(text: string): number {
  let n = 0.55;
  if (/必须|need|blocker/i.test(text)) n += 0.2;
  if (/建议|希望|能不能/i.test(text)) n += 0.1;
  return Math.min(0.92, n);
}
