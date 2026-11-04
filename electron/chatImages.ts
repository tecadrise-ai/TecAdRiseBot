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

/** Must run before app ready. */
export function registerChatImageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: CHAT_IMAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

function userDataReal(): string {
  return fs.realpathSync(app.getPath('userData'));
}

/** Serves image files inside userData only. */
export function handleChatImages(): void {
  protocol.handle(CHAT_IMAGE_SCHEME, async (req) => {
    try {
      const rel = new URL(req.url).pathname.split('/').filter(Boolean).map(decodeURIComponent);
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
