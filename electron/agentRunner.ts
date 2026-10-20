import { BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { v4 as uuid } from 'uuid';
import * as db from './db';
import { formatRuntimeContext } from './controlPlane';
import { restoreFlattenedMarkdown } from '../src/lib/markdown';
import { finalizeAssistantBody, packAssistantBody, unpackAssistantBody } from '../src/lib/assistantBody';
import { addUsage, type TokenUsage } from '../src/lib/usage';
import { resolveAgentSoul } from '../src/lib/soul';
import { getApiKey } from './secrets';
import { DEFAULT_MODEL_ID, readLastMessages, readResumeSession, readToastEnabled, toSdkModel, type CatalogModel } from '../src/lib/modelOptions';
import { maybeNotifyChatDone } from './notify';
import { parseMcpJson, mergeMcpServers, mcpJsonFromServers, type McpServers } from '../src/lib/mcpConfig';
import { applyTodoCallToList, parseNumberedTasks, todoCallFromDelta, type TodoCall, type TodoItem } from '../src/lib/todos';

function broadcastUi(channel: string, payload: unknown, preferred?: BrowserWindow | null): void {
  const seen = new Set<number>();
  const send = (w: BrowserWindow | null | undefined) => {
    if (!w || w.isDestroyed()) return;
    if (seen.has(w.id)) return;
    seen.add(w.id);
    try {
      w.webContents.send(channel, payload);
    } catch {
      /* ignore */
    }
  };
  send(preferred);
  for (const w of BrowserWindow.getAllWindows()) send(w);
}

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
    stream?: () => AsyncIterable<unknown>;
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

function isFailedAssistantBubble(content: string): boolean {
  const t = String(content || '').trim();
  return /^Error:/i.test(t) || /^Agent error:/i.test(t);
}

function todoErrorFromMeta(meta: string | null | undefined): string {
  if (!meta) return '';
  try {
    const o = JSON.parse(meta) as { todoError?: unknown };
    const msg = String(o?.todoError || '').trim();
    return msg;
  } catch {
    return '';
  }
}

function lastAssistantIsFail(agentId: string): boolean {
  const rows = db.listMessages(agentId);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role !== 'assistant') continue;
    const t = String(rows[i].content || '').trim();
    if (!t) continue;
    return isFailedAssistantBubble(t);
  }
  return false;
}

const PROMPT_INLINE_MAX = 2500;

function offloadLongText(cwd: string, filename: string, body: string): string {
  const dest = path.join(cwd, filename);
  try {
    fs.writeFileSync(dest, body, 'utf8');
  } catch {
    return body.length > PROMPT_INLINE_MAX ? body.slice(0, PROMPT_INLINE_MAX) + '...' : body;
  }
  const start = body.slice(0, 280).replace(/\s+/g, ' ').trim();
  return (
    `Full text (${body.length} chars) is in workspace file ${dest}. ` +
    `Read that file if this turn needs it. Do not paste it back verbatim.\nStart: ${start}`
  );
}

function recentChatBody(role: string, raw: string): string {
  let body = String(raw || '').replace(/!\[[^\]]*]\(data:[^)]+\)/g, '[image]');
  if (role === 'assistant') {
    const unpacked = unpackAssistantBody(body);
    body = unpacked.answer.trim() || body;
  }
  return body;
}

function alreadyCovered(hay: string, needle: string): boolean {
  const n = needle.trim();
  if (n.length < 240) return false;
  const probe = n.slice(0, Math.min(500, n.length));
  return hay.includes(probe);
}

