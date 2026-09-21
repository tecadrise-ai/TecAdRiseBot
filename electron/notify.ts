import { Notification, type BrowserWindow, app } from 'electron';
import { unpackAssistantBody } from '../src/lib/assistantBody';
import { readToastEnabled } from '../src/lib/modelOptions';

export const APP_USER_MODEL_ID = 'com.tecadrise.bot';
export { readToastEnabled };

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
    if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);
    const n = new Notification({
      title: `Done • ${opts.agentName}`,
      body: snippet(text),
    });
    n.on('click', () => {
      if (!opts.win) return;
      if (opts.win.isMinimized()) opts.win.restore();
      opts.win.show();
      opts.win.focus();
    });
    n.show();
  } catch (e) {
    console.warn('toast failed', e);
  }
}
