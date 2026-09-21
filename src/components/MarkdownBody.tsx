import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { memo } from 'react';
import { restoreFlattenedMarkdown } from '../lib/markdown';

marked.setOptions({ gfm: true, breaks: true });

export const MarkdownBody = memo(function MarkdownBody({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const clean = restoreFlattenedMarkdown(text).replace(/\n{3,}/g, '\n\n');
  const html = DOMPurify.sanitize(String(marked.parse(clean)), {
    ADD_TAGS: ['img'],
    ADD_ATTR: ['src', 'alt', 'title'],
    ALLOWED_URI_REGEXP:
      /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  })
    .replace(/<h[1-6](\s[^>]*)?>/gi, '<p class="md-heading">')
    .replace(/<\/h[1-6]>/gi, '</p>');
  return (
    <div
      className={['md-body', className].filter(Boolean).join(' ')}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const a = (e.target as HTMLElement | null)?.closest?.('a');
        if (!a) return;
        const href = a.getAttribute('href') || '';
        if (!/^https?:/i.test(href) && !/^mailto:/i.test(href)) return;
        e.preventDefault();
        void window.tecapi.app.openExternal(href);
      }}
    />
  );
});
