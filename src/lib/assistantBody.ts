import { restoreFlattenedMarkdown } from './markdown.ts';

export const THINK_OPEN = '<!--tec-think-->';
export const THINK_CLOSE = '<!--tec-think-end-->';

/** Pack SDK thinking and visible answer. No phrase matching. */
export function packAssistantBody(thinking: string, answer: string): string {
  const t = thinking.trim();
  const a = answer.trim();
  if (!t) return a;
  if (!a) return `${THINK_OPEN}\n${t}\n${THINK_CLOSE}`;
  return `${THINK_OPEN}\n${t}\n${THINK_CLOSE}\n\n${a}`;
}

export function finalizeAssistantBody(thinking: string, answer: string): string {
  return packAssistantBody(thinking, restoreFlattenedMarkdown(answer));
}

/** Split only on host markers. Unmarked text is the answer. */
export function unpackAssistantBody(raw: string): { thinking: string; answer: string } {
  const s = String(raw || '');
  const open = s.indexOf(THINK_OPEN);
  const close = s.indexOf(THINK_CLOSE);
  if (open >= 0 && close > open) {
    return {
      thinking: s.slice(open + THINK_OPEN.length, close).trim(),
      answer: restoreFlattenedMarkdown(
        (s.slice(0, open) + s.slice(close + THINK_CLOSE.length)).trim()
      ),
    };
  }
  return { thinking: '', answer: restoreFlattenedMarkdown(s) };
}
