import { app, net, protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Chat images live as files under userData and are shown through this scheme.
 * Inline base64 in messages made every debounced save rewrite a huge sql.js file.
 */
export const CHAT_IMAGE_SCHEME = 'tecimg';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const MAX_PROXY_BYTES = 12 * 1024 * 1024;

/** Must run before app ready. */
export function registerChatImageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: CHAT_IMAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

function userDataReal(): string {
  return fs.realpathSync(app.getPath('userData'));
}

/** Serves image files inside userData, and proxies http(s) photos the model pasted. */
export function handleChatImages(): void {
  protocol.handle(CHAT_IMAGE_SCHEME, async (req) => {
    try {
      const u = new URL(req.url);
      if (u.hostname === 'h') return await proxyRemoteImage(u.searchParams.get('u') || '');
      const rel = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (!rel.length || rel.some((p) => p === '..' || p.includes('\\') || p.includes(':'))) {
        return new Response('Bad path', { status: 400 });
      }
      const root = userDataReal();
      const real = fs.realpathSync(path.join(app.getPath('userData'), ...rel));
      if (!real.startsWith(root + path.sep) || !IMAGE_EXT.test(real)) return new Response('Forbidden', { status: 403 });
      return await net.fetch(pathToFileURL(real).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

async function proxyRemoteImage(raw: string): Promise<Response> {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return new Response('Bad url', { status: 400 });
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return new Response('Forbidden', { status: 403 });
  }
  const res = await net.fetch(target.toString(), {
    bypassCustomProtocolHandlers: true,
    headers: {
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      Referer: `${target.origin}/`,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
  });
  let final: URL;
  try {
    final = new URL(res.url || target.toString());
  } catch {
    return new Response('Bad redirect', { status: 400 });
  }
  if (final.protocol !== 'http:' && final.protocol !== 'https:') {
    return new Response('Forbidden', { status: 403 });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_PROXY_BYTES) return new Response('Too large', { status: 413 });
  const headerType = res.headers.get('content-type') || '';
  const sniff = sniffImage(buf);
  if (!sniff && !/^image\//i.test(headerType)) return new Response('Not an image', { status: 415 });
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': sniff || headerType.split(';')[0],
      'Cache-Control': 'private, max-age=86400',
    },
  });
}

function sniffImage(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return null;
}

/** URL for a file under userData, or null when it lives elsewhere. */
export function chatImageUrl(absPath: string): string | null {
  const rel = path.relative(app.getPath('userData'), absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return `${CHAT_IMAGE_SCHEME}://u/${rel.split(path.sep).map(encodeURIComponent).join('/')}`;
}

function extFor(mimeType: string): string {
  if (mimeType.includes('jpeg')) return 'jpg';
  const ext = (mimeType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
  return ext === 'svgxml' ? 'svg' : ext || 'png';
}

/** Writes base64 image data into dir and returns its path and chat URL (null URL means keep inline). */
export function saveChatImage(
  dir: string,
  baseName: string,
  mimeType: string,
  dataBase64: string
): { filePath: string; url: string | null } {
  fs.mkdirSync(dir, { recursive: true });
  const safe = baseName.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/\.[a-z0-9]+$/i, '').slice(0, 80) || 'image';
  const filePath = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}.${extFor(mimeType)}`);
  fs.writeFileSync(filePath, Buffer.from(dataBase64, 'base64'));
  return { filePath, url: chatImageUrl(filePath) };
}
