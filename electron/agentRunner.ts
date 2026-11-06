import { app, BrowserWindow } from 'electron';
import { chatImageUrl, saveChatImage } from './chatImages';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { v4 as uuid } from 'uuid';
import * as db from './db';
import { restoreFlattenedMarkdown } from '../src/lib/markdown';
import { finalizeAssistantBody, packAssistantBody, unpackAssistantBody } from '../src/lib/assistantBody';
import { addUsage, type TokenUsage } from '../src/lib/usage';
import { resolveAgentSoul } from '../src/lib/soul';
import { getApiKey, getEnvMap } from './secrets';
import { DEFAULT_MODEL_ID, formatModelLabel, readLastMessages, readToastEnabled, toSdkModel, type CatalogModel } from '../src/lib/modelOptions';
import { maybeNotifyChatDone } from './notify';
import { parseMcpJson, mergeMcpServers, mcpJsonFromServers, type McpServers } from '../src/lib/mcpConfig';
import { buildHostSystemPrompt } from '../src/lib/promptHost';
import { labelsFromUnknown, mergeUsed } from '../src/lib/usedHoldings';
import { hostMcpExtras } from './hostMcp';
import { auditTurn } from './audit';
import { applyTodoCallToList, parseNumberedTasks, todoCallFromDelta, type TodoCall, type TodoItem } from '../src/lib/todos';
import { absorbConnectorMcp, connectorMcpServers } from './connectors';

export function broadcastUi(channel: string, payload: unknown, preferred?: BrowserWindow | null): void {
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

/** filePath/url are set once the image is written to disk, then the chat shows the file instead of inline base64. */
type GenImage = { mimeType: string; dataBase64: string; filePath?: string; url?: string | null };

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

function closeHandle(agentId: string): void {
  const h = handles.get(agentId);
  if (!h) return;
  try {
    h.close();
  } catch {
    /* ignore */
  }
  handles.delete(agentId);
}

/** Settings changes call this. A busy agent keeps its live handle, closing it mid-run breaks the SDK stream. */
export function dropAgentHandle(agentId: string): void {
  if (isAgentBusy(agentId)) return;
  closeHandle(agentId);
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

/** The packaged app root is a read-only asar, so edited copies live in userData and win over the bundled file. */
function hostFilePaths(name: string): { read: string[]; write: string } {
  const bundled = path.join(appRoot(), name);
  if (!app.isPackaged) return { read: [bundled], write: bundled };
  const user = path.join(app.getPath('userData'), name);
  return { read: [user, bundled], write: user };
}

function readHostFile(name: string): string | null {
  for (const p of hostFilePaths(name).read) {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      /* try next */
    }
  }
  return null;
}

function writeHostFile(name: string, text: string): { ok: true } {
  const p = hostFilePaths(name).write;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text.replace(/\r\n/g, '\n'), 'utf8');
  return { ok: true };
}

export function readArchitecture(): string {
  return readHostFile('ARCHITECTURE.md') ?? '';
}

export function readSystemPrompt(): string {
  return readHostFile('SYSTEM.md') ?? 'You are an agent inside TecAdRiseBot.\n';
}

export function writeSystemPrompt(text: string): { ok: true } {
  return writeHostFile('SYSTEM.md', text);
}

export function readSystemMemory(): string {
  return readHostFile('MEMORY.md') ?? '';
}

export function writeSystemMemory(text: string): { ok: true } {
  return writeHostFile('MEMORY.md', text);
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
    const url = img.url || `data:${img.mimeType};base64,${img.dataBase64}`;
    if (s.includes(url)) continue;
    s += `\n\n![generated image](${url})\n`;
  }
  return s.trim();
}

function saveGeneratedImages(cwd: string, images: GenImage[]): void {
  images = images.filter((img) => !img.filePath);
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
      const destDir = path.join(cwd, 'generated');
      fs.mkdirSync(destDir, { recursive: true });
      const dest = path.join(destDir, path.basename(a.path));
      fs.writeFileSync(dest, Buffer.from(buf));
      if (b64) out.push({ mimeType: mimeFromPath(a.path), dataBase64: b64, filePath: dest, url: chatImageUrl(dest) });
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
  let body = String(raw || '').replace(/!\[[^\]]*]\((?:data|tecimg):[^)]+\)/g, '[image]');
  if (role === 'assistant') {
    const unpacked = unpackAssistantBody(body);
    // Never replay hidden reasoning. A thinking-only/incomplete bubble carries no
    // reliable assistant answer and must be omitted from recovered chat.
    body = unpacked.answer.trim();
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
    '[Recent chat]\n' +
    useful.map((m) => `${m.role}: ${m.body}`).join('\n\n') +
    '\n[/Recent chat]'
  );
}

