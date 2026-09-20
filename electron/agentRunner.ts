import { BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { v4 as uuid } from 'uuid';
import * as db from './db';
import { formatRuntimeContext } from './controlPlane';
import { restoreFlattenedMarkdown } from '../src/lib/markdown';
import { addUsage, type TokenUsage } from '../src/lib/usage';
import { resolveAgentSoul } from '../src/lib/soul';
import { getApiKey } from './secrets';
import { DEFAULT_MODEL_ID, readLastMessages, toSdkModel, type CatalogModel } from '../src/lib/modelOptions';
import { parseMcpJson, mergeMcpServers, mcpJsonFromServers, type McpServers } from '../src/lib/mcpConfig';

export type ChatAttachment = {
  name: string;
  mimeType: string;
  dataBase64: string;
};

type GenImage = { mimeType: string; dataBase64: string };

type CursorAgent = {
  agentId: string;
  listArtifacts?: () => Promise<Array<{ path: string }>>;
  downloadArtifact?: (p: string) => Promise<Buffer>;
  send: (
    message:
      | string
      | { text: string; images?: { data: string; mimeType: string }[] },
    options?: {
      onDelta?: (args: {
        update?: { type?: string; text?: string; usage?: TokenUsage };
        type?: string;
        text?: string;
        usage?: TokenUsage;
      }) => void | Promise<void>;
      local?: { force?: boolean };
      model?: { id: string; params?: Array<{ id: string; value: string }> };
      mcpServers?: Record<string, unknown>;
    }
  ) => Promise<{
    id: string;
    wait: () => Promise<{
      status: string;
      result?: string;
      error?: { message?: string };
      usage?: TokenUsage;
    }>;
    conversation?: () => Promise<unknown>;
    cancel: () => Promise<void>;
    status: string;
  }>;
  close: () => void;
};

const handles = new Map<string, CursorAgent>();
const activeRuns = new Map<string, { cancel: () => Promise<void>; status: string }>();
const stopRequested = new Set<string>();
const claimed = new Set<string>();
const stopWaiters = new Map<string, () => void>();
const liveTurns = new Map<string, { assistantMessageId: string; win: BrowserWindow | null }>();
let modelCatalog: CatalogModel[] = [];

export function dropAgentHandle(agentId: string): void {
  const h = handles.get(agentId);
  if (!h) return;
  try {
    h.close();
  } catch {
    /* ignore */
  }
  handles.delete(agentId);
}

export function dropAllAgentHandles(): void {
  for (const id of Array.from(handles.keys())) dropAgentHandle(id);
}

export function isAgentBusy(agentId: string): boolean {
  return claimed.has(agentId) || activeRuns.has(agentId);
}

export function listBusyAgentIds(): string[] {
  return Array.from(new Set([...claimed, ...activeRuns.keys()]));
}
const tails = new Map<string, Promise<unknown>>();

function appRoot(): string {
  return process.env.APP_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function readSystemPrompt(): string {
  const p = path.join(appRoot(), 'SYSTEM.md');
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return 'You are an agent inside TecAdRiseBot.\n';
  }
}

export function writeSystemPrompt(text: string): { ok: true } {
  const p = path.join(appRoot(), 'SYSTEM.md');
  fs.writeFileSync(p, text.replace(/\r\n/g, '\n'), 'utf8');
  return { ok: true };
}

export function readSystemMemory(): string {
  const p = path.join(appRoot(), 'MEMORY.md');
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

export function writeSystemMemory(text: string): { ok: true } {
  const p = path.join(appRoot(), 'MEMORY.md');
  fs.writeFileSync(p, text.replace(/\r\n/g, '\n'), 'utf8');
  return { ok: true };
}

export function cleanupLegacyControlPlaneFiles(): void {
  const root = db.ensureWorkspacesDir();
  if (!fs.existsSync(root)) return;
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const leftover = path.join(root, ent.name, 'CONTROL_PLANE.md');
    if (fs.existsSync(leftover)) fs.unlinkSync(leftover);
  }
}

function loadSystemPrompt(): string {
  return readSystemPrompt().trim();
}

function loadSystemMemory(): string {
  return readSystemMemory().trim();
}

async function loadCursorSdk(): Promise<typeof import('@cursor/sdk')> {
  return import('@cursor/sdk');
}

function extractLastAssistantText(text: string): string {
  return restoreFlattenedMarkdown(String(text || ''));
}

function mimeFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

function takeGenerateImage(node: unknown): GenImage | null {
  if (!node || typeof node !== 'object') return null;
  const o = node as {
    type?: string;
    result?: { status?: string; value?: { filePath?: string; imageData?: string } };
  };
  if (o.type !== 'generateImage') return null;
  const v = o.result?.status === 'success' ? o.result.value : undefined;
  if (!v) return null;
  let b64 = String(v.imageData || '').trim();
  let mime = mimeFromPath(v.filePath || 'image.png');
  const dataUrl = /^data:([^;]+);base64,(.+)$/s.exec(b64);
  if (dataUrl) {
    mime = dataUrl[1] || mime;
    b64 = dataUrl[2] || '';
  }
  if (!b64 && v.filePath) {
    try {
      if (fs.existsSync(v.filePath)) b64 = fs.readFileSync(v.filePath).toString('base64');
    } catch {
      /* ignore */
    }
  }
  if (!b64) return null;
  return { mimeType: mime, dataBase64: b64 };
}

function imagesFromUnknown(node: unknown, seen = new Set<string>(), out: GenImage[] = []): GenImage[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const x of node) imagesFromUnknown(x, seen, out);
    return out;
  }
  const img = takeGenerateImage(node);
  if (img) {
    const key = `${img.mimeType}:${img.dataBase64.length}:${img.dataBase64.slice(0, 48)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(img);
    }
  }
  for (const v of Object.values(node as Record<string, unknown>)) {
    if (v && typeof v === 'object') imagesFromUnknown(v, seen, out);
  }
  return out;
}

function appendImagesToMarkdown(text: string, images: GenImage[]): string {
  let s = String(text || '').trimEnd();
  for (const img of images) {
    const url = `data:${img.mimeType};base64,${img.dataBase64}`;
    if (s.includes(url)) continue;
    s += `\n\n![generated image](${url})\n`;
  }
  return s.trim();
}

function saveGeneratedImages(cwd: string, images: GenImage[]): void {
  if (!images.length) return;
  const dir = path.join(cwd, 'generated');
  try {
    fs.mkdirSync(dir, { recursive: true });
    images.forEach((img, i) => {
      const ext = img.mimeType.includes('jpeg') ? 'jpg' : (img.mimeType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
      const dest = path.join(dir, `img-${Date.now()}-${i}.${ext || 'png'}`);
      fs.writeFileSync(dest, Buffer.from(img.dataBase64, 'base64'));
    });
  } catch {
    /* ignore */
  }
}

async function imagesFromArtifacts(h: CursorAgent, cwd: string): Promise<GenImage[]> {
  if (typeof h.listArtifacts !== 'function' || typeof h.downloadArtifact !== 'function') return [];
  const arts = await h.listArtifacts();
  const out: GenImage[] = [];
  for (const a of arts) {
    if (!/\.(png|jpe?g|webp|gif)$/i.test(a.path)) continue;
    try {
      const buf = await h.downloadArtifact(a.path);
      const b64 = Buffer.from(buf).toString('base64');
      if (b64) out.push({ mimeType: mimeFromPath(a.path), dataBase64: b64 });
      const destDir = path.join(cwd, 'generated');
      fs.mkdirSync(destDir, { recursive: true });
      const dest = path.join(destDir, path.basename(a.path));
      fs.writeFileSync(dest, Buffer.from(buf));
    } catch {
      /* ignore */
    }
  }
  return out;
}

function formatRecentChat(agentId: string, excludeIds: string[], limit: number): string {
  if (limit <= 0) return '';
  const rows = db
    .listMessages(agentId)
    .filter((m) => !excludeIds.includes(m.id) && String(m.content || '').trim());
  const slice = rows.slice(-limit);
  if (!slice.length) return '';
  const lines = slice.map((m) => {
    let body = String(m.content || '').replace(/!\[[^\]]*]\(data:[^)]+\)/g, '[image]');
    if (body.length > 2000) body = body.slice(0, 2000) + '...';
    return `${m.role}: ${body}`;
  });
  return (
    '[Recent chat]\nThese are the last messages in this thread, oldest first. Use them for follow-ups like "smaller one".\n\n' +
    lines.join('\n\n') +
    '\n[/Recent chat]'
  );
}

function lastAssistantFromConversation(turns: unknown): string {
  if (!Array.isArray(turns)) return '';
  const texts: string[] = [];
  for (const turn of turns) {
    if (!turn || typeof turn !== 'object') continue;
    const steps = (turn as { steps?: Array<{ type?: string; message?: { text?: string } }> }).steps;
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (step?.type === 'assistantMessage' && step.message?.text) {
        texts.push(String(step.message.text));
      }
    }
  }
  if (!texts.length) return '';
  const withBreaks = [...texts].reverse().find((x) => /\n/.test(x));
  return extractLastAssistantText(withBreaks ?? texts[texts.length - 1]);
}

function isBusyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  return (
    name === 'AgentBusyError' ||
    /already has active run/i.test(msg) ||
    /active run in progress/i.test(msg)
  );
}



/** Serialize turns per local agent so we never double-send. */
function enqueue(agentId: string, task: () => Promise<unknown>): Promise<unknown> {
  const prev = tails.get(agentId) ?? Promise.resolve();
  const next = prev.then(task, task);
  tails.set(
    agentId,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}

export async function cancelAgentRun(agentId: string): Promise<{ ok: true }> {
  stopRequested.add(agentId);
  const wake = stopWaiters.get(agentId);
  if (wake) wake();
  await cancelActive(agentId);
  claimed.delete(agentId);
  const live = liveTurns.get(agentId);
  if (live) {
    const msg = db.getMessage(live.assistantMessageId);
    let text = String(msg?.content || '').trim();
    if (!text) {
      text = 'Stopped.';
      db.updateMessageContent(live.assistantMessageId, text);
      db.updateAgent(agentId, { lastSnippet: 'Stopped.' });
    }
    live.win?.webContents.send('chat:stream-done', {
      agentId,
      messageId: live.assistantMessageId,
      content: text,
    });
  }
  dropAgentHandle(agentId);
  return { ok: true };
}

async function cancelActive(agentId: string) {
  const run = activeRuns.get(agentId);
  if (!run) return;
  try {
    await run.cancel();
  } catch (e) {
    console.warn('cancel active run failed', e);
  } finally {
    activeRuns.delete(agentId);
  }
}

const GLOBAL_MCP_SETTING = 'mcp_servers_json';

function loadGlobalMcpServers(): McpServers {
  const parsed = parseMcpJson(db.getSetting(GLOBAL_MCP_SETTING) || '{}');
  return parsed.ok ? parsed.servers : {};
}

function mcpServersForAgent(config: Record<string, unknown> | null | undefined): McpServers | undefined {
  const agentParsed = parseMcpJson(JSON.stringify(config?.mcpServers ?? {}));
  const agentServers = agentParsed.ok ? agentParsed.servers : {};
  const merged = mergeMcpServers(loadGlobalMcpServers(), agentServers);
  if (!Object.keys(merged).length) return undefined;
  return merged;
}

async function getHandle(
  agent: db.AgentRow,
  apiKey: string,
  cwd: string,
  forceNew = false
): Promise<CursorAgent> {
  if (!forceNew) {
    const existing = handles.get(agent.id);
    if (existing) return existing;
  } else {
    const old = handles.get(agent.id);
    if (old) {
      try {
        old.close();
      } catch {
        /* ignore */
      }
      handles.delete(agent.id);
    }
  }

  const { Agent } = await loadCursorSdk();
  if (!modelCatalog.length) {
    try {
      await listModels();
    } catch {
      /* ignore */
    }
  }
  let handle: CursorAgent | null = null;
  const modelSel = toSdkModel(agent.model || DEFAULT_MODEL_ID, agent.config, modelCatalog);
  const mcpServers = mcpServersForAgent(agent.config);

  if (!forceNew && agent.cursorAgentId) {
    try {
      handle = (await Agent.resume(agent.cursorAgentId, {
        apiKey,
        model: modelSel,
        mcpServers,
        local: { cwd, enableAgentRetries: false },
      })) as unknown as CursorAgent;
    } catch (e) {
      console.warn('Agent.resume failed, creating new', e);
      handle = null;
    }
  }

  if (!handle) {
    handle = (await Agent.create({
      apiKey,
      name: agent.name,
      model: modelSel,
      mcpServers,
      local: { cwd, enableAgentRetries: false },
    })) as unknown as CursorAgent;
    db.updateAgent(agent.id, { cursorAgentId: handle.agentId });
  }

  handles.set(agent.id, handle);
  return handle;
}

export async function registerAgentMcp(agentId: string): Promise<{ ok: boolean; error?: string; note?: string }> {
  const agent = db.getAgent(agentId);
  if (!agent) return { ok: false, error: 'Agent not found' };
  dropAgentHandle(agentId);
  const apiKey = getApiKey();
  if (!apiKey) {
    return { ok: true, note: 'Saved. MCP attaches on the next chat turn after you set an API key.' };
  }
  try {
    await getHandle(agent, apiKey, db.agentWorkspacePath(agentId), false);
    const n = Object.keys(mcpServersForAgent(agent.config) || {}).length;
    return {
      ok: true,
      note: n
        ? 'MCP registered on this agent session (global + this agent). Next message can use those tools.'
        : 'Session refreshed with no MCP servers.',
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function readGlobalMcpJson(): string {
  return mcpJsonFromServers(loadGlobalMcpServers());
}

export async function registerGlobalMcp(raw: string): Promise<{ ok: boolean; error?: string; note?: string }> {
  const parsed = parseMcpJson(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  db.setSetting(GLOBAL_MCP_SETTING, JSON.stringify(parsed.servers));
  dropAllAgentHandles();
  const n = Object.keys(parsed.servers).length;
  const busy = listBusyAgentIds().length;
  return {
    ok: true,
    note: n
      ? `Saved ${n} global MCP server${n === 1 ? '' : 's'}. Idle sessions will attach on the next message. ${
          busy ? 'Busy agents pick this up after their current turn. ' : ''
        }Agent Register is only for extra servers on one agent.`
      : 'Cleared global MCP. Idle sessions drop it on the next message.',
  };
}

export async function listModels(): Promise<CatalogModel[]> {
  const fallback: CatalogModel[] = [
    { id: DEFAULT_MODEL_ID, displayName: 'Composer 2.5' },
    { id: 'auto', displayName: 'Auto' },
  ];
  const apiKey = getApiKey();
  if (!apiKey) {
    modelCatalog = fallback;
    return fallback;
  }
  try {
    const { Cursor } = await loadCursorSdk();
    const models = await Cursor.models.list({ apiKey });
    modelCatalog = models.map((m) => ({
      id: m.id,
      displayName: m.displayName || m.id,
      parameters: m.parameters,
      variants: m.variants,
    }));
    return modelCatalog;
  } catch (e) {
    console.error('listModels failed', e);
    modelCatalog = fallback;
    return fallback;
  }
}

async function runAgentTurnInner(opts: {
  agentId: string;
  userText: string;
  win: BrowserWindow | null;
  source?: 'user' | 'routine' | 'interbot';
  attachments?: ChatAttachment[];
}): Promise<{ userMessageId: string; assistantMessageId: string }> {
  const agent = db.getAgent(opts.agentId);
  if (!agent) throw new Error('Agent not found');

  const userMessageId = uuid();
  const assistantMessageId = uuid();

  db.addMessage({
    id: userMessageId,
    agentId: opts.agentId,
    role: opts.source === 'interbot' ? 'interbot' : 'user',
    content: opts.userText,
    meta: opts.source ? JSON.stringify({ source: opts.source }) : null,
  });

  db.addMessage({
    id: assistantMessageId,
    agentId: opts.agentId,
    role: 'assistant',
    content: '',
    meta: null,
  });

  const emit = (channel: string, payload: unknown) => {
    opts.win?.webContents.send(channel, payload);
  };

  emit('chat:message', {
    agentId: opts.agentId,
    message: db.listMessages(opts.agentId).find((m) => m.id === userMessageId),
  });
  emit('chat:stream-start', { agentId: opts.agentId, messageId: assistantMessageId });
  claimed.add(opts.agentId);
  liveTurns.set(opts.agentId, { assistantMessageId, win: opts.win });

  const apiKey = getApiKey();
  if (!apiKey) {
    const err =
      'No Cursor API key saved. Open Local user settings, paste your CURSOR_API_KEY from Cursor Dashboard â†’ API Keys, then try again.';
    db.updateMessageContent(assistantMessageId, err);
    db.updateAgent(opts.agentId, { lastSnippet: err.slice(0, 120) });
    emit('chat:stream-error', { agentId: opts.agentId, messageId: assistantMessageId, error: err });
    emit('chat:stream-done', { agentId: opts.agentId, messageId: assistantMessageId, content: err });
    claimed.delete(opts.agentId);
    liveTurns.delete(opts.agentId);
    return { userMessageId, assistantMessageId };
  }

  const cwd = db.agentWorkspacePath(opts.agentId);
  try {
    const readme = path.join(cwd, 'README.md');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(
        readme,
        '# ' + agent.name + '\n\nLocal TecAdRiseBot agent workspace.\n',
        'utf8'
      );
    }
  } catch {
    /* ignore */
  }

  const systemPrompt = loadSystemPrompt();
  const systemMemory = loadSystemMemory();
  const runtimeCtx = formatRuntimeContext(opts.agentId);
  const instructions = resolveAgentSoul(agent.instructions);
  
  const attachments = opts.attachments ?? [];
  const imageParts: { data: string; mimeType: string }[] = [];
  const fileNotes: string[] = [];
  if (attachments.length) {
    const fs = await import('node:fs');
    const uploads = path.join(cwd, 'uploads');
    fs.mkdirSync(uploads, { recursive: true });
    for (const att of attachments) {
      const safe = att.name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'file';
      const mime = (att.mimeType || 'application/octet-stream').toLowerCase();
      if (mime.startsWith('image/')) {
        imageParts.push({ data: att.dataBase64, mimeType: mime });
        fileNotes.push(`(attached image: ${att.name})`);
      } else {
        const destPath = path.join(uploads, `${Date.now()}_${safe}`);
        fs.writeFileSync(destPath, Buffer.from(att.dataBase64, 'base64'));
        fileNotes.push(`Attached file saved at: ${destPath}`);
      }
    }
  }

  const userBody =
    fileNotes.length > 0
      ? `${opts.userText}\n\n[Attachments]\n${fileNotes.join('\n')}\n[/Attachments]`
      : opts.userText;

  const recentChat = formatRecentChat(
    opts.agentId,
    [userMessageId, assistantMessageId],
    readLastMessages(agent.config)
  );

const sdkPrompt = [
    systemPrompt,
    systemMemory ? '[System memory]' + '\n' + systemMemory + '\n[/System memory]' : '',
    '[Memory directory]' + '\n' + db.ensureMemoryDir() + '\nRead index.md first. Write lasting facts here. Shared by all agents.\n[/Memory directory]',
    '[Skills]' + '\n' + db.formatSkillsCatalog() + '\n[/Skills]',
    runtimeCtx,
    instructions
      ? '[Agent soul]' + '\n' + instructions + '\n[/Agent soul]'
      : '',
    recentChat,
    '[User message]' + '\n' + userBody + '\n[/User message]',
  ]
    .filter(Boolean)
    .join('\n\n');

  let assembled = '';
  let usage: TokenUsage | null = null;
  try {
    let handle = await getHandle(agent, apiKey, cwd, false);

    const sendOnce = async (h: CursorAgent) => {
      let turnText = '';
      let turnEnded = false;
      let published = false;
      const genImages: GenImage[] = [];
      let notifyEnded: () => void = () => undefined;
      const endedP = new Promise<void>((resolve) => {
        notifyEnded = resolve;
      });

      const compose = (text: string) => appendImagesToMarkdown(text.trim(), genImages);

      const addImgs = (imgs: GenImage[]) => {
        for (const img of imgs) {
          const key = `${img.mimeType}:${img.dataBase64.length}:${img.dataBase64.slice(0, 48)}`;
          if (genImages.some((g) => `${g.mimeType}:${g.dataBase64.length}:${g.dataBase64.slice(0, 48)}` === key)) {
            continue;
          }
          genImages.push(img);
        }
      };

      const publishDone = () => {
        assembled = extractLastAssistantText(compose(turnText || assembled));
        if (!assembled) return;
        db.updateMessageContent(assistantMessageId, assembled);
        if (usage) db.patchMessageMeta(assistantMessageId, { usage });
        db.updateAgent(opts.agentId, {
          lastSnippet: assembled.replace(/!\[[^\]]*]\(data:[^)]+\)/g, '[image]').slice(0, 120),
        });
        emit('chat:stream-done', {
          agentId: opts.agentId,
          messageId: assistantMessageId,
          content: assembled,
          usage,
        });
        if (!published) {
          published = true;
          activeRuns.delete(opts.agentId);
          stopRequested.delete(opts.agentId);
          claimed.delete(opts.agentId);
        }
      };

      const takeDelta = (delta: {
        update?: {
          type?: string;
          text?: string;
          usage?: TokenUsage;
          toolCall?: unknown;
        };
        type?: string;
        text?: string;
        usage?: TokenUsage;
        toolCall?: unknown;
      }) => {
        const update = delta.update ?? delta;
        if (update.type === 'usage' && (update.usage || delta.usage)) {
          usage = addUsage(usage, update.usage || delta.usage);
        }
        if (update.type === 'tool-call-completed') {
          addImgs(imagesFromUnknown(update.toolCall ?? update));
          assembled = compose(turnText);
          emit('chat:stream-delta', {
            agentId: opts.agentId,
            messageId: assistantMessageId,
            delta: '',
            content: assembled,
          });
        }
        if (update.type === 'turn-ended') {
          if (update.usage) usage = addUsage(usage, update.usage);
          assembled = compose(turnText);
          turnEnded = true;
          emit('chat:stream-delta', {
            agentId: opts.agentId,
            messageId: assistantMessageId,
            delta: '',
            content: assembled,
          });
          if (assembled) publishDone();
          notifyEnded();
          const live = activeRuns.get(opts.agentId);
          if (live) void live.cancel().catch(() => undefined);
          return;
        }
        if (published) return;
        if (stopRequested.has(opts.agentId)) return;
        if (update.type === 'text-delta' && update.text) {
          turnText += update.text;
          assembled = compose(turnText);
          emit('chat:stream-delta', {
            agentId: opts.agentId,
            messageId: assistantMessageId,
            delta: update.text,
            content: assembled,
          });
        }
      };

      const run = await h.send(
        imageParts.length
          ? { text: sdkPrompt, images: imageParts }
          : sdkPrompt,
        {
          local: { force: true },
          model: toSdkModel(agent.model || DEFAULT_MODEL_ID, agent.config, modelCatalog),
          mcpServers: mcpServersForAgent(agent.config),
          onDelta: takeDelta,
        }
      );

      activeRuns.set(opts.agentId, run);
      if (stopRequested.has(opts.agentId)) {
        try {
          await run.cancel();
        } catch {
          /* ignore */
        }
        activeRuns.delete(opts.agentId);
        return false;
      }

      const harvestImages = async () => {
        try {
          if (typeof run.conversation === 'function') {
            const conv = await run.conversation();
            addImgs(imagesFromUnknown(conv));
            const fromConv = lastAssistantFromConversation(conv);
            if (fromConv.trim()) turnText = fromConv;
          }
        } catch {
          /* ignore */
        }
        try {
          addImgs(await imagesFromArtifacts(h, cwd));
        } catch {
          /* ignore */
        }
        if (genImages.length) saveGeneratedImages(cwd, genImages);
        assembled = compose(turnText || assembled);
        if (assembled) publishDone();
      };

      if (published || turnEnded) {
        await harvestImages();
        void run.cancel().catch(() => undefined);
        activeRuns.delete(opts.agentId);
        return published || !!assembled;
      }

      const stopP = new Promise<void>((resolve) => {
        stopWaiters.set(opts.agentId, resolve);
        if (stopRequested.has(opts.agentId)) resolve();
      });

      try {
        const raced = await Promise.race([
          run.wait().then((r) => ({ kind: 'wait' as const, r })),
          endedP.then(() => ({ kind: 'ended' as const })),
          stopP.then(() => ({ kind: 'stop' as const })),
        ]);
        if (raced.kind === 'stop' || stopRequested.has(opts.agentId)) {
          try {
            await run.cancel();
          } catch {
            /* ignore */
          }
          return false;
        }
        if (raced.kind === 'ended' || turnEnded || published) {
          void run.cancel().catch(() => undefined);
          if (assembled && !published) publishDone();
          return published || !!assembled;
        }
        const result = raced.r;
        if (result.usage) usage = addUsage(usage, result.usage);
        let fromConv = '';
        try {
          if (typeof run.conversation === 'function') {
            const conv = await run.conversation();
            addImgs(imagesFromUnknown(conv));
            fromConv = lastAssistantFromConversation(conv);
          }
        } catch {
          /* ignore */
        }
        try {
          addImgs(await imagesFromArtifacts(h, cwd));
        } catch {
          /* ignore */
        }
        if (genImages.length) saveGeneratedImages(cwd, genImages);
        assembled = extractLastAssistantText(
          compose(fromConv || turnText || assembled || (typeof result.result === 'string' ? result.result : ''))
        );
        if (result.status === 'error') {
          const msg = result.error?.message || 'Agent run failed';
          if (!assembled) assembled = `Error: ${msg}`;
        }
      } finally {
        activeRuns.delete(opts.agentId);
        stopWaiters.delete(opts.agentId);
      }
      return published || !!assembled;
    };

    try {
      const alreadyPublished = await sendOnce(handle);
      if (stopRequested.has(opts.agentId)) {
        const cur = db.getMessage(assistantMessageId);
        const text = String(cur?.content || assembled || '').trim() || 'Stopped.';
        db.updateMessageContent(assistantMessageId, text);
        db.updateAgent(opts.agentId, { lastSnippet: text.slice(0, 120) });
        emit('chat:stream-done', {
          agentId: opts.agentId,
          messageId: assistantMessageId,
          content: text,
        });
        return { userMessageId, assistantMessageId };
      }
      if (alreadyPublished) return { userMessageId, assistantMessageId };
    } catch (e) {
      if (stopRequested.has(opts.agentId)) {
        const cur = db.getMessage(assistantMessageId);
        const text = String(cur?.content || assembled || '').trim() || 'Stopped.';
        db.updateMessageContent(assistantMessageId, text);
        emit('chat:stream-done', {
          agentId: opts.agentId,
          messageId: assistantMessageId,
          content: text,
        });
        return { userMessageId, assistantMessageId };
      }
      if (assembled.trim()) return { userMessageId, assistantMessageId };
      if (!isBusyError(e)) throw e;
      await cancelActive(opts.agentId);
      handle = await getHandle(agent, apiKey, cwd, true);
      assembled = '';
      usage = null;
      const alreadyPublished = await sendOnce(handle);
      if (alreadyPublished) return { userMessageId, assistantMessageId };
    }

    if (stopRequested.has(opts.agentId)) {
      const cur = db.getMessage(assistantMessageId);
      const text = String(cur?.content || assembled || '').trim() || 'Stopped.';
      db.updateMessageContent(assistantMessageId, text);
      emit('chat:stream-done', { agentId: opts.agentId, messageId: assistantMessageId, content: text });
      return { userMessageId, assistantMessageId };
    }

    if (!assembled) assembled = '(No response text from agent.)';
    assembled = extractLastAssistantText(assembled);

    db.updateMessageContent(assistantMessageId, assembled);
    if (usage) db.patchMessageMeta(assistantMessageId, { usage });
    db.updateAgent(opts.agentId, { lastSnippet: assembled.slice(0, 120) });
    emit('chat:stream-done', {
      agentId: opts.agentId,
      messageId: assistantMessageId,
      content: assembled,
      usage,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const friendly = `Agent error: ${msg}`;
    db.updateMessageContent(assistantMessageId, friendly);
    db.updateAgent(opts.agentId, { lastSnippet: friendly.slice(0, 120) });
    emit('chat:stream-error', {
      agentId: opts.agentId,
      messageId: assistantMessageId,
      error: friendly,
    });
    emit('chat:stream-done', {
      agentId: opts.agentId,
      messageId: assistantMessageId,
      content: friendly,
    });
  } finally {
    claimed.delete(opts.agentId);
    liveTurns.delete(opts.agentId);
    stopRequested.delete(opts.agentId);
    stopWaiters.delete(opts.agentId);
  }

  return { userMessageId, assistantMessageId };
}

export async function runAgentTurn(opts: {
  agentId: string;
  userText: string;
  win: BrowserWindow | null;
  source?: 'user' | 'routine' | 'interbot';
  attachments?: ChatAttachment[];
}): Promise<{ userMessageId: string; assistantMessageId: string }> {
  return enqueue(opts.agentId, () => runAgentTurnInner({ ...opts, attachments: opts.attachments ?? [] })) as Promise<{
    userMessageId: string;
    assistantMessageId: string;
  }>;
}
