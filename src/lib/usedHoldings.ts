/** Labels for tools / MCP / skills the model actually called this run. */

/** Names of MCP servers this host attaches. New catalog MCP uses its json key. */
const SERVER_LABEL: Record<string, string> = {
  zoho: 'Zoho',
  zoho_mail: 'Zoho',
  playwright: 'Playwright',
  github: 'GitHub',
  canva: 'Canva',
  elevenlabs: 'ElevenLabs',
  agentmail: 'AgentMail',
  context: 'Context',
  treg: 'Treg',
  'tecadrise-host': 'Host',
  'tecadrise-workflows': 'Workflow',
};

const TOOL_LABEL: Record<string, string> = {
  shell: 'Shell',
  grep: 'Grep',
  glob: 'Glob',
  read: 'Read',
  write: 'Write',
  delete: 'Delete',
  edit: 'Edit',
  todowrite: 'Todos',
  updatetodos: 'Todos',
  webbrowser: 'Playwright',
};

const SKIP_NAME =
  /^(thinking-delta|text-delta|usage|turn-ended|assistant|user|system|message|delta|update|item|mcp|tool|function|callmcptool|getmcptools)$/i;

function prettyId(id: string): string {
  return id
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .slice(0, 24);
}

function normalizeId(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/^mcp[_-]/i, '')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function matchAttached(raw: string, attached: readonly string[]): string | null {
  const n = normalizeId(raw);
  if (!n) return null;
  for (const key of attached) {
    const k = normalizeId(key);
    if (!k) continue;
    if (n === k || n.endsWith(`_${k}`) || n.startsWith(`${k}_`)) return key;
  }
  return null;
}

function labelServer(raw: string, attached: readonly string[] = []): string | null {
  const resolved = matchAttached(raw, attached) || raw;
  const key = normalizeId(resolved);
  if (!key || SKIP_NAME.test(key)) return null;
  if (SERVER_LABEL[key]) return SERVER_LABEL[key];
  if (SERVER_LABEL[key.split('_')[0] || '']) return SERVER_LABEL[key.split('_')[0] || ''];
  if (key.length > 40) return null;
  return prettyId(String(resolved).replace(/^mcp[_-]/i, ''));
}

export function labelUsed(rawName: string): string | null {
  const n = String(rawName || '')
    .trim()
    .replace(/^mcp_/i, '');
  if (!n || SKIP_NAME.test(n)) return null;
  const key = n.toLowerCase().replace(/[\s-]+/g, '_');
  if (SERVER_LABEL[key] || TOOL_LABEL[key]) return SERVER_LABEL[key] || TOOL_LABEL[key] || null;
  if (SERVER_LABEL[key.split('_')[0] || '']) return SERVER_LABEL[key.split('_')[0] || ''];
  if (TOOL_LABEL[key.split('_')[0] || '']) return TOOL_LABEL[key.split('_')[0] || ''];
  if (/^browser[_-]/i.test(n) || /playwright/i.test(n)) return 'Playwright';
  if (/workflow|step_current|step_done|review_verdict/i.test(n)) return 'Workflow';
  if (/message_agent|list_peers|list_secret_names|show_connector/i.test(n)) return 'Host';
  if (/todowrite|updatetodos|^todo$/i.test(n)) return 'Todos';
  if (n.length > 40) return null;
  return prettyId(n.replace(/[_-]+/g, ' '));
}

function toolNameOf(rec: Record<string, unknown>): string {
  const fn = rec.function;
  const fnName =
    fn && typeof fn === 'object' && !Array.isArray(fn) ? String((fn as Record<string, unknown>).name || '') : '';
  return String(
    rec.name || rec.toolName || rec.tool || rec.functionName || rec.mcpTool || fnName || ''
  ).trim();
}