function userVisibleContent(text: string, attachments: ChatAttachment[], imageUrls: Map<ChatAttachment, string> = new Map()): string {
  const parts: string[] = [];
  const t = String(text || '').trim();
  if (t) parts.push(t);
  for (const att of attachments) {
    const mime = (att.mimeType || 'application/octet-stream').toLowerCase();
    const name = att.name || 'file';
    if (mime.startsWith('image/') && att.dataBase64) {
      parts.push(`![${name}](${imageUrls.get(att) || `data:${mime};base64,${att.dataBase64}`})`);
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

function isSystemPromptUnsupported(err: unknown): boolean {
  return /system.?prompt|--system-prompt/i.test(errorText(err)) && /invalid|access|enabled|argument/i.test(errorText(err));
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
    broadcastUi('chat:stream-done', { agentId, messageId: live.assistantMessageId, content: text }, live.win);
  }
  liveTurns.delete(agentId);
  if (!hadRun) stopRequested.delete(agentId);
  await disposeFreshHandle(agentId, db.agentWorkspacePath(agentId));
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

function serversFromUnknown(raw: unknown): McpServers {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});
  const all = parseMcpJson(text);
  if (all.ok) return all.servers;
  let obj: Record<string, unknown> = {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) obj = v as Record<string, unknown>;
  } catch {
    console.warn('[TecAdRiseBot] mcp JSON ignored:', all.error);
    return {};
  }
  if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
    obj = obj.mcpServers as Record<string, unknown>;
  }
  const out: McpServers = {};
  for (const [name, entry] of Object.entries(obj)) {
    const one = parseMcpJson(JSON.stringify({ [name]: entry }));
    if (one.ok) Object.assign(out, one.servers);
    else console.warn('[TecAdRiseBot] skip mcp', name, one.error);
  }
  return out;
}

function loadGlobalMcpServers(): McpServers {
  return serversFromUnknown(db.getSetting(GLOBAL_MCP_SETTING) || '{}');
}

function expandEnvRefs(servers: McpServers): McpServers {
  const fileEnv = getEnvMap();
  const sub = (v: string) =>
    v.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_all, name: string) => {
      const val = process.env[name] ?? fileEnv[name];
      if (val === undefined) console.warn('[TecAdRiseBot] mcp env not set:', name);
      return val ?? '';
    });
  const mapVals = (o?: Record<string, string>) =>
    o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, sub(v)])) : o;
  const out: McpServers = {};
  for (const [name, s] of Object.entries(servers)) {
    out[name] = {
      ...s,
      ...(s.headers ? { headers: mapVals(s.headers) } : {}),
      ...(s.env ? { env: mapVals(s.env) } : {}),
      ...(s.url ? { url: sub(s.url) } : {}),
    };
  }
  return out;
}

async function mcpServersForAgent(
  config: Record<string, unknown> | null | undefined,
  cwd: string,
  extraMcp?: McpServers
): Promise<McpServers | undefined> {
  const always = mergeMcpServers(serversFromUnknown(config?.mcpServers ?? {}), extraMcp || {});
  const shared = mergeMcpServers(loadGlobalMcpServers(), await connectorMcpServers());
  const merged = mergeMcpServers(shared, always);
  if (!Object.keys(merged).length) return {};
  const pinned: McpServers = {};
  for (const [name, server] of Object.entries(expandEnvRefs(merged))) {
    const stdio = Boolean(server.command) && !server.url && server.type !== 'http' && server.type !== 'sse';
    pinned[name] = stdio ? { ...server, cwd: server.cwd || cwd } : server;
  }
  return pinned;
}

function localAgentOpts(cwd: string, extraDirs: string[] = []) {
  return {
    cwd,
    dirs: [cwd, ...extraDirs.filter((d) => d && d !== cwd)],
    enableAgentRetries: false,
    settingSources: [] as Array<'project' | 'user' | 'team' | 'mdm' | 'plugins' | 'all'>,
  };
}

