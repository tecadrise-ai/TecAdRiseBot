import { app, BrowserWindow } from 'electron';
import { v4 as uuid } from 'uuid';
import * as db from './db';
import * as secrets from './secrets';
import { listModels as sdkListModels, runAgentTurn, isAgentBusy, cancelAgentRun, dropAgentHandle } from './agentRunner';
import { formatModelLabel, cheapDefaultConfig, shouldRecreateSdkAgent } from '../src/lib/modelOptions';
import { startFromRoutine } from './workflows/service';
import { listConnectors } from './connectors';
import { connectorMcpName, parseGrants } from '../src/lib/grants';

export const DEFAULT_API_PORT = 8787;
export const APP_NAME = 'TecAdRiseBot';

let listenPort = DEFAULT_API_PORT;
let getMainWindow: (() => BrowserWindow | null) | null = null;

export function configureControlPlane(opts: {
  getWindow: () => BrowserWindow | null;
  port?: number;
}): void {
  getMainWindow = opts.getWindow;
  if (opts.port != null) listenPort = opts.port;
}

export function getApiPort(): number {
  return listenPort;
}

export function setApiPort(port: number): void {
  listenPort = port;
}

export function getBaseUrl(): string {
  return `http://127.0.0.1:${listenPort}`;
}

function win(): BrowserWindow | null {
  return getMainWindow?.() ?? null;
}

export type CatalogRoute = {
  method: string;
  path: string;
  summary: string;
  body?: string;
};

export function getCatalog() {
  const base = getBaseUrl();
  const routes: CatalogRoute[] = [
    { method: 'GET', path: '/api', summary: 'This catalog + how to use the control plane' },
    { method: 'GET', path: '/api/health', summary: 'Liveness check' },
    { method: 'GET', path: '/api/agents', summary: 'List all agents' },
    {
      method: 'POST',
      path: '/api/agents',
      summary: 'Create agent',
      body: '{ name, model?, instructions?, config?, enabled? }',
    },
    { method: 'GET', path: '/api/agents/:id', summary: 'Get one agent' },
    {
      method: 'PATCH',
      path: '/api/agents/:id',
      summary: 'Update agent (name, model, instructions, config, enabled)',
      body: 'partial agent fields',
    },
    { method: 'DELETE', path: '/api/agents/:id', summary: 'Delete agent + messages + routines' },
    {
      method: 'GET',
      path: '/api/agents/:id/messages?limit=100&before=',
      summary: 'Read chat history (all roles)',
    },
    {
      method: 'POST',
      path: '/api/agents/:id/messages',
      summary: 'Send chat, await turn, return user+assistant messages',
      body: '{ text }',
    },
    { method: 'GET', path: '/api/agents/:id/status', summary: 'busy | idle run status' },
    { method: 'POST', path: '/api/agents/:id/stop', summary: 'Cancel the in-flight turn' },
    { method: 'GET', path: '/api/agents/:id/snapshot', summary: 'Self-awareness blob for prompts' },
    {
      method: 'POST',
      path: '/api/agents/:id/interbot',
      summary: 'Send inter-bot message from this agent to another',
      body: '{ toAgentId, text }',
    },
    { method: 'GET', path: '/api/routines', summary: 'List routines' },
    {
      method: 'POST',
      path: '/api/routines',
      summary: 'Create routine',
      body: '{ agentId, name, cron, prompt, enabled?, forceTodos?, workflowId? }',
    },
    { method: 'PATCH', path: '/api/routines/:id', summary: 'Update routine', body: 'partial' },
    { method: 'DELETE', path: '/api/routines/:id', summary: 'Delete routine' },
    { method: 'POST', path: '/api/routines/:id/run', summary: 'Run routine now' },
    {
      method: 'GET',
      path: '/api/settings',
      summary: 'Public settings (never includes raw API key)',
    },
    {
      method: 'PATCH',
      path: '/api/settings',
      summary: 'Set non-secret settings',
      body: '{ accountName?, selectedModel?, apiPort? }',
    },
    {
      method: 'POST',
      path: '/api/settings/api-key',
      summary: 'Set Cursor API key (local-only; treat as secret)',
      body: '{ apiKey }',
    },
    {
      method: 'GET',
      path: '/api/secrets',
      summary: 'List API Key names from secrets.bin (no values, no Cursor key)',
    },
    {
      method: 'GET',
      path: '/api/secrets/:name',
      summary: 'Read one secrets.bin value. Host decrypts. Never decrypt the file yourself.',
    },
    { method: 'GET', path: '/api/models', summary: 'List available models' },
    {
      method: 'GET',
      path: '/api/awareness',
      summary: 'Live TecAdRiseBot capability brief (same [App] block agents get each turn)',
    },
  ];

  return {
    app: APP_NAME,
    version: app.getVersion(),
    baseUrl: base,
    bind: '127.0.0.1',
    port: listenPort,
    auth: 'none (localhost only — do not expose this port)',
    features: [
      'multi-agent-chat',
      'cursor-sdk',
      'routines',
      'workflows',
      'interbot',
      'http-control-plane',
      'self-reconfigure',
      'secrets-bin',
      'connectors',
      'mcp',
      'skills',
      'shared-memory',
      'soul',
    ],
    howToUse: {
      listAgents: `curl -s ${base}/api/agents`,
      readHistory: `curl -s "${base}/api/agents/<id>/messages?limit=50"`,
      sendMessage: `curl -s -X POST ${base}/api/agents/<id>/messages -H "Content-Type: application/json" -d '{"text":"Hello"}'`,
      patchInstructions: `curl -s -X PATCH ${base}/api/agents/<id> -H "Content-Type: application/json" -d '{"instructions":"You are..."}'`,
      catalog: `curl -s ${base}/api`,
      awareness: `curl -s ${base}/api/awareness`,
      listSecrets: `curl -s ${base}/api/secrets`,
      getSecret: `curl -s ${base}/api/secrets/<NAME>`,
    },
    routes,
  };
}

