import { restoreFlattenedMarkdown } from './markdown';

export const THINK_OPEN = '<!--tec-think-->';
export const THINK_CLOSE = '<!--tec-think-end-->';

export function packAssistantBody(thinking: string, answer: string): string {
  const split = peelThinkingFromAnswer(thinking, answer);
  const t = split.thinking.trim();
  const a = split.answer.trim();
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

function isDirectAnswerPara(block: string): boolean {
  const t = block.trim();
  if (!t) return false;
  if (isAnswerStart(t)) return true;
  return /^(mostly|yes\b|yeah\b|yep\b|no\b|nope\b|not\b|it is\b|it's\b|this (is|one|post|thread|link|url)\b|here(?:'|’)s\b|short answer\b|bottom line\b|tl;dr\b)/i.test(
    t
  );
}

function isPlanPara(block: string): boolean {
  const t = block.trim();
  if (!t) return false;
  if (isDirectAnswerPara(t)) return false;
  return /^(i'll |i will |i am |i'm |let me |let's |first[, ]|now i |checking |reading |fetching |opening |saving |updating |looking |i need |i should |taking |the user |same author |title only |only two |the image |the canvas |locating |preparing |prompts \d)/i.test(
    t
  );
}

function splitSentences(s: string): string[] {
  const out: string[] = [];
  const re = /[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const part = m[0].replace(/\s+/g, ' ').trim();
    if (part) out.push(part);
  }
  return out.length ? out : [s.trim()].filter(Boolean);
}

function peelThinkingFromAnswer(thinking: string, answer: string): { thinking: string; answer: string } {
  let t = restoreFlattenedMarkdown(thinking);
  let a = restoreFlattenedMarkdown(answer);
  if (!a) return { thinking: t, answer: '' };

  const paras = a.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  let aidx = paras.findIndex((p) => isDirectAnswerPara(p));
  if (aidx < 0 && paras.length === 1) {
    const sentences = splitSentences(paras[0]);
    aidx = sentences.findIndex((s) => isDirectAnswerPara(s));
    if (aidx > 0) {
      t = [t, sentences.slice(0, aidx).join(' ')].filter(Boolean).join('\n\n');
      a = sentences.slice(aidx).join(' ');
      return { thinking: t.trim(), answer: a.trim() };
    }
  }
  if (aidx > 0) {
    t = [t, ...paras.slice(0, aidx)].filter(Boolean).join('\n\n');
    a = paras.slice(aidx).join('\n\n');
    return { thinking: t.trim(), answer: a.trim() };
  }
  if (t && paras.length && paras.every((p) => isPlanPara(p))) {
    return { thinking: [t, a].filter(Boolean).join('\n\n').trim(), answer: '' };
  }
  return { thinking: t, answer: a };
}

function splitThinkingHeuristic(raw: string): { thinking: string; answer: string } {
  const s = restoreFlattenedMarkdown(raw);
  if (!s) return { thinking: '', answer: '' };
  const parts = s.split(/\n{2,}/);
  if (parts.length < 2) return peelThinkingFromAnswer('', s);
  const idx = parts.findIndex((p, i) => i > 0 && isAnswerStart(p));
  if (idx <= 0) return peelThinkingFromAnswer('', s);
  const thinking = parts.slice(0, idx).join('\n\n').trim();
  const answer = parts.slice(idx).join('\n\n').trim();
  if (thinking.length < 40) return peelThinkingFromAnswer('', s);
  return peelThinkingFromAnswer(thinking, answer);
}

export function unpackAssistantBody(raw: string): { thinking: string; answer: string } {
  const s = String(raw || '');
  const open = s.indexOf(THINK_OPEN);
  const close = s.indexOf(THINK_CLOSE);
  if (open >= 0 && close > open) {
    return peelThinkingFromAnswer(
      s.slice(open + THINK_OPEN.length, close),
      s.slice(0, open) + s.slice(close + THINK_CLOSE.length)
    );
  }
  return splitThinkingHeuristic(s);
}