async function getHandle(
  agent: db.AgentRow,
  apiKey: string,
  cwd: string,
  systemPrompt?: string,
  extraDirs: string[] = [],
  extraMcp?: McpServers,
  pinnedMcp?: McpServers
): Promise<CursorAgent> {
  // One SDK agent per turn. Never reuse the conversation: a kept session grew
  // context without bound. Chat in the UI is our history; Cursor gets a new run.
  const oldAgentId = handles.get(agent.id)?.agentId;
  closeHandle(agent.id);

  const { Agent } = await loadCursorSdk();
  if (oldAgentId) {
    try {
      await Agent.delete(oldAgentId, { cwd });
    } catch {
      /* already gone */
    }
  }
  if (!modelCatalog.length) {
    try {
      await listModels();
    } catch {
      /* ignore */
    }
  }
  const modelSel = toSdkModel(agent.model || DEFAULT_MODEL_ID, agent.config, modelCatalog);
  const mcpServers = pinnedMcp ?? (await mcpServersForAgent(agent.config, cwd, extraMcp));
  const local = localAgentOpts(cwd, extraDirs);

  const handle = (await Agent.create({
    apiKey,
    name: agent.name,
    model: modelSel,
    mcpServers: mcpServers as never,
    local,
    ...(systemPrompt ? { systemPrompt } : {}),
  })) as unknown as CursorAgent;

  handles.set(agent.id, handle);
  if (agent.cursorAgentId) db.updateAgent(agent.id, { cursorAgentId: null });
  return handle;
}

async function disposeFreshHandle(agentId: string, cwd: string): Promise<void> {
  const sdkAgentId = handles.get(agentId)?.agentId;
  closeHandle(agentId);
  if (!sdkAgentId) return;
  try {
    const { Agent } = await loadCursorSdk();
    await Agent.delete(sdkAgentId, { cwd });
  } catch (e) {
    console.warn('[TecAdRiseBot] delete fresh SDK agent failed', sdkAgentId, errorText(e));
  }
}

export async function registerAgentMcp(agentId: string): Promise<{ ok: boolean; error?: string; note?: string }> {
  const agent = db.getAgent(agentId);
  if (!agent) return { ok: false, error: 'Agent not found' };
  if (isAgentBusy(agentId)) {
    return { ok: true, note: 'Saved. The agent is busy, MCP attaches on its next run.' };
  }
  dropAgentHandle(agentId);
  const apiKey = getApiKey();
  if (!apiKey) {
    return { ok: true, note: 'Saved. MCP attaches on the next chat turn after you set an API key.' };
  }
  try {
    const cwd = db.agentWorkspacePath(agentId);
    await getHandle(agent, apiKey, cwd);
    await disposeFreshHandle(agentId, cwd);
    const n = Object.keys((await mcpServersForAgent(agent.config, cwd)) || {}).length;
    return {
      ok: true,
      note: n
        ? 'MCP configuration validated. Every new run will load global + agent MCP servers.'
        : 'MCP configuration validated with no servers.',
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
  const absorbed = absorbConnectorMcp(parsed.servers);
  db.setSetting(GLOBAL_MCP_SETTING, JSON.stringify(absorbed.servers));
  dropAllAgentHandles();
  const n = Object.keys(absorbed.servers).length;
  const busy = listBusyAgentIds().length;
  const moved = absorbed.notes.length
    ? ` Moved ${absorbed.notes.join(', ')} into Connectors (secrets.bin).`
    : '';
  return {
    ok: true,
    note: n
      ? `Saved ${n} global MCP server${n === 1 ? '' : 's'}. Idle sessions will attach on the next message. ${
          busy ? 'Busy agents pick this up after their current turn. ' : ''
        }Agent Register is only for extra servers on one agent.${moved}`
      : `Cleared global MCP. Idle sessions drop it on the next message.${moved}`,
  };
}

export async function listModels(): Promise<CatalogModel[]> {
  const fallback: CatalogModel[] = [
    { id: DEFAULT_MODEL_ID, displayName: 'Composer 2.5' },
    { id: 'auto', displayName: 'Auto' },
  ];
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      modelCatalog = fallback;
      return fallback;
    }
    const { Cursor } = await loadCursorSdk();
    const models = await Cursor.models.list({ apiKey });
    if (!models.length) throw new Error('empty model list');
    modelCatalog = models.map((m) => ({
      id: m.id,
      displayName: m.displayName || m.id,
      parameters: m.parameters,
      variants: m.variants,
    }));
    return modelCatalog;
  } catch (e) {
    console.error('listModels failed', e);
    if (modelCatalog.length > fallback.length) return modelCatalog;
    modelCatalog = fallback;
    return fallback;
  }
}