export function listAgents() {
  return db.listAgents();
}

export function getAgent(id: string) {
  return db.getAgent(id);
}

export function createAgent(input: {
  name: string;
  model?: string;
  instructions?: string | null;
  config?: Record<string, unknown> | null;
  enabled?: number;
}) {
  const meta = secrets.readMeta();
  return db.createAgent({
    id: uuid(),
    name: (input.name || 'New Agent').trim() || 'New Agent',
    model: input.model ?? meta.selectedModel ?? 'composer-2.5',
    instructions: input.instructions ?? null,
    config: input.config ?? cheapDefaultConfig(),
    enabled: input.enabled ?? 1,
  });
}

export function updateAgent(
  id: string,
  patch: Partial<{
    name: string;
    color: string;
    model: string;
    instructions: string | null;
    config: Record<string, unknown> | null;
    enabled: number;
    cursorAgentId: string | null;
    lastSnippet: string | null;
  }>
) {
  const prev = db.getAgent(id);
  const next = db.updateAgent(id, patch);
  if (prev && shouldRecreateSdkAgent(prev, patch)) dropAgentHandle(id);
  if (prev && patch.cursorAgentId === null && prev.cursorAgentId) dropAgentHandle(id);
  return next;
}

export async function deleteAgent(id: string) {
  await cancelAgentRun(id);
  db.deleteAgent(id);
  return { ok: true };
}

export function listMessages(agentId: string, opts?: { limit?: number; before?: number }) {
  return db.listMessages(agentId, opts);
}

export function getMessage(id: string) {
  return db.getMessage(id);
}

