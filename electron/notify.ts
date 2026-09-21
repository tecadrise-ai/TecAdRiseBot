import { Notification, type BrowserWindow, app, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unpackAssistantBody } from '../src/lib/assistantBody';
import { readToastEnabled } from '../src/lib/modelOptions';

export const APP_USER_MODEL_ID = 'com.tecadrise.bot';
export const APP_DISPLAY_NAME = 'TecAdRiseBot';
export { readToastEnabled };

function appRoot(): string {
  return process.env.APP_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function findResource(names: string[][]): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const extra = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  const roots = [appRoot(), here, path.join(here, '..'), process.cwd(), extra].filter(Boolean);
  for (const root of roots) {
    for (const parts of names) {
      const p = path.join(root, ...parts);
      if (fs.existsSync(p)) return p;
    }
  }
  return '';
}

export function appIconPath(): string {
  return findResource([
    ['resources', 'tecadrisebot-v2.ico'],
    ['resources', 'icon.png'],
    ['tecadrisebot-v2.ico'],
  ]);
}

/** Windows shows the AUMID string unless a Start Menu shortcut owns that AUMID. */
export function ensureWindowsToastIdentity(): void {
  if (process.platform !== 'win32') return;
  app.setName(APP_DISPLAY_NAME);
  app.setAppUserModelId(APP_USER_MODEL_ID);
  const programs = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  fs.mkdirSync(programs, { recursive: true });
  const shortcut = path.join(programs, `${APP_DISPLAY_NAME}.lnk`);
  const icon = appIconPath();
  const details: Electron.ShortcutDetails = {
    target: process.execPath,
    cwd: path.dirname(process.execPath),
    args: app.isPackaged ? '' : `"${appRoot()}"`,
    description: APP_DISPLAY_NAME,
    appUserModelId: APP_USER_MODEL_ID,
    icon: icon || process.execPath,
    iconIndex: 0,
  };
  try {
    if (fs.existsSync(shortcut)) fs.unlinkSync(shortcut);
    shell.writeShortcutLink(shortcut, 'create', details);
  } catch (e) {
    console.warn('toast shortcut failed', e);
  }
}

function snippet(raw: string): string {
  const { answer, thinking } = unpackAssistantBody(raw);
  let s = (answer || thinking || '')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > 180) s = s.slice(0, 177) + '...';
  return s || 'Open TecAdRiseBot to view the reply.';
}

export function maybeNotifyChatDone(opts: {
  source?: string;
  toastEnabled: boolean;
  agentName: string;
  content: string;
  win: BrowserWindow | null;
}): void {
  if (opts.source && opts.source !== 'user') return;
  if (!opts.toastEnabled) return;
  if (opts.win?.isFocused()) return;
  const text = String(opts.content || '').trim();
  if (!text || text === 'Stopped.') return;
  if (!Notification.isSupported()) return;
  try {
    if (process.platform === 'win32') {
      app.setAppUserModelId(APP_USER_MODEL_ID);
      ensureWindowsToastIdentity();
    }
    const n = new Notification({
      title: `Done • ${opts.agentName}`,
      body: snippet(text),
      timeoutType: 'default',
    });
    n.on('click', () => {
      if (!opts.win) return;
      if (opts.win.isMinimized()) opts.win.restore();
      opts.win.show();
      opts.win.focus();
    });
    n.show();
    setTimeout(() => {
      try {
        n.close();
      } catch {
        /* already dismissed */
      }
    }, 4000);
  } catch (e) {
    console.warn('toast failed', e);
  }
}
