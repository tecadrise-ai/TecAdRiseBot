import { app, BrowserWindow, ipcMain, shell, Menu } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { v4 as uuid } from 'uuid';
import * as db from './db';
import * as secrets from './secrets';
import { listModels, runAgentTurn, cancelAgentRun, listBusyAgentIds, readSystemPrompt, writeSystemPrompt, readSystemMemory, writeSystemMemory, cleanupLegacyControlPlaneFiles, dropAgentHandle, registerAgentMcp } from './agentRunner';
import { startScheduler, stopScheduler } from './scheduler';
import { startHttpApi, stopHttpApi, getHttpApiInfo } from './httpApi';
import { cheapDefaultConfig, shouldRecreateSdkAgent } from '../src/lib/modelOptions';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Safer on varied Windows GPUs / VMs
app.disableHardwareAcceleration();

process.env.APP_ROOT = path.join(__dirname, '..');
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist');

let mainWindow: BrowserWindow | null = null;

function isInternalAppUrl(url: string): boolean {
  if (url.startsWith('file:') || url.startsWith('devtools:')) return true;
  const dev = VITE_DEV_SERVER_URL || 'http://localhost:5173/';
  try {
    return new URL(url).origin === new URL(dev).origin;
  } catch {
    return false;
  }
}

function openInDefaultBrowser(url: string): void {
  if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url)) return;
  void shell.openExternal(url);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: 'TecAdRiseBot',
    backgroundColor: '#f7f7f8',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.maximize();
    mainWindow?.setMenuBarVisibility(false);
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openInDefaultBrowser(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isInternalAppUrl(url)) return;
    event.preventDefault();
    openInDefaultBrowser(url);
  });
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (isInternalAppUrl(url)) return;
    event.preventDefault();
    openInDefaultBrowser(url);
  });

  mainWindow.webContents.on('preload-error', (_e, preloadPath, err) => {
    console.error('preload-error', preloadPath, err);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('did-fail-load', code, desc, url);
  });
  mainWindow.webContents.on('console-message', (_e, _l, message) => {
    console.log('[renderer]', message);
  });
  const devUrl = VITE_DEV_SERVER_URL || 'http://localhost:5173/';
  if (!app.isPackaged) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(RENDERER_DIST, 'index.html'));
  }
}