export async function sendChat(
  agentId: string,
  text: string,
  opts?: { source?: 'user' | 'routine' | 'interbot' | 'http' }
) {
  if (isAgentBusy(agentId)) {
    throw new Error('Agent is busy');
  }
  const source = opts?.source === 'http' || !opts?.source ? 'user' : opts.source;
  const ids = await runAgentTurn({
    agentId,
    userText: text,
    win: win(),
    source,
  });
  const user = db.getMessage(ids.userMessageId);
  const assistant = db.getMessage(ids.assistantMessageId);
  return { ...ids, user, assistant };
}

export function getRunStatus(agentId: string) {
  return {
    agentId,
    busy: isAgentBusy(agentId),
    status: isAgentBusy(agentId) ? ('busy' as const) : ('idle' as const),
  };
}

export async function stopAgent(agentId: string) {
  if (!db.getAgent(agentId)) throw new Error('Agent not found');
  await cancelAgentRun(agentId);
  return getRunStatus(agentId);
}

export function listRoutines(agentId?: string) {
  return db.listRoutines(agentId);
}

export function createRoutine(input: {
  agentId: string;
  name: string;
  cron: string;
  prompt: string;
  enabled?: number;
  forceTodos?: number;
  workflowId?: string;
}) {
  if (!db.getAgent(input.agentId)) throw new Error('Agent not found');
  return db.createRoutine({
    id: uuid(),
    agentId: input.agentId,
    name: input.name,
    cron: input.cron,
    prompt: input.prompt,
    enabled: input.enabled,
    forceTodos: input.forceTodos,
    workflowId: input.workflowId,
  });
}

export function updateRoutine(
  id: string,
  patch: Partial<{ name: string; cron: string; prompt: string; enabled: number; forceTodos: number; workflowId: string | null }>
) {
  return db.updateRoutine(id, patch);
}

export function deleteRoutine(id: string) {
  db.deleteRoutine(id);
  return { ok: true };
}

export async function runRoutineNow(id: string) {
  const r = db.getRoutine(id);
  if (!r) throw new Error('Routine not found');
  db.updateRoutine(id, { lastRunAt: Date.now() });
  if (r.workflowId) return startFromRoutine(r);
  return sendChat(r.agentId, db.formatRoutineUserText(r), {
    source: 'routine',
  });
}

export async function sendInterbot(fromId: string, toId: string, text: string) {
  const from = db.getAgent(fromId);
  const to = db.getAgent(toId);
  if (!from || !to) throw new Error('Agent not found');
  const envelope = `Message from agent "${from.name}":\n\n${text}`;
  db.addMessage({
    id: uuid(),
    agentId: fromId,
    role: 'interbot',
    content: `→ ${to.name}: ${text}`,
    meta: JSON.stringify({ toAgentId: toId, direction: 'out' }),
  });
  return sendChat(toId, envelope, { source: 'interbot' });
}

export function getPublicSettings() {
  const meta = secrets.readMeta();
  const storedPort = db.getSetting('api_port');
  return {
    hasApiKey: secrets.hasApiKey(),
    selectedModel: meta.selectedModel ?? 'composer-2.5',
    accountName: meta.accountName ?? 'Local user',
    userDataPath: app.getPath('userData'),
    memoryPath: db.ensureMemoryDir(),
    skillsPath: db.ensureSkillsDir(),
    version: app.getVersion(),
    platform: process.platform,
    apiPort: listenPort,
    apiBaseUrl: getBaseUrl(),
    storedApiPort: storedPort ? Number(storedPort) : null,
  };
}

export function setAccountName(name: string) {
  secrets.writeMeta({ accountName: name.trim() || 'Local user' });
  return getPublicSettings();
}

export function setDefaultModel(model: string, applyToAllAgents = true) {
  secrets.writeMeta({ selectedModel: model });
  if (applyToAllAgents) {
    for (const a of db.listAgents()) {
      db.updateAgent(a.id, { model });
    }
  }
  return getPublicSettings();
}

export function setApiKey(apiKey: string) {
  return secrets.saveApiKey(apiKey.trim());
}

export function clearApiKey() {
  secrets.clearApiKey();
  return { ok: true };
}

