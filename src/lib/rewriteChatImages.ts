/** Turn markdown image srcs into tecimg URLs the renderer can load. */

export type ChatImageRewriteOpts = {
  agentId?: string;
  userDataPath?: string;
};

export function rewriteChatImageSrc(src: string, opts: ChatImageRewriteOpts = {}): string {
  const raw = unwrapSrc(src);
  if (!raw) return src;
  if (/^(data:|tecimg:|blob:)/i.test(raw)) return raw;
  if (/^https?:\/\//i.test(raw)) return `tecimg://h/?u=${encodeURIComponent(raw)}`;

  const local = fromFileUrl(raw);
  const userData = opts.userDataPath ? slash(opts.userDataPath) : '';
  if (userData && isAbsPath(local)) {
    const rel = relIfInside(userData, local);
    if (rel) return toTecimgFile(rel);
  }
  if (!isAbsPath(local) && opts.agentId && !hasDotDot(local)) {
    const rel = ['w', opts.agentId, ...slash(local).split('/').filter((p) => p && p !== '.')].join('/');
    if (hasDotDot(rel)) return src;
    return toTecimgFile(rel);
  }
  return src;
}

export function rewriteMarkdownImages(text: string, opts: ChatImageRewriteOpts = {}): string {
  const src = String(text || '');
  const re = /```[\s\S]*?```|`[^`]+`/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out += rewriteSegment(src.slice(last, m.index), opts);
    out += m[0];
    last = m.index + m[0].length;
  }
  return out + rewriteSegment(src.slice(last), opts);
}

function rewriteSegment(s: string, opts: ChatImageRewriteOpts): string {
  s = s.replace(/!\[([^\]]*)\]\(\s*(<)?([^)\s>]+)(>)?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g, (_all, alt, _lt, url) => {
    return `![${alt}](${rewriteChatImageSrc(String(url), opts)})`;
  });
  s = s.replace(/<img\b([^>]*?)\bsrc=(["'])([^"']+)\2/gi, (_all, pre, q, url) => {
    return `<img${pre}src=${q}${rewriteChatImageSrc(String(url), opts)}${q}`;
  });
  return s;
}

function unwrapSrc(src: string): string {
  let s = String(src || '').trim();
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();
  s = s.replace(/\s+["'][\s\S]*$/, '').trim();
  try {
    s = decodeURI(s);
  } catch {
    /* keep */
  }
  return s;
}

function fromFileUrl(s: string): string {
  if (!/^file:/i.test(s)) return s;
  try {
    const u = new URL(s);
    let p = decodeURIComponent(u.pathname);
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
    return p;
  } catch {
    return s.replace(/^file:\/\//i, '');
  }
}

function slash(p: string): string {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

function isAbsPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/');
}

function hasDotDot(p: string): boolean {
  return slash(p)
    .split('/')
    .some((part) => part === '..');
}

function relIfInside(root: string, abs: string): string | null {
  const r = slash(root);
  const a = slash(abs);
  if (a.toLowerCase() === r.toLowerCase()) return '';
  const prefix = r.toLowerCase() + '/';
  if (!a.toLowerCase().startsWith(prefix)) return null;
  return a.slice(r.length + 1);
}

function toTecimgFile(rel: string): string {
  const parts = slash(rel)
    .split('/')
    .filter(Boolean)
    .map((p) => encodeURIComponent(p));
  return `tecimg://u/${parts.join('/')}`;
}
