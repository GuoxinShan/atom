/**
 * Shared noise detector for the heuristic seed gate, extract post-filter,
 * and `pnpm atom reject-noise`. Keep patterns conservative: fixture demand
 * lines (need / 希望 / 必须 / Please add) must still pass.
 */

const ACK: RegExp[] = [
  /^收到[✅✔√\s!！。．.]*$/,
  /^收到✅/,
  /收到✅/,
  /^(好的|嗯+|ok+|okay|收到了|已收到|明白|了解)[！!。.\s✅✔]*$/i,
  /^\+1$/,
];

const BOT_DIGEST: RegExp[] = [
  /已记入本周台账/,
  /^【来自Grok Bot自动发送】/,
  /^【来自ZCode自动发送】/,
  /【来自.+自动发送】/,
  /^【AI产出·/,
  /^【W\d+\s/,
  /Grok Bot自动发送/,
  /ZCode自动发送/,
];

const CHATTER: RegExp[] = [/午饭|天气|牛肉面/];

const LOG_LINE: RegExp[] = [
  /^\[\d{4}-\d{2}-\d{2}[^\n]*\]\s*\[/,
  /http-nio-|com\.kingdee/,
  /^\s*at\s+[\w.$]+\([\w./:-]+:\d+\)/,
  /^\s*\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[^\n]*(INFO|WARN|ERROR|DEBUG|TRACE)\b/,
];

const OTHER: RegExp[] = [/^那是公共逻辑/, /不需要改啥/];

/** Message-level patterns (heuristic gate). */
export const NOISE_PATTERNS: RegExp[] = [...ACK, ...BOT_DIGEST, ...CHATTER, ...LOG_LINE, ...OTHER];

const MIN_PROPOSAL_TITLE = 6;

function lineLooksLikeLog(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  return LOG_LINE.some((p) => p.test(t));
}

function isPureLogDump(text: string): boolean {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  if (lines.length === 1) return lineLooksLikeLog(lines[0]!);
  const logish = lines.filter(lineLooksLikeLog).length;
  return logish >= 3 || logish / lines.length >= 0.6;
}

function isShortAck(text: string): boolean {
  const t = text.trim();
  if (t.length <= 24 && /^收到/.test(t)) return true;
  return ACK.some((p) => p.test(t));
}

/** Truncated / unfinished titles (Grok sometimes cuts mid-parenthetical). */
export function isTruncatedTitle(title: string): boolean {
  const t = title.trim();
  if (!t) return true;
  if (t.length < MIN_PROPOSAL_TITLE) return true;
  // only a date fragment, e.g. `[2026-` or `[2026-09-17]`
  if (/^\[\d{4}-?\d{0,2}-?\d{0,2}\s*\]?\s*$/.test(t)) return true;
  if (/^\[\d{4}-\s*$/.test(t)) return true;
  // bare `（dev` / `(dev` with nothing after
  if (/[（(]\s*dev\s*$/i.test(t)) return true;
  if (/[（(]\s*$/.test(t)) return true;
  return false;
}

/** True when a message or proposal field is bot-digest / ack / log junk. */
export function isNoiseText(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return true;
  if (isShortAck(t)) return true;
  if (NOISE_PATTERNS.some((p) => p.test(t))) return true;
  if (isPureLogDump(t)) return true;
  return false;
}

/**
 * Post-filter for extract proposals (title + body).
 * Also used by `reject-noise` on the suggested queue.
 */
export function isNoiseProposal(title: string, body = ""): boolean {
  const t = (title ?? "").trim();
  if (t.length < MIN_PROPOSAL_TITLE) return true;
  if (isTruncatedTitle(t)) return true;
  if (isNoiseText(t)) return true;
  const b = (body ?? "").trim();
  if (b && isNoiseText(b)) return true;
  return false;
}

export const NOISE_REJECT_REASON = "noise-heuristic";
/** Laya extract-gate reason when high-confidence chat/noise is dropped. */
export const LAYA_NOISE_REJECT_REASON = "noise-laya";
