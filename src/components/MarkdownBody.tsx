import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { memo } from 'react';
import { restoreFlattenedMarkdown } from '../lib/markdown';
import { rewriteMarkdownImages } from '../lib/rewriteChatImages';

marked.setOptions({ gfm: true, breaks: true });

export const MarkdownBody = memo(function MarkdownBody({
  text,
  className,
  agentId,
  userDataPath,
}: {
  text: string;
  className?: string;
  agentId?: string;
  userDataPath?: string;
}) {
  const clean = restoreFlattenedMarkdown(text).replace(/\n{3,}/g, '\n\n');
  const withImgs = rewriteMarkdownImages(clean, { agentId, userDataPath });
  const html = DOMPurify.sanitize(String(marked.parse(withImgs)), {
    ADD_TAGS: ['img'],
    ADD_ATTR: ['src', 'alt', 'title'],
    ALLOWED_URI_REGEXP:
      /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|data|tecimg):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  })
    .replace(/<h[1-6](\s[^>]*)?>/gi, '<p class="md-heading">')
    .replace(/<\/h[1-6]>/gi, '</p>');
  return (
    <div
      className={['md-body', className].filter(Boolean).join(' ')}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const t = e.target as HTMLElement | null;
        if (t instanceof HTMLImageElement) {
          e.preventDefault();
          e.stopPropagation();
          t.classList.toggle('zoomed');
          return;
        }
        const a = t?.closest?.('a');
        if (!a) return;
        const href = a.getAttribute('href') || '';
        if (href.startsWith('#')) return;
        // Relative or file links would navigate the whole app window away.
        e.preventDefault();
        if (/^https?:/i.test(href) || /^mailto:/i.test(href)) void window.tecapi.app.openExternal(href);
      }}
    />
  );
});