/** Optional per-turn additions used by step workflows. Plain chat turns pass nothing. */
export type TurnExtras = {
  /** Extra MCP servers merged over global + agent MCP for this turn only. */
  extraMcp?: McpServers;
  /** Model, mode and effort override for this turn only. */
  modelOverride?: { model?: string; modelMode?: string; effort?: string };
  /** Replaces the default [Checklist tool] block. */
  checklistBlock?: string;
  /** Appended to the system prompt. */
  extraSystem?: string;
  /** Extra folders the SDK agent may read and write. */
  extraDirs?: string[];
  /** Merged into the assistant message meta (chat UI reads it). */
  meta?: Record<string, unknown>;
  /** Do not seed a todo list from numbered lines in the prompt. */
  noTodoSeed?: boolean;
  /** Skip the todo-based auto-continue loop. */
  noAutoContinue?: boolean;
  /** Ignore registered augmenters (a runner must not get owner tools). */
  noAugment?: boolean;
};

export type TurnAugmenterCtx = { userText: string; source?: string };
type TurnAugmenter = (agent: db.AgentRow, ctx: TurnAugmenterCtx) => TurnExtras | null;
let turnAugmenter: TurnAugmenter | null = null;

/** Feature modules (workflows) register extras that apply to every turn of matching agents. */
export function setTurnAugmenter(fn: TurnAugmenter | null): void {
  turnAugmenter = fn;
}

function mergeExtras(a: TurnExtras | null | undefined, b: TurnExtras | null | undefined): TurnExtras | undefined {
  if (!a && !b) return undefined;
  if (!a) return b ?? undefined;
  if (!b) return a;
  return {
    ...a,
    ...b,
    extraMcp: { ...(a.extraMcp || {}), ...(b.extraMcp || {}) },
    extraSystem: [...new Set([a.extraSystem, b.extraSystem].filter(Boolean))].join('\n\n') || undefined,
    extraDirs: [...(a.extraDirs || []), ...(b.extraDirs || [])],
    meta: { ...(a.meta || {}), ...(b.meta || {}) },
  };
}

function withExtras(agent: db.AgentRow, extras: TurnExtras | undefined): db.AgentRow {
  if (!extras) return agent;
  const config: Record<string, unknown> = { ...(agent.config || {}) };
  const o = extras.modelOverride;
  if (o?.modelMode) config.modelMode = o.modelMode;
  if (o?.effort) config.effort = o.effort;
  return { ...agent, model: o?.model || agent.model, config };
}

type TurnResult = {
  userMessageId: string;
  assistantMessageId: string;
  stopped?: boolean;
  stalled?: boolean;
  failed?: boolean;
  todos?: TodoItem[];
  answer?: string;
};

/** Cancel a run that produced no stream event for this long (hung tool call). */
const STALL_MS = 15 * 60_000;
/** Extra automatic turns when a turn ends with unfinished todo items. */
const MAX_AUTO_CONTINUE = 3;

