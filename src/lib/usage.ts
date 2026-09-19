export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  turns: number;
  reasoningTokens?: number;
};

export function addUsage(sum: TokenUsage | null, part: unknown): TokenUsage {
  const p = part && typeof part === 'object' ? (part as Record<string, unknown>) : {};
  const next: TokenUsage = sum || {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    turns: 0,
  };
  next.inputTokens += Number(p.inputTokens) || 0;
  next.outputTokens += Number(p.outputTokens) || 0;
  next.cacheReadTokens += Number(p.cacheReadTokens) || 0;
  next.cacheWriteTokens += Number(p.cacheWriteTokens) || 0;
  const r = Number(p.reasoningTokens);
  if (Number.isFinite(r) && r > 0) next.reasoningTokens = (next.reasoningTokens || 0) + r;
  next.turns += 1;
  next.totalTokens =
    next.inputTokens + next.outputTokens + next.cacheReadTokens + next.cacheWriteTokens;
  return next;
}

export function fmtTok(n: number): string {
  const v = Number(n) || 0;
  if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 10000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(v));
}

export function fmtUsage(u: TokenUsage | null | undefined): string {
  if (!u || typeof u !== 'object') return '';
  const bits = [`${fmtTok(u.inputTokens)} in`, `${fmtTok(u.outputTokens)} out`, `${fmtTok(u.totalTokens)} tot`];
  if (u.cacheReadTokens) bits.push(`${fmtTok(u.cacheReadTokens)} cache`);
  if (u.turns > 1) bits.push(`${u.turns} LLM`);
  return bits.join(' / ');
}

export function fmtTs(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function parseMessageUsage(meta: string | null): TokenUsage | null {
  if (!meta) return null;
  try {
    const o = JSON.parse(meta) as { usage?: TokenUsage };
    return o && o.usage && typeof o.usage === 'object' ? o.usage : null;
  } catch {
    return null;
  }
}