function registerIpc() {
  ipcMain.handle('agents:list', () => db.listAgents());
  ipcMain.handle('agents:busy', () => listBusyAgentIds());

  ipcMain.handle('controlPlane:info', () => getHttpApiInfo() ?? { port: 8787, baseUrl: 'http://127.0.0.1:8787' });

  ipcMain.handle('agents:create', (_e, name: string, model?: string) => {
    const agent = db.createAgent({
      id: uuid(),
      name: name.trim() || 'New Agent',
      model,
      config: cheapDefaultConfig(),
    });
    return agent;
  });

  ipcMain.handle(
    'agents:update',
    (
      _e,
      id: string,
      patch: {
        name?: string;
        model?: string;
        color?: string;
        instructions?: string | null;
        config?: Record<string, unknown> | null;
      }
    ) => {
      const prev = db.getAgent(id);
      const next = db.updateAgent(id, patch);
      if (prev && shouldRecreateSdkAgent(prev, patch)) dropAgentHandle(id);
      return next;
    }
  );

  ipcMain.handle('agents:registerMcp', async (_e, id: string) => registerAgentMcp(id));

  ipcMain.handle('agents:delete', async (_e, id: string) => {
    await cancelAgentRun(id);
    db.deleteAgent(id);
    return { ok: true };
  });

  ipcMain.handle('messages:list', (_e, agentId: string) => db.listMessages(agentId));
  ipcMain.handle('usage:byAgent', () => db.listAgentUsage());

  ipcMain.handle(
    'chat:send',
    async (
      _e,
      agentId: string,
      text: string,
      attachments?: Array<{ name: string; mimeType: string; dataBase64: string }>
    ) => {
      return runAgentTurn({
        agentId,
        userText: text,
        win: mainWindow,
        source: 'user',
        attachments: attachments ?? [],
      });
    }
  );

  ipcMain.handle('chat:stop', async (_e, agentId: string) => {
    return cancelAgentRun(agentId);
  });

  ipcMain.handle(
    'interbot:send',
    async (_e, fromAgentId: string, toAgentId: string, text: string) => {
      const from = db.getAgent(fromAgentId);
      const to = db.getAgent(toAgentId);
      if (!from || !to) throw new Error('Agent not found');
      const envelope = `Message from agent "${from.name}":\n\n${text}`;
      // Persist outbound note on sender
      db.addMessage({
        id: uuid(),
        agentId: fromAgentId,
        role: 'interbot',
        content: `-> ${to.name}: ${text}`,
        meta: JSON.stringify({ toAgentId, direction: 'out' }),
      });
      return runAgentTurn({
        agentId: toAgentId,
        userText: envelope,
        win: mainWindow,
        source: 'interbot',
      });
    }
  );

  ipcMain.handle('settings:get', () => {
    const meta = secrets.readMeta();
    return {
      hasApiKey: secrets.hasApiKey(),
      selectedModel: meta.selectedModel ?? 'composer-2.5',
      accountName: meta.accountName ?? 'Local user',
      userDataPath: app.getPath('userData'),
      memoryPath: db.ensureMemoryDir(),
      version: app.getVersion(),
      platform: process.platform,
    };
  });

  ipcMain.handle('settings:setApiKey', (_e, apiKey: string) => secrets.saveApiKey(apiKey.trim()));
  ipcMain.handle('settings:clearApiKey', () => {
    secrets.clearApiKey();
    return { ok: true };
  });
  ipcMain.handle('settings:setModel', (_e, model: string) => {
    secrets.writeMeta({ selectedModel: model });
    for (const a of db.listAgents()) {
      db.updateAgent(a.id, { model });
    }
    return secrets.readMeta();
  });
  ipcMain.handle('settings:setAccountName', (_e, name: string) => {
    secrets.writeMeta({ accountName: name });
    return secrets.readMeta();
  });
  ipcMain.handle('settings:getSystemPrompt', () => readSystemPrompt());
  ipcMain.handle('settings:setSystemPrompt', (_e, text: string) => writeSystemPrompt(String(text ?? '')));
  ipcMain.handle('settings:getSystemMemory', () => readSystemMemory());
  ipcMain.handle('settings:setSystemMemory', (_e, text: string) => writeSystemMemory(String(text ?? '')));

  ipcMain.handle('models:list', async () => listModels());

  ipcMain.handle('routines:list', () => db.listRoutines());
  ipcMain.handle(
    'routines:create',
    (_e, input: { agentId: string; name: string; cron: string; prompt: string }) => {
      return db.createRoutine({ id: uuid(), ...input });
    }
  );
  ipcMain.handle(
    'routines:update',
    (
      _e,
      id: string,
      patch: Partial<{ name: string; cron: string; prompt: string; enabled: number }>
    ) => db.updateRoutine(id, patch)
  );
  ipcMain.handle('routines:delete', (_e, id: string) => {
    db.deleteRoutine(id);
    return { ok: true };
  });
  ipcMain.handle('routines:runNow', async (_e, id: string) => {
    const r = db.listRoutines().find((x) => x.id === id);
    if (!r) throw new Error('Routine not found');
    db.updateRoutine(id, { lastRunAt: Date.now() });
    return runAgentTurn({
      agentId: r.agentId,
      userText: `[Scheduled routine: ${r.name}]\n\n${r.prompt}`,
      win: mainWindow,
      source: 'routine',
    });
  });

  ipcMain.handle('app:openPath', (_e, p: string) => shell.openPath(p));
  ipcMain.handle('app:openExternal', (_e, url: string) => {
    openInDefaultBrowser(String(url || ''));
    return { ok: true };
  });
}

app.whenReady().then(async () => {
  // Keep Edit accelerators (Ctrl+V/C/X) without a visible app menu bar on Windows.
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  // Hide the menu bar visually on Windows while keeping shortcuts.
  if (process.platform === 'win32') {
    // re-applied after window create via setMenuBarVisibility
  }
  await db.initDb();
  cleanupLegacyControlPlaneFiles();
  // Seed a default agent if empty
  if (db.listAgents().length === 0) {
    db.createAgent({ id: uuid(), name: 'Assistant' });
  }
  registerIpc();
  createWindow();
  try {
    const info = await startHttpApi(8787);
    console.log('[TecAdRiseBot] Control plane', info);
  } catch (e) {
    console.error('[TecAdRiseBot] Control plane failed', e);
  }
  startScheduler(() => mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopScheduler();
  if (process.platform !== 'darwin') app.quit();
});




app.on('before-quit', () => { try { void stopHttpApi(); } catch { /* ignore */ } });