async function runAgentTurnInner(opts: {
  agentId: string;
  userText: string;
  win: BrowserWindow | null;
  source?: 'user' | 'routine' | 'interbot';
  attachments?: ChatAttachment[];
  seedTodos?: TodoItem[];
  deferNotify?: boolean;
  extras?: TurnExtras;
}): Promise<TurnResult> {
  const baseAgent = db.getAgent(opts.agentId);
  if (!baseAgent) throw new Error('Agent not found');
  const extras = opts.extras?.noAugment
    ? opts.extras
    : mergeExtras(
        { extraDirs: [db.ensureSkillsDir()] },
        mergeExtras(
          hostMcpExtras(baseAgent.id),
          mergeExtras(turnAugmenter?.(baseAgent, { userText: opts.userText, source: opts.source }), opts.extras)
        )
      );
  const agent = withExtras(baseAgent, extras);
  const extraDirs = extras?.extraDirs ?? [];

  const userMessageId = uuid();
  const assistantMessageId = uuid();

  const imageUrls = new Map<ChatAttachment, string>();
  for (const att of opts.attachments ?? []) {
    const mime = (att.mimeType || '').toLowerCase();
    if (!mime.startsWith('image/') || !att.dataBase64) continue;
    try {
      const saved = saveChatImage(path.join(db.agentWorkspacePath(opts.agentId), 'uploads'), att.name || 'image', mime, att.dataBase64);
      if (saved.url) imageUrls.set(att, saved.url);
    } catch (e) {
      console.warn('[TecAdRiseBot] saving attached image failed, keeping it inline', e);
    }
  }

  db.addMessage({
    id: userMessageId,
    agentId: opts.agentId,
    role: opts.source === 'interbot' ? 'interbot' : 'user',
    content: userVisibleContent(opts.userText, opts.attachments ?? [], imageUrls),
    meta: opts.source ? JSON.stringify({ source: opts.source }) : null,
  });

  db.addMessage({
    id: assistantMessageId,
    agentId: opts.agentId,
    role: 'assistant',
    content: '',
    meta: extras?.meta && Object.keys(extras.meta).length ? JSON.stringify(extras.meta) : null,
  });

  const emit = (channel: string, payload: unknown) => {
    broadcastUi(channel, payload, opts.win);
  };

  emit('chat:message', {
    agentId: opts.agentId,
    message: db.listMessages(opts.agentId).find((m) => m.id === userMessageId),
  });
  emit('chat:stream-start', {
    agentId: opts.agentId,
    messageId: assistantMessageId,
    meta: extras?.meta && Object.keys(extras.meta).length ? JSON.stringify(extras.meta) : null,
  });
  claimed.add(opts.agentId);
  liveTurns.set(opts.agentId, { assistantMessageId, win: opts.win });

  const apiKey = getApiKey();
  if (!apiKey) {
    const err =
      'No Cursor API key saved. Open Settings, API Keys, paste the Cursor key, then try again.';
    db.updateMessageContent(assistantMessageId, err);
    db.updateAgent(opts.agentId, { lastSnippet: err.slice(0, 120) });
    emit('chat:stream-error', { agentId: opts.agentId, messageId: assistantMessageId, error: err });
    emit('chat:stream-done', { agentId: opts.agentId, messageId: assistantMessageId, content: err });
    claimed.delete(opts.agentId);
    liveTurns.delete(opts.agentId);
    return { userMessageId, assistantMessageId, failed: true };
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
    const localMemory = path.join(cwd, 'memory.md');
    if (!fs.existsSync(localMemory)) {
      fs.writeFileSync(
        localMemory,
        '# ' +
          agent.name +
          ' memory\n\nPrivate to this agent. Shared facts go in the host Memory directory.\n',
        'utf8'
      );
    }
  } catch {
    /* ignore */
  }

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

  const mcpForTurn = await mcpServersForAgent(agent.config, cwd, extras?.extraMcp);
  const attachedMcp = Object.keys(mcpForTurn || {});
  const labelsOf = (node: unknown) => labelsFromUnknown(node, 0, new Set(), attachedMcp);

  const recoveredChat = formatRecentChat(
    opts.agentId,
    [userMessageId, assistantMessageId],
    readLastMessages(agent.config),
    userBody,
    cwd
  );

  const hostSystemPrompt = buildHostSystemPrompt({
    agentName: agent.name,
    agentId: opts.agentId,
    modelLabel: formatModelLabel(agent.model, agent.config),
    workspace: cwd,
    memoryDir: db.ensureMemoryDir(),
    skillsIndex: db.formatSkillsCatalog(),
    soul: instructions,
    system: readSystemPrompt(),
    memory: readSystemMemory(),
    extraSystem: extras?.extraSystem,
    checklist: extras?.checklistBlock,
  });

  const turnPrompt = [recoveredChat, userBody ? `User:\n${userBody}` : ''].filter(Boolean).join('\n\n');

  db.patchMessageMeta(assistantMessageId, {
    hostChars: hostSystemPrompt.length,
    mcp: Object.keys(mcpForTurn || {}),
  });

  let assembled = '';
  let usage: TokenUsage | null = null;
  let used: string[] = [];
  let todos: TodoItem[] = [];
  let stalled = false;
  let wasStopped = false;
  let policyBlocked = false;
  let systemPromptRejected = false;
  // This Cursor account rejects Agent.create({ systemPrompt }). Host text goes in the user turn.
  let customSystemPrompt = false;
  let lastActivity = Date.now();
  try {
    let handle = await getHandle(agent, apiKey, cwd, undefined, extraDirs, extras?.extraMcp, mcpForTurn);

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
        db.patchMessageMeta(assistantMessageId, { todos, todoError: null });
        emit('chat:todos', {
          agentId: opts.agentId,
          messageId: assistantMessageId,
          todos,
        });
      };
      const seeded = opts.seedTodos?.length ? opts.seedTodos : extras?.noTodoSeed ? [] : parseNumberedTasks(opts.userText);
      if (seeded.length >= (opts.seedTodos?.length ? 1 : 2)) applyTodoCall({ todos: seeded, merge: false });

      const addImgs = (imgs: GenImage[]) => {
        for (const img of imgs) {
          const key = `${img.mimeType}:${img.dataBase64.length}:${img.dataBase64.slice(0, 48)}`;
          if (genImages.some((g) => `${g.mimeType}:${g.dataBase64.length}:${g.dataBase64.slice(0, 48)}` === key)) {
            continue;
          }
          if (!img.filePath) {
            try {
              const saved = saveChatImage(path.join(cwd, 'generated'), 'img', img.mimeType, img.dataBase64);
              img.filePath = saved.filePath;
              img.url = saved.url;
            } catch (e) {
              console.warn('[TecAdRiseBot] saving generated image failed, keeping it inline', e);
            }
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
        db.patchMessageMeta(assistantMessageId, { ...(usage ? { usage } : {}), used });
        db.updateAgent(opts.agentId, {
          lastSnippet: (packed.answer || assembled)
            .replace(/!\[[^\]]*]\((?:data|tecimg):[^)]+\)/g, '[image]')
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
        lastActivity = Date.now();
        const update = delta.update ?? delta;
        if (update.type === 'usage' && (update.usage || delta.usage)) {
          usage = addUsage(usage, update.usage || delta.usage);
        }
        const incomingCall = todoCallFromDelta(update) || todoCallFromDelta(delta);
        if (incomingCall) applyTodoCall(incomingCall);
        const nextUsed = mergeUsed(used, labelsOf(delta));
        if (nextUsed.length !== used.length) {
          used = nextUsed;
          db.patchMessageMeta(assistantMessageId, { used });
          emit('chat:stream-delta', {
            agentId: opts.agentId,
            messageId: assistantMessageId,
            delta: '',
            content: assembled,
            used,
          });
        }
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
      const sdkPrompt = customSystemPrompt
        ? turnPrompt
        : [hostSystemPrompt, turnPrompt].filter(Boolean).join('\n\n');
      const run = await h.send(
        imageParts.length
          ? { text: sdkPrompt, images: imageParts }
          : sdkPrompt,
        {
          local: { ...localAgentOpts(cwd, extraDirs), force: true },
          model: modelSel,
          mcpServers: mcpForTurn || {},
          onDelta: takeDelta,
        }
      );

      activeRuns.set(opts.agentId, run);
      if (typeof run.stream === 'function') {
        void (async () => {
          try {
            for await (const ev of run.stream!()) {
              lastActivity = Date.now();
              const incoming = todoCallFromDelta(ev);
              if (incoming) applyTodoCall(incoming);
              const fromStream = mergeUsed(used, labelsOf(ev));
              if (fromStream.length !== used.length) {
                used = fromStream;
                db.patchMessageMeta(assistantMessageId, { used });
                emit('chat:stream-delta', {
                  agentId: opts.agentId,
                  messageId: assistantMessageId,
                  delta: '',
                  content: assembled,
                  used,
                });
              }
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
            used = mergeUsed(used, labelsOf(conv));
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

      // Watchdog: a hung tool call (browser click, script) emits nothing. Cut the run and let auto-continue retry.
      lastActivity = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - lastActivity < STALL_MS) return;
        stalled = true;
        console.warn('[TecAdRiseBot] run stalled, cancelling', opts.agentId);
        stopWaiters.get(opts.agentId)?.();
      }, 30_000);

      try {
        const raced = await Promise.race([
          run.wait().then((r) => ({ kind: 'wait' as const, r })),
          endedP.then(() => ({ kind: 'ended' as const })),
          stopP.then(() => ({ kind: 'stop' as const })),
        ]);
        if (raced.kind === 'stop' || stopRequested.has(opts.agentId)) {
          try {
            await Promise.race([run.cancel(), new Promise<void>((r) => setTimeout(r, 10_000))]);
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
            used = mergeUsed(used, labelsOf(conv));
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
          if (customSystemPrompt && isSystemPromptUnsupported(msg)) {
            console.warn('[TecAdRiseBot] system prompt rejected by SDK:', msg);
            systemPromptRejected = true;
          }
          if (isAnthropicPolicyError(msg)) {
            policyBlocked = true;
          }
          if (isCursorStoreError(msg) || policyBlocked) {
            db.updateAgent(opts.agentId, { cursorAgentId: null });
          }
          if (isHttp2CalmError(msg) && !unpackAssistantBody(assembled).answer) {
            throw new Error(msg);
          }
          // Never persist partial reasoning as if it were a valid response.
          assembled = `Error: ${friendlyAgentError(msg)}`;
        }
        if (assembled && !published) publishDone();
      } finally {
        clearInterval(watchdog);
        activeRuns.delete(opts.agentId);
        stopWaiters.delete(opts.agentId);
      }
      return published;
    };

    try {
      let alreadyPublished = await sendOnce(handle);
      if (systemPromptRejected && !stopRequested.has(opts.agentId)) {
        console.warn('[TecAdRiseBot] custom system prompt unavailable, using bounded inline fallback');
        customSystemPrompt = false;
        systemPromptRejected = false;
        handle = await getHandle(agent, apiKey, cwd, undefined, extraDirs, extras?.extraMcp, mcpForTurn);
        assembled = '';
        usage = null;
        alreadyPublished = await sendOnce(handle);
      }
      if (policyBlocked && !stopRequested.has(opts.agentId)) {
        console.warn('[TecAdRiseBot] policy block, retrying once with fresh SDK session', opts.agentId);
        await cancelActive(opts.agentId);
        handle = await getHandle(agent, apiKey, cwd, customSystemPrompt ? hostSystemPrompt : undefined, extraDirs, extras?.extraMcp, mcpForTurn);
        assembled = '';
        usage = null;
        policyBlocked = false;
        alreadyPublished = await sendOnce(handle);
      }
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
        db.patchMessageMeta(assistantMessageId, { ...(usage ? { usage } : {}), used });
        db.updateAgent(opts.agentId, {
          lastSnippet: (unpackAssistantBody(assembled).answer || assembled).slice(0, 120),
        });
      }
    } catch (e) {
      if (stopRequested.has(opts.agentId)) {
        const cur = db.getMessage(assistantMessageId);
        const text = String(cur?.content || assembled || '').trim() || 'Stopped.';
        db.updateMessageContent(assistantMessageId, text);
      } else if (customSystemPrompt && isSystemPromptUnsupported(e)) {
        console.warn('[TecAdRiseBot] custom system prompt unavailable, using bounded inline fallback');
        customSystemPrompt = false;
        handle = await getHandle(agent, apiKey, cwd, undefined, extraDirs, extras?.extraMcp, mcpForTurn);
        assembled = '';
        usage = null;
        systemPromptRejected = false;
        const alreadyPublished = await sendOnce(handle);
        if (!alreadyPublished) {
          if (!assembled) assembled = '(No response text from agent.)';
          db.updateMessageContent(assistantMessageId, assembled);
        }
      } else if (isAnthropicPolicyError(e)) {
        console.warn('[TecAdRiseBot] thrown policy block, retrying once with fresh SDK session', opts.agentId);
        db.updateAgent(opts.agentId, { cursorAgentId: null });
        handle = await getHandle(agent, apiKey, cwd, customSystemPrompt ? hostSystemPrompt : undefined, extraDirs, extras?.extraMcp, mcpForTurn);
        assembled = '';
        usage = null;
        policyBlocked = false;
        const alreadyPublished = await sendOnce(handle);
        if (!alreadyPublished) {
          if (!assembled) assembled = '(No response text from agent.)';
          db.updateMessageContent(assistantMessageId, assembled);
        }
      } else if (assembled.trim() && !isHttp2CalmError(e)) {
        db.updateMessageContent(assistantMessageId, assembled);
      } else if (!isBusyError(e)) {
        throw e;
      } else {
        if (isHttp2CalmError(e)) {
          await new Promise((r) => setTimeout(r, 2000));
        }
        await cancelActive(opts.agentId);
        handle = await getHandle(agent, apiKey, cwd, customSystemPrompt ? hostSystemPrompt : undefined, extraDirs, extras?.extraMcp, mcpForTurn);
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
    await disposeFreshHandle(opts.agentId, cwd);
    liveTurns.delete(opts.agentId);
    wasStopped = stopRequested.has(opts.agentId);
    stopRequested.delete(opts.agentId);
    stopWaiters.delete(opts.agentId);
    const cur = db.getMessage(assistantMessageId);
    const text =
      String(assembled || cur?.content || '').trim() || '(No response text from agent.)';
    if (text && text !== String(cur?.content || '').trim()) {
      db.updateMessageContent(assistantMessageId, text);
    }
    const finishedAt = Date.now();
    db.patchMessageMeta(assistantMessageId, { finishedAt, used });
    const attached = Object.keys(mcpForTurn || {});
    const billed: TokenUsage | null = usage as TokenUsage | null;
    auditTurn({
      agentId: opts.agentId,
      agentName: agent.name,
      source: opts.source,
      attached,
      used,
      inputTokens: billed?.inputTokens,
      outputTokens: billed?.outputTokens,
    });
    emit('chat:stream-done', {
      agentId: opts.agentId,
      messageId: assistantMessageId,
      content: text,
      usage,
      todos,
      used,
      finishedAt,
    });
    if (!opts.deferNotify) {
      maybeNotifyChatDone({
        source: opts.source,
        toastEnabled: readToastEnabled(agent.config),
        agentName: agent.name,
        content: text,
        win: opts.win,
      });
    }
  }

  return {
    userMessageId,
    assistantMessageId,
    stopped: wasStopped,
    stalled,
    failed: /^(Error:|Agent error:)/i.test(String(assembled || '').trim()),
    todos,
    answer: unpackAssistantBody(assembled).answer,
  };
}

function continuePrompt(n: number, r: TurnResult): string {
  const open = (r.todos || []).filter((t) => t.status === 'pending' || t.status === 'inProgress');
  const why = r.stalled
    ? 'A step hung with no output for 15 minutes and was cancelled.'
    : 'The previous turn ended before every todo item was finished.';
  return [
    `[Auto-continue ${n}/${MAX_AUTO_CONTINUE}] ${why}`,
    'Unfinished items:',
    ...open.map((t) => `- ${t.content} (${t.status})`),
    'Do not redo finished work. Continue with the first unfinished item and finish all of them in this turn.',
    'Wrap every browser, network, form send or script step in a hard timeout of about 90 seconds. If a step times out, hits a captcha, or fails twice, record it as failed or assist, skip it, and go on to the next item.',
    'Never end the turn while an item is pending or in progress. Mark each item completed or cancelled with a reason, then give the final one-line result.',
  ].join('\n');
}

export async function runAgentTurn(opts: {
  agentId: string;
  userText: string;
  win: BrowserWindow | null;
  source?: 'user' | 'routine' | 'interbot';
  attachments?: ChatAttachment[];
  extras?: TurnExtras;
}): Promise<{ userMessageId: string; assistantMessageId: string; stopped?: boolean; failed?: boolean }> {
  const first = (await enqueue(opts.agentId, () =>
    runAgentTurnInner({ ...opts, attachments: opts.attachments ?? [], deferNotify: true })
  )) as TurnResult;
  let last = first;
  for (let n = 1; n <= MAX_AUTO_CONTINUE; n++) {
    if (opts.extras?.noAutoContinue) break;
    if (last.stopped || last.failed) break;
    const open = (last.todos || []).filter((t) => t.status === 'pending' || t.status === 'inProgress');
    if (!open.length) break;
    // Chat turns may leave user-action items open on purpose, so only retry them after a hang or an empty reply.
    const unattended = opts.source === 'routine';
    if (!unattended && !last.stalled && last.answer) break;
    if (last.stalled) closeHandle(opts.agentId);
    const cont = last;
    last = (await enqueue(opts.agentId, () =>
      runAgentTurnInner({
        agentId: opts.agentId,
        userText: continuePrompt(n, cont),
        win: opts.win,
        source: opts.source,
        attachments: [],
        seedTodos: cont.todos,
        deferNotify: true,
        extras: opts.extras,
      })
    )) as TurnResult;
  }
  // One toast for the whole job, from the final turn.
  const agent = db.getAgent(opts.agentId);
  const finalText = String(db.getMessage(last.assistantMessageId)?.content || '').trim();
  if (agent && finalText) {
    maybeNotifyChatDone({
      source: opts.source,
      toastEnabled: readToastEnabled(agent.config),
      agentName: agent.name,
      content: finalText,
      win: opts.win,
    });
  }
  // Callers read the reply from the last turn, which holds the final answer and todo state.
  return {
    userMessageId: first.userMessageId,
    assistantMessageId: last.assistantMessageId,
    stopped: last.stopped,
    failed: last.failed,
  };
}