function argsOf(rec: Record<string, unknown>): Record<string, unknown> {
  const fn = rec.function;
  const fnArgs =
    fn && typeof fn === 'object' && !Array.isArray(fn)
      ? (fn as Record<string, unknown>).arguments
      : undefined;
  const raw = rec.args ?? rec.arguments ?? rec.input ?? rec.params ?? fnArgs;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

/** Cursor MCP calls carry the attached server as providerIdentifier, not as the inner tool title. */
function serverOf(rec: Record<string, unknown>): string {
  const args = argsOf(rec);
  const nested =
    args.args && typeof args.args === 'object' && !Array.isArray(args.args)
      ? (args.args as Record<string, unknown>)
      : {};
  return String(
    rec.providerIdentifier ||
      rec.mcpServer ||
      rec.serverName ||
      rec.server ||
      rec.namespace ||
      rec.provider ||
      args.providerIdentifier ||
      args.mcpServer ||
      args.serverName ||
      args.server ||
      nested.providerIdentifier ||
      nested.mcpServer ||
      nested.server ||
      ''
  ).trim();
}

function pathOf(raw: unknown): string {
  if (!raw) return '';
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        return pathOf(JSON.parse(t));
      } catch {
        return t;
      }
    }
    return t;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return '';
  const o = raw as Record<string, unknown>;
  return String(o.path || o.target_file || o.targetFile || o.filePath || o.file || o.uri || '').trim();
}

function isToolish(rec: Record<string, unknown>): boolean {
  const t = String(rec.type || '').toLowerCase();
  if (t.includes('tool') || t.includes('function_call') || t === 'mcp') return true;
  if (rec.toolCall || rec.tool_call || rec.mcpServer || rec.providerIdentifier) return true;
  if (toolNameOf(rec) && (rec.args || rec.arguments || rec.input || rec.result || rec.mcpServer)) return true;
  return false;
}

export function skillFromPath(filePath: string): string | null {
  const m = String(filePath || '')
    .replace(/\\/g, '/')
    .match(/\/skills\/([^/]+)/i);
  return m?.[1] && m[1] !== '.' ? m[1] : null;
}

export function labelsFromUnknown(
  delta: unknown,
  depth = 0,
  out = new Set<string>(),
  attached: readonly string[] = []
): string[] {
  if (!delta || depth > 10) return [...out];
  if (Array.isArray(delta)) {
    for (const x of delta) labelsFromUnknown(x, depth + 1, out, attached);
    return [...out];
  }
  if (typeof delta !== 'object') return [...out];
  const rec = delta as Record<string, unknown>;
  if (isToolish(rec)) {
    const nested = rec.toolCall || rec.tool_call;
    const src =
      nested && typeof nested === 'object' && !Array.isArray(nested)
        ? { ...rec, ...(nested as Record<string, unknown>) }
        : rec;
    const server = serverOf(src);
    const name = toolNameOf(src);
    const filePath = pathOf(argsOf(src)) || pathOf(src);
    const serverLabel = server ? labelServer(server, attached) : null;
    if (serverLabel) out.add(serverLabel);
    else {
      const nameLabel = labelUsed(name);
      if (nameLabel) out.add(nameLabel);
    }
    if (filePath) {
      const skill = skillFromPath(filePath);
      if (skill) out.add(skill);
    }
  }
  for (const key of ['update', 'toolCall', 'tool_call', 'call', 'delta', 'item', 'steps', 'message', 'messages']) {
    if (rec[key]) labelsFromUnknown(rec[key], depth + 1, out, attached);
  }
  if (depth < 4) {
    for (const v of Object.values(rec)) {
      if (v && typeof v === 'object') labelsFromUnknown(v, depth + 1, out, attached);
    }
  }
  return [...out];
}

export function mergeUsed(cur: string[], incoming: string[]): string[] {
  const out = [...cur];
  const have = new Set(cur.map((s) => s.toLowerCase()));
  for (const n of incoming) {
    const t = String(n || '').trim();
    if (!t || have.has(t.toLowerCase())) continue;
    have.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

export function parseUsed(meta: string | null | undefined): string[] {
  if (!meta) return [];
  try {
    const o = JSON.parse(meta) as { used?: unknown };
    return Array.isArray(o.used) ? o.used.map((n) => String(n).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function fmtUsed(names: string[] | null | undefined): string {
  if (!names?.length) return '';
  return `[${names.join(', ')}]`;
}
