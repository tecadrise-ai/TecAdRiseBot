import { restoreFlattenedMarkdown } from './markdown';

export const THINK_OPEN = '<!--tec-think-->';
export const THINK_CLOSE = '<!--tec-think-end-->';

export function packAssistantBody(thinking: string, answer: string): string {
  const t = String(thinking || '').trim();
  const a = String(answer || '').trim();
  if (!t) return a;
  if (!a) return `${THINK_OPEN}\n${t}\n${THINK_CLOSE}`;
  return `${THINK_OPEN}\n${t}\n${THINK_CLOSE}\n\n${a}`;
}

function isAnswerStart(block: string): boolean {
  const t = block.trim();
  if (!t) return false;
  if (/^#{1,6}\s/.test(t)) return true;
  if (/^\|/.test(t)) return true;
  const first = t.split('\n')[0]?.trim() || '';
  if (/^\*\*[^*\n]{3,120}\*\*$/.test(first)) return true;
  return false;
}

function splitThinkingHeuristic(raw: string): { thinking: string; answer: string } {
  const s = restoreFlattenedMarkdown(raw);
  if (!s) return { thinking: '', answer: '' };
  const parts = s.split(/\n{2,}/);
  if (parts.length < 2) return { thinking: '', answer: s };
  const idx = parts.findIndex((p, i) => i > 0 && isAnswerStart(p));
  if (idx <= 0) return { thinking: '', answer: s };
  const thinking = parts.slice(0, idx).join('\n\n').trim();
  const answer = parts.slice(idx).join('\n\n').trim();
  if (thinking.length < 40) return { thinking: '', answer: s };
  return { thinking, answer };
}

export function unpackAssistantBody(raw: string): { thinking: string; answer: string } {
  const s = String(raw || '');
  const open = s.indexOf(THINK_OPEN);
  const close = s.indexOf(THINK_CLOSE);
  if (open >= 0 && close > open) {
    return {
      thinking: s.slice(open + THINK_OPEN.length, close).trim(),
      answer: (s.slice(0, open) + s.slice(close + THINK_CLOSE.length)).trim(),
    };
  }
  return splitThinkingHeuristic(s);
}