export function patchPublicSettings(body: {
  accountName?: string;
  selectedModel?: string;
  apiPort?: number;
  applyModelToAllAgents?: boolean;
}) {
  if (typeof body.accountName === 'string') {
    secrets.writeMeta({ accountName: body.accountName.trim() || 'Local user' });
  }
  if (typeof body.selectedModel === 'string' && body.selectedModel.trim()) {
    setDefaultModel(body.selectedModel.trim(), body.applyModelToAllAgents !== false);
  }
  if (typeof body.apiPort === 'number' && body.apiPort > 0 && body.apiPort < 65536) {
    db.setSetting('api_port', String(body.apiPort));
    // Port change requires restart of HTTP server; caller may restart
  }
  return getPublicSettings();
}

export async function listModels() {
  return sdkListModels();
}

export function listSecrets() {
  return { store: 'secrets.bin' as const, names: secrets.agentSecretNames() };
}

export function getSecret(name: string) {
  return secrets.revealAgentSecret(name);
}

function mcpConfigNames(raw: unknown): string[] {
  if (!raw) return [];
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
  const o = v as Record<string, unknown>;
  const servers =
    o.mcpServers && typeof o.mcpServers === 'object' && !Array.isArray(o.mcpServers)
      ? (o.mcpServers as Record<string, unknown>)
      : o;
  return Object.keys(servers).filter((k) => k && k !== 'mcpServers').sort();
}

export function formatAppAwareness(agentId: string, mcpThisTurn?: string[]): string {
  const agent = db.getAgent(agentId);
  const base = getBaseUrl();
  const settings = getPublicSettings();
  const secretNames = secrets.agentSecretNames();
  const connectors = listConnectors();
  const globalMcp = mcpConfigNames(db.getSetting('mcp_servers_json') || '{}');
  const agentMcp = mcpConfigNames(agent?.config?.mcpServers);
  const grants = parseGrants(agent?.config);
  const grantedCatalog = [...new Set([...globalMcp, ...agentMcp])].filter((n) => grants.mcp.includes(n));
  const grantedConnectors = listConnectors()
    .filter((c) => c.connected && grants.connectors.includes(c.id))
    .map((c) => connectorMcpName(c.id));
  const mcpLive =
    mcpThisTurn != null
      ? mcpThisTurn
      : [...new Set([...grantedCatalog, ...grantedConnectors])].sort();
  const peers = agent ? db.listAgents().filter((a) => a.id !== agentId) : db.listAgents();
  const routines = agent ? db.listRoutines(agentId) : [];
  const connLines = connectors.map((c) => `- ${c.name}: ${c.connected ? 'connected' : 'off'}`).join('\n');
  const secretLine = secretNames.length ? secretNames.map((n) => `- ${n}`).join('\n') : '- (none yet)';
  const mcpLine = mcpLive.length ? mcpLive.map((n) => `- ${n}`).join('\n') : '- (none this turn)';
  const ws = agent ? db.agentWorkspacePath(agentId) : '(no agent)';
  return [
    '[App]',
    'You are an agent inside TecAdRiseBot, a local Windows Electron app on this PC. Turns run through the Cursor SDK. You are not Cursor IDE, not a website, not a hosted bot.',
    'This block is the live capability map. Trust it. Do not rediscover the host. Do not grep the app folder. Do not decrypt secrets.bin. There is no OS env for API keys.',
    '',
    'You can:',
    '- Chat, attachments, Stop, todos (TodoWrite / updateTodos already in this turn)',
    '- Read/write files only in Workspace. Shell/commands on this PC with that cwd',
    '- Soul: PATCH /api/agents/<id> { instructions }. Sticky per-agent rules',
    '- Interbot: POST /api/agents/<id>/interbot { toAgentId, text } (target must be idle)',
    '- Routines, step workflows (Runner/Owner), Skills, shared Memory wiki',
    '- MCP tools listed below (only servers this agent has ticked, plus this-turn workflow tools)',
    '- Secrets: GET /api/secrets  and  GET /api/secrets/<NAME>  (host decrypts secrets.bin)',
    '- Self snapshot: GET /api/agents/<id>/snapshot   Catalog: GET /api',
    '- Create/rename/model/enable agents via the same control plane. One agent, one turn at a time',
    '',
    'You cannot: decrypt secrets.bin; use $env/process.env for those keys; print Cursor API key; write outside Workspace; POST /messages to yourself this turn.',
    '',
    `Live: ${APP_NAME} ${settings.version}  ${settings.platform}  account ${settings.accountName}`,
    `Control plane: ${base}  (127.0.0.1 only, no auth)`,
    agent
      ? `This agent: ${agent.name}  id ${agent.id}  model ${formatModelLabel(agent.model, agent.config)}`
      : 'This agent: (unknown)',
    `Workspace: ${ws}`,
    `Shared memory: ${db.ensureMemoryDir()}  (read index.md first)`,
    `Skills: ${db.ensureSkillsDir()}  (subfolder + SKILL.md)`,
    `Peers: ${peers.length}   Routines: ${routines.length}`,
    '',
    'Settings (global): General, API Keys=secrets.bin, Connectors, MCP, System prompt=SYSTEM.md, Memory=MEMORY.md, Computer=paths, Architecture.',
    'Agent gear: name, color, model, Soul, last-N chat, this-agent MCP JSON, routines, workflows.',
    '',
    'Secrets.bin names (Settings → API Keys). Read value: GET ' + base + '/api/secrets/<NAME>',
    'Use in memory this turn. Never print. Never write to Soul, memory.md, notes, disk, ~/.ssh.',
    secretLine,
    '',
    'Connectors (Settings → Connectors). Connected ones are MCP this turn. Off = human must Connect in the UI.',
    connLines,
    '',
    'MCP this turn (use as tools; do not search the repo to see if they exist):',
    mcpLine,
    globalMcp.length ? `Global MCP JSON names: ${globalMcp.join(', ')}` : 'Global MCP JSON: empty',
    agentMcp.length ? `This-agent MCP JSON names: ${agentMcp.join(', ')}` : 'This-agent MCP JSON: empty',
    '',
    'Quick:',
    `curl -s ${base}/api`,
    `curl -s ${base}/api/awareness`,
    agent ? `curl -s ${base}/api/agents/${agent.id}/snapshot` : `curl -s ${base}/api/agents`,
    `curl -s ${base}/api/secrets`,
    `curl -s ${base}/api/secrets/<NAME>`,
    '[/App]',
  ].join('\n');
}

