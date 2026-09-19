import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { restoreFlattenedMarkdown } from '../lib/markdown';

marked.setOptions({ gfm: true, breaks: true });

export function MarkdownBody({ text }: { text: string }) {
  const clean = restoreFlattenedMarkdown(text).replace(/\n{3,}/g, '\n\n');
  const html = DOMPurify.sanitize(String(marked.parse(clean)))
    .replace(/<h[1-6](\s[^>]*)?>/gi, '<p class="md-heading">')
    .replace(/<\/h[1-6]>/gi, '</p>');
  return <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />;
}