function formatRecentChat(
  agentId: string,
  excludeIds: string[],
  limit: number,
  currentUserText: string,
  cwd: string
): string {
  if (limit <= 0) return '';
  const rows = db
    .listMessages(agentId)
    .filter((m) => !excludeIds.includes(m.id) && String(m.content || '').trim());
  const current = String(currentUserText || '');
  const seen = new Set<string>();
  const useful: { role: string; body: string }[] = [];
  let wroteAnswer = false;
  for (let i = rows.length - 1; i >= 0 && useful.length < limit; i--) {
    const m = rows[i];
    if (m.role === 'assistant' && isFailedAssistantBubble(m.content)) continue;
    if (m.role === 'user' && String(m.content || '').trim().length > PROMPT_INLINE_MAX) continue;
    let body = recentChatBody(m.role, m.content);
    if (m.role === 'assistant') {
      const todoErr = todoErrorFromMeta(m.meta);
      if (todoErr) body = `${body}\n[todo tool error] ${todoErr}`;
    }
    if (!body.trim()) continue;
    if (alreadyCovered(current, body)) continue;
    const key = `${m.role}:${body.slice(0, 400)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (m.role === 'assistant' && body.length > PROMPT_INLINE_MAX) {
      body = wroteAnswer
        ? `Previous long answer omitted (${body.length} chars).`
        : offloadLongText(cwd, 'last_answer.md', body);
      wroteAnswer = true;
    }
    useful.push({ role: m.role, body });
  }
  useful.reverse();
  if (!useful.length) return '';
  return (
    '[Recent chat]\nThese are the last messages in this thread, oldest first. Use them for follow-ups like "smaller one".\n\n' +
    useful.map((m) => `${m.role}: ${m.body}`).join('\n\n') +
    '\n[/Recent chat]'
  );
}

function userVisibleContent(text: string, attachments: ChatAttachment[]): string {
  const parts: string[] = [];
  const t = String(text || '').trim();
  if (t) parts.push(t);
  for (const att of attachments) {
    const mime = (att.mimeType || 'application/octet-stream').toLowerCase();
    const name = att.name || 'file';
    if (mime.startsWith('image/') && att.dataBase64) {
      parts.push(`![${name}](data:${mime};base64,${att.dataBase64})`);
    } else if (name) {
      parts.push(`Attached: ${name}`);
    }
  }
  return parts.join('\n\n');
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

function lastThinkingFromConversation(turns: unknown): string {
  if (!Array.isArray(turns)) return '';
  const texts: string[] = [];
  for (const turn of turns) {
    if (!turn || typeof turn !== 'object') continue;
    const steps = (turn as { steps?: Array<{ type?: string; message?: { text?: string } }> }).steps;
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (step?.type === 'thinkingMessage' && step.message?.text) {
        texts.push(String(step.message.text));
      }
    }
  }
  if (!texts.length) return '';
  return texts[texts.length - 1].trim();
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message?: unknown }).message || err);
  return String(err || '');
}

function isHttp2CalmError(err: unknown): boolean {
  return /NGHTTP2_ENHANCE_YOUR_CALM|ENHANCE_YOUR_CALM/i.test(errorText(err));
}

function isCursorStoreError(err: unknown): boolean {
  return /unable to open database file/i.test(errorText(err));
}

function isAnthropicPolicyError(err: unknown): boolean {
  return /blocked under Anthropic's Usage Policy|Request blocked by Anthropic/i.test(errorText(err));
}

function friendlyAgentError(err: unknown): string {
  if (isHttp2CalmError(err)) {
    return 'Cursor API closed this stream (HTTP/2 ENHANCE_YOUR_CALM). Too many agent calls at once. Stop other running agents, wait a few seconds, then send again.';
  }
  const msg = errorText(err).trim();
  return msg || 'Agent run failed';
}

function isBusyError(err: unknown): boolean {
  const msg = errorText(err);
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  return (
    name === 'AgentBusyError' ||
    /already has active run/i.test(msg) ||
    /active run in progress/i.test(msg) ||
    isHttp2CalmError(err)
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
  const hadRun = claimed.has(agentId) || activeRuns.has(agentId) || liveTurns.has(agentId);
  if (hadRun) stopRequested.add(agentId);
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
  liveTurns.delete(agentId);
  if (!hadRun) stopRequested.delete(agentId);
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

function mcpServersForAgent(config: Record<string, unknown> | null | undefined, cwd: string): McpServers | undefined {
  const agentParsed = parseMcpJson(JSON.stringify(config?.mcpServers ?? {}));
  const agentServers = agentParsed.ok ? agentParsed.servers : {};
  const merged = mergeMcpServers(loadGlobalMcpServers(), agentServers);
  if (!Object.keys(merged).length) return undefined;
  const pinned: McpServers = {};
  for (const [name, server] of Object.entries(merged)) {
    const stdio = Boolean(server.command) && !server.url && server.type !== 'http' && server.type !== 'sse';
    pinned[name] = stdio ? { ...server, cwd: server.cwd || cwd } : server;
  }
  return pinned;
}

function localAgentOpts(cwd: string) {
  return {
    cwd,
    dirs: [cwd],
    enableAgentRetries: false,
    settingSources: [] as Array<'project' | 'user' | 'team' | 'mdm' | 'plugins' | 'all'>,
  };
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
  const mcpServers = mcpServersForAgent(agent.config, cwd);
  const local = localAgentOpts(cwd);

  if (!forceNew && readResumeSession(agent.config) && agent.cursorAgentId) {
    try {
      handle = (await Agent.resume(agent.cursorAgentId, {
        apiKey,
        model: modelSel,
        mcpServers,
        local,
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
      local,
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
    const n = Object.keys(mcpServersForAgent(agent.config, db.agentWorkspacePath(agentId)) || {}).length;
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
    content: userVisibleContent(opts.userText, opts.attachments ?? []),
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
    broadcastUi(channel, payload, opts.win);
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

  let userBody =
    fileNotes.length > 0
      ? `${opts.userText}\n\n[Attachments]\n${fileNotes.join('\n')}\n[/Attachments]`
      : opts.userText;
  if (userBody.trim().length > PROMPT_INLINE_MAX) {
    userBody = offloadLongText(cwd, 'last_user.md', userBody);
  }

  const poisoned = lastAssistantIsFail(opts.agentId);
  const recentChat = poisoned
    ? ''
    : formatRecentChat(
        opts.agentId,
        [userMessageId, assistantMessageId],
        readLastMessages(agent.config),
        userBody,
        cwd
      );

const sdkPrompt = [
    systemPrompt,
    '[Checklist tool]\n' +
      'If you need a task list, call the todo tool already in this turn (TodoWrite or updateTodos). ' +
      'Pass { todos: [{ id, content, status }], merge }. merge: false replaces the list. merge: true updates matching ids and keeps the rest.\n' +
      'Todo tool statuses depend on the tool name you were given this turn:\n' +
      '- TodoWrite: pending / in_progress / completed / cancelled (underscore). inProgress is rejected and nothing in that call is applied.\n' +
      '- updateTodos: pending / inProgress / completed / cancelled (camelCase).\n' +
      'Use the spelling for the tool you actually have. If the tool returns a validation error, the allowed values in that error are correct, so retry with them immediately.\n' +
      'After every todo call, read the returned list. If it was rejected or does not match, fix it before continuing.\n' +
      'Never reword or drop items, only change status. Mark an item completed as soon as it is done. Each open user action is its own item.\n' +
      'Do not grep the app source. Do not use GetDynamicTools or HTTP for todos.\n' +
      '[/Checklist tool]',
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
  let todos: TodoItem[] = [];
  try {
    let handle = await getHandle(agent, apiKey, cwd, poisoned);

    const sendOnce = async (h: CursorAgent) => {
      let turnText = '';
      let thinkText = '';
      let turnEnded = false;
      let published = false;
      const genImages: GenImage[] = [];
      let notifyEnded: () => void = () => undefined;
      const endedP = new Promise<void>((resolve) => {
        notifyEnded = resolve;
      });

      const compose = (text: string) => appendImagesToMarkdown(text.trim(), genImages);
      const visible = () => packAssistantBody(thinkText, compose(turnText));
      let lastPersist = 0;
      let lastDeltaEmit = 0;
      let deltaEmitTimer: ReturnType<typeof setTimeout> | null = null;
      const persistVisible = () => {
        assembled = visible();
        const now = Date.now();
        if (assembled && now - lastPersist >= 1000) {
          lastPersist = now;
          db.updateMessageContent(assistantMessageId, assembled);
        }
        return assembled;
      };
      const emitDelta = (immediate: boolean) => {
        persistVisible();
        const fire = () => {
          deltaEmitTimer = null;
          lastDeltaEmit = Date.now();
          emit('chat:stream-delta', {
            agentId: opts.agentId,
            messageId: assistantMessageId,
            content: assembled,
          });
        };
        if (immediate) {
          if (deltaEmitTimer) {
            clearTimeout(deltaEmitTimer);
            deltaEmitTimer = null;
          }
          fire();
          return;
        }
        const wait = 50 - (Date.now() - lastDeltaEmit);
        if (wait <= 0) {
          fire();
          return;
        }
        if (!deltaEmitTimer) deltaEmitTimer = setTimeout(fire, wait);
      };

      const applyTodoCall = (call: TodoCall) => {
        if (call.error) {
          const hint = /inProgress|enum|status/i.test(call.error)
            ? ' TodoWrite status must be pending / in_progress / completed / cancelled.'
            : '';
          const err = `${call.error}${hint}`;
          console.error('[TecAdRiseBot] todo rejected', err);
          thinkText += `\n[todo tool error] ${err}\n`;
          db.patchMessageMeta(assistantMessageId, { todoError: err });
          emitDelta(true);
          return;
        }
        if (!call.todos.length) return;
        todos = applyTodoCallToList(todos, call);
        console.log('[TecAdRiseBot] todos', todos.map((t) => t.status + ':' + t.content).join(' | '));
        db.patchMessageMeta(assistantMessageId, { todos, todoError: null });
        emit('chat:todos', {
          agentId: opts.agentId,
          messageId: assistantMessageId,
          todos,
        });
      };
      const seeded = parseNumberedTasks(opts.userText);
      if (seeded.length >= 2) applyTodoCall({ todos: seeded, merge: false });

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
        const answer = extractLastAssistantText(compose(turnText || unpackAssistantBody(assembled).answer));
        assembled = finalizeAssistantBody(thinkText, answer);
        const packed = unpackAssistantBody(assembled);
        if (!packed.answer && !packed.thinking) return;
        lastPersist = Date.now();
        db.updateMessageContent(assistantMessageId, assembled);
        if (usage) db.patchMessageMeta(assistantMessageId, { usage });
        db.updateAgent(opts.agentId, {
          lastSnippet: (packed.answer || assembled)
            .replace(/!\[[^\]]*]\(data:[^)]+\)/g, '[image]')
            .slice(0, 120),
        });
        published = true;
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
        const incomingCall = todoCallFromDelta(update) || todoCallFromDelta(delta);
        if (incomingCall) applyTodoCall(incomingCall);
        if (update.type === 'tool-call-completed') {
          addImgs(imagesFromUnknown(update.toolCall ?? update));
          persistVisible();
          emit('chat:stream-delta', {
            agentId: opts.agentId,
            messageId: assistantMessageId,
            delta: '',
            content: assembled,
          });
        }
        if (update.type === 'turn-ended') {
          if (update.usage) usage = addUsage(usage, update.usage);
          persistVisible();
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
        if (update.type === 'thinking-delta' && update.text) {
          thinkText += update.text;
          emitDelta(false);
        }
        if (update.type === 'text-delta' && update.text) {
          turnText += update.text;
          emitDelta(true);
        }
      };

      const modelSel = toSdkModel(agent.model || DEFAULT_MODEL_ID, agent.config, modelCatalog);
      console.log('[TecAdRiseBot] sdk model', JSON.stringify(modelSel));
      const run = await h.send(
        imageParts.length
          ? { text: sdkPrompt, images: imageParts }
          : sdkPrompt,
        {
          local: { ...localAgentOpts(cwd), force: true },
          model: modelSel,
          mcpServers: mcpServersForAgent(agent.config, cwd),
          onDelta: takeDelta,
        }
      );

      activeRuns.set(opts.agentId, run);
      if (typeof run.stream === 'function') {
        void (async () => {
          try {
            for await (const ev of run.stream!()) {
              const incoming = todoCallFromDelta(ev);
              if (incoming) applyTodoCall(incoming);
            }
          } catch {
            /* stream closed */
          }
        })();
      }
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
            const convCall = todoCallFromDelta(conv);
            if (convCall && !todos.length) applyTodoCall(convCall);
            const fromConv = lastAssistantFromConversation(conv);
            if (fromConv.trim() && fromConv.trim().length >= turnText.trim().length) turnText = fromConv;
            const fromThink = lastThinkingFromConversation(conv);
            if (fromThink && fromThink.length >= thinkText.length) thinkText = fromThink;
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
        publishDone();
      };

      if (published || turnEnded) {
        await harvestImages();
        void run.cancel().catch(() => undefined);
        activeRuns.delete(opts.agentId);
        return published;
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
          return published;
        }
        const result = raced.r;
        if (result.usage) usage = addUsage(usage, result.usage);
        let fromConv = '';
        try {
          if (typeof run.conversation === 'function') {
            const conv = await run.conversation();
            addImgs(imagesFromUnknown(conv));
            const convCall = todoCallFromDelta(conv);
            if (convCall && !todos.length) applyTodoCall(convCall);
            fromConv = lastAssistantFromConversation(conv);
            const fromThink = lastThinkingFromConversation(conv);
            if (fromThink && fromThink.length >= thinkText.length) thinkText = fromThink;
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
        const rawAnswer = extractLastAssistantText(
          compose(
            (fromConv.trim().length >= turnText.trim().length ? fromConv : turnText) ||
              unpackAssistantBody(assembled).answer ||
              (typeof result.result === 'string' ? result.result : '')
          )
        );
        assembled = finalizeAssistantBody(thinkText, rawAnswer);
        if (result.status === 'error') {
          const msg = result.error?.message || 'Agent run failed';
          if (isCursorStoreError(msg) || isAnthropicPolicyError(msg)) {
            dropAgentHandle(opts.agentId);
            db.updateAgent(opts.agentId, { cursorAgentId: null });
          }
          if (isHttp2CalmError(msg) && !unpackAssistantBody(assembled).answer) {
            throw new Error(msg);
          }
          if (!unpackAssistantBody(assembled).answer && !unpackAssistantBody(assembled).thinking) {
            assembled = `Error: ${friendlyAgentError(msg)}`;
          }
        }
        if (assembled && !published) publishDone();
      } finally {
        activeRuns.delete(opts.agentId);
        stopWaiters.delete(opts.agentId);
      }
      return published;
    };

    try {
      const alreadyPublished = await sendOnce(handle);
      if (stopRequested.has(opts.agentId)) {
        const cur = db.getMessage(assistantMessageId);
        const text = String(cur?.content || assembled || '').trim() || 'Stopped.';
        db.updateMessageContent(assistantMessageId, text);
        db.updateAgent(opts.agentId, { lastSnippet: text.slice(0, 120) });
      } else if (!alreadyPublished) {
        if (!assembled) assembled = '(No response text from agent.)';
        else {
          const u = unpackAssistantBody(extractLastAssistantText(assembled));
          assembled = packAssistantBody(u.thinking, u.answer);
        }
        db.updateMessageContent(assistantMessageId, assembled);
        if (usage) db.patchMessageMeta(assistantMessageId, { usage });
        db.updateAgent(opts.agentId, {
          lastSnippet: (unpackAssistantBody(assembled).answer || assembled).slice(0, 120),
        });
      }
    } catch (e) {
      if (stopRequested.has(opts.agentId)) {
        const cur = db.getMessage(assistantMessageId);
        const text = String(cur?.content || assembled || '').trim() || 'Stopped.';
        db.updateMessageContent(assistantMessageId, text);
      } else if (assembled.trim() && !isHttp2CalmError(e)) {
        db.updateMessageContent(assistantMessageId, assembled);
      } else if (!isBusyError(e)) {
        throw e;
      } else {
        if (isHttp2CalmError(e)) {
          await new Promise((r) => setTimeout(r, 2000));
        }
        await cancelActive(opts.agentId);
        handle = await getHandle(agent, apiKey, cwd, true);
        assembled = '';
        usage = null;
        const alreadyPublished = await sendOnce(handle);
        if (!alreadyPublished) {
          if (!assembled) assembled = '(No response text from agent.)';
          db.updateMessageContent(assistantMessageId, assembled);
        }
      }
    }

    if (stopRequested.has(opts.agentId)) {
      const cur = db.getMessage(assistantMessageId);
      const text = String(cur?.content || assembled || '').trim() || 'Stopped.';
      db.updateMessageContent(assistantMessageId, text);
    }
  } catch (e) {
    const friendly = `Agent error: ${friendlyAgentError(e)}`;
    db.updateMessageContent(assistantMessageId, friendly);
    db.updateAgent(opts.agentId, { lastSnippet: friendly.slice(0, 120) });
    emit('chat:stream-error', {
      agentId: opts.agentId,
      messageId: assistantMessageId,
      error: friendly,
    });
    assembled = friendly;
  } finally {
    claimed.delete(opts.agentId);
    activeRuns.delete(opts.agentId);
    liveTurns.delete(opts.agentId);
    stopRequested.delete(opts.agentId);
    stopWaiters.delete(opts.agentId);
    const cur = db.getMessage(assistantMessageId);
    const text =
      String(assembled || cur?.content || '').trim() || '(No response text from agent.)';
    if (text && text !== String(cur?.content || '').trim()) {
      db.updateMessageContent(assistantMessageId, text);
    }
    emit('chat:stream-done', {
      agentId: opts.agentId,
      messageId: assistantMessageId,
      content: text,
      usage,
      todos,
    });
    maybeNotifyChatDone({
      source: opts.source,
      toastEnabled: readToastEnabled(agent.config),
      agentName: agent.name,
      content: text,
      win: opts.win,
    });
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