export type AgentSnapshot = {
  self: {
    id: string;
    name: string;
    model: string;
    instructions: string | null;
    config: Record<string, unknown> | null;
    enabled: number;
    lastSnippet: string | null;
    busy: boolean;
  };
  host: {
    app: string;
    version: string;
    features: string[];
    controlPlaneBaseUrl: string;
    platform: string;
    accountName: string;
  };
  peers: Array<{
    id: string;
    name: string;
    model: string;
    lastSnippet: string | null;
    enabled: number;
  }>;
  routines: Array<{
    id: string;
    name: string;
    cron: string;
    prompt: string;
    enabled: number;
    forceTodos?: number;
    lastRunAt: number | null;
  }>;
  curlExamples: Record<string, string>;
  secrets: { store: string; names: string[] };
  connectors: Array<{ id: string; name: string; connected: boolean }>;
  mcp: { global: string[]; agent: string[] };
};

export function snapshotForAgent(agentId: string): AgentSnapshot {
  const self = db.getAgent(agentId);
  if (!self) throw new Error('Agent not found');
  const base = getBaseUrl();
  const settings = getPublicSettings();
  const catalog = getCatalog();
  return {
    self: {
      id: self.id,
      name: self.name,
      model: self.model,
      instructions: self.instructions,
      config: self.config,
      enabled: self.enabled,
      lastSnippet: self.lastSnippet,
      busy: isAgentBusy(agentId),
    },
    host: {
      app: APP_NAME,
      version: settings.version,
      features: catalog.features,
      controlPlaneBaseUrl: base,
      platform: settings.platform,
      accountName: settings.accountName,
    },
    peers: db
      .listAgents()
      .filter((a) => a.id !== agentId)
      .map((a) => ({
        id: a.id,
        name: a.name,
        model: a.model,
        lastSnippet: a.lastSnippet,
        enabled: a.enabled,
      })),
    routines: db.listRoutines(agentId).map((r) => ({
      id: r.id,
      name: r.name,
      cron: r.cron,
      prompt: r.prompt,
      enabled: r.enabled,
      forceTodos: r.forceTodos,
      lastRunAt: r.lastRunAt,
    })),
    curlExamples: {
      whoAmI: `curl -s ${base}/api/agents/${agentId}`,
      patchSelf: `curl -s -X PATCH ${base}/api/agents/${agentId} -H "Content-Type: application/json" -d '{"instructions":"...","model":"...","name":"..."}'`,
      readHistory: `curl -s "${base}/api/agents/${agentId}/messages?limit=50"`,
      listPeers: `curl -s ${base}/api/agents`,
      messagePeer: `curl -s -X POST ${base}/api/agents/${agentId}/interbot -H "Content-Type: application/json" -d '{"toAgentId":"<peerId>","text":"..."}'`,
      catalog: `curl -s ${base}/api`,
      awareness: `curl -s ${base}/api/awareness?agentId=${agentId}`,
      listSecrets: `curl -s ${base}/api/secrets`,
      getSecret: `curl -s ${base}/api/secrets/<NAME>`,
    },
    secrets: {
      store: 'secrets.bin',
      names: secrets.agentSecretNames(),
    },
    connectors: listConnectors().map((c) => ({ id: c.id, name: c.name, connected: c.connected })),
    mcp: {
      global: mcpConfigNames(db.getSetting('mcp_servers_json') || '{}'),
      agent: mcpConfigNames(self.config?.mcpServers),
    },
  };
}

