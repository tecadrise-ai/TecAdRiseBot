/** Labels for tools / MCP / skills the model actually called this run. */

const DISPLAY: Record<string, string> = {
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

const SKIP_NAME = /^(thinking-delta|text-delta|usage|turn-ended|assistant|user|system|message|delta|update|item)$/i;

function toolNameOf(rec: Record<string, unknown>): string {
  const fn = rec.function;
  const fnName =
    fn && typeof fn === 'object' && !Array.isArray(fn) ? String((fn as Record<string, unknown>).name || '') : '';
  return String(
    rec.name || rec.toolName || rec.tool || rec.functionName || rec.mcpTool || fnName || ''
  ).trim();
}

function serverOf(rec: Record<string, unknown>): string {
  return String(rec.mcpServer || rec.serverName || rec.server || rec.namespace || rec.provider || '').trim();
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

function argsOf(rec: Record<string, unknown>): unknown {
  const fn = rec.function;
  const fnArgs =
    fn && typeof fn === 'object' && !Array.isArray(fn) ? (fn as Record<string, unknown>).arguments : undefined;
  return rec.args ?? rec.arguments ?? rec.input ?? rec.params ?? fnArgs;
}

function isToolish(rec: Record<string, unknown>): boolean {
  const t = String(rec.type || '').toLowerCase();
  if (t.includes('tool') || t.includes('function_call') || t.includes('mcp')) return true;
  if (rec.toolCall || rec.tool_call || rec.mcpServer) return true;
  if (toolNameOf(rec) && (rec.args || rec.arguments || rec.input || rec.result || rec.mcpServer)) return true;
  return false;
}

export function skillFromPath(filePath: string): string | null {
  const m = String(filePath || '').replace(/\\/g, '/').match(/\/skills\/([^/]+)/i);
  return m?.[1] && m[1] !== '.' ? m[1] : null;
}

export function labelUsed(rawName: string): string | null {
  const n = String(rawName || '')
    .trim()
    .replace(/^mcp_/i, '');
  if (!n || SKIP_NAME.test(n)) return null;
  const key = n.toLowerCase().replace(/[\s-]+/g, '_');
  if (DISPLAY[key]) return DISPLAY[key];
  if (DISPLAY[key.split('_')[0] || '']) return DISPLAY[key.split('_')[0] || ''];
  if (/^browser[_-]/i.test(n) || /playwright/i.test(n)) return 'Playwright';
  if (/^zoho/i.test(n)) return 'Zoho';
  if (/github|pull_request/i.test(n)) return 'GitHub';
  if (/workflow|step_current|step_done|review_verdict/i.test(n)) return 'Workflow';
  if (/message_agent|list_peers|list_secret_names|show_connector/i.test(n)) return 'Host';
  if (/todowrite|updatetodos|^todo$/i.test(n)) return 'Todos';
  if (n.length > 40) return null;
  return n
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .slice(0, 24);
}

export function labelsFromUnknown(delta: unknown, depth = 0, out = new Set<string>()): string[] {
  if (!delta || depth > 10) return [...out];
  if (Array.isArray(delta)) {
    for (const x of delta) labelsFromUnknown(x, depth + 1, out);
    return [...out];
  }
  if (typeof delta !== 'object') return [...out];
  const rec = delta as Record<string, unknown>;
  if (isToolish(rec)) {
    const name = toolNameOf(rec);
    const server = serverOf(rec);
    const filePath = pathOf(argsOf(rec)) || pathOf(rec);
    for (const raw of [server, name]) {
      const label = labelUsed(raw);
      if (label) out.add(label);
    }
    if (filePath) {
      const skill = skillFromPath(filePath);
      if (skill) out.add(skill);
    }
  }
  for (const key of ['update', 'toolCall', 'tool_call', 'call', 'delta', 'item', 'steps', 'message', 'messages']) {
    if (rec[key]) labelsFromUnknown(rec[key], depth + 1, out);
  }
  if (depth < 4) {
    for (const v of Object.values(rec)) {
      if (v && typeof v === 'object') labelsFromUnknown(v, depth + 1, out);
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