export function formatRuntimeContext(agentId: string): string {
  const snap = snapshotForAgent(agentId);
  return [
    '[This turn]',
    `You are ${snap.self.name} inside TecAdRiseBot (id ${snap.self.id}).`,
    `Workspace (write files only here): ${db.agentWorkspacePath(agentId)}`,
    'Do not write into the TecAdRiseBot app/repo folder.',
    'Use the todo tool already in this turn (TodoWrite or updateTodos). TodoWrite statuses: pending / in_progress / completed / cancelled. updateTodos: pending / inProgress / completed / cancelled. Use the spelling for the tool you have. Do not search the repo for it.',
    `Model: ${formatModelLabel(snap.self.model, snap.self.config)}`,
    `Peers: ${snap.peers.length}`,
    'Full capability map is [App] this turn. Secrets, connectors, MCP, settings, control plane are listed there. Do not rediscover them.',
    '[/This turn]',
  ].join('\n');
}

export function controlPlaneMarkdown(): string {
  const cat = getCatalog();
  const lines = [
    `# ${APP_NAME} Control Plane`,
    '',
    `Base URL: \`${cat.baseUrl}\``,
    `Bind: \`${cat.bind}:${cat.port}\` (local only, no auth)`,
    '',
    '## How to use',
    '',
    '```bash',
    cat.howToUse.listAgents,
    cat.howToUse.readHistory,
    cat.howToUse.sendMessage,
    cat.howToUse.patchInstructions,
    '```',
    '',
    '## Routes',
    '',
    '| Method | Path | Summary |',
    '| --- | --- | --- |',
    ...cat.routes.map((r) => `| ${r.method} | \`${r.path}\` | ${r.summary} |`),
    '',
    'Never return or log the raw Cursor API key. Use `POST /api/settings/api-key` only when intentionally setting it.',
    '',
  ];
  return lines.join('\n');
}
