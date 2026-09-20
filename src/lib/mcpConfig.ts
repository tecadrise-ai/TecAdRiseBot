export type McpServerEntry = {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
};

export type McpServers = Record<string, McpServerEntry>;

export const EMPTY_MCP_JSON = '{\n}\n';

export function mcpJsonFromServers(servers: McpServers | null | undefined): string {
  if (!servers || !Object.keys(servers).length) return EMPTY_MCP_JSON;
  return JSON.stringify(servers, null, 2) + '\n';
}

export function mcpJsonFromConfig(config: Record<string, unknown> | null | undefined): string {
  const raw = config?.mcpServers;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_MCP_JSON;
  return mcpJsonFromServers(raw as McpServers);
}

export function mergeMcpServers(globalServers: McpServers, agentServers: McpServers): McpServers {
  return { ...globalServers, ...agentServers };
}

export function mcpFingerprint(config: Record<string, unknown> | null | undefined): string {
  try {
    return JSON.stringify(config?.mcpServers ?? {});
  } catch {
    return '';
  }
}

function unwrapRoot(v: Record<string, unknown>): Record<string, unknown> {
  if (v.mcpServers && typeof v.mcpServers === 'object' && !Array.isArray(v.mcpServers)) {
    return v.mcpServers as Record<string, unknown>;
  }
  if (v.servers && typeof v.servers === 'object' && !Array.isArray(v.servers)) {
    return v.servers as Record<string, unknown>;
  }
  return v;
}

function asEntry(name: string, raw: unknown): McpServerEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`MCP "${name}" must be an object`);
  }
  const o = raw as Record<string, unknown>;
  const command = typeof o.command === 'string' ? o.command.trim() : '';
  const url = typeof o.url === 'string' ? o.url.trim() : '';
  if (!command && !url) {
    throw new Error(`MCP "${name}" needs "command" (stdio) or "url" (http/sse)`);
  }
  const typeRaw = typeof o.type === 'string' ? o.type.trim().toLowerCase() : '';
  const type =
    typeRaw === 'http' || typeRaw === 'sse' || typeRaw === 'stdio'
      ? (typeRaw as McpServerEntry['type'])
      : url
        ? 'http'
        : 'stdio';
  const entry: McpServerEntry = { type };
  if (command) entry.command = command;
  if (url) entry.url = url;
  if (Array.isArray(o.args)) entry.args = o.args.map((a) => String(a));
  if (typeof o.cwd === 'string' && o.cwd.trim()) entry.cwd = o.cwd.trim();
  if (o.env && typeof o.env === 'object' && !Array.isArray(o.env)) {
    const env: Record<string, string> = {};
    for (const [k, val] of Object.entries(o.env as Record<string, unknown>)) {
      if (val != null) env[k] = String(val);
    }
    entry.env = env;
  }
  if (o.headers && typeof o.headers === 'object' && !Array.isArray(o.headers)) {
    const headers: Record<string, string> = {};
    for (const [k, val] of Object.entries(o.headers as Record<string, unknown>)) {
      if (val != null) headers[k] = String(val);
    }
    entry.headers = headers;
  }
  return entry;
}

export function parseMcpJson(raw: string): { ok: true; servers: McpServers } | { ok: false; error: string } {
  const t = String(raw || '').trim();
  if (!t) return { ok: true, servers: {} };
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid JSON' };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return { ok: false, error: 'JSON must be an object of named MCP servers' };
  }
  const root = unwrapRoot(v as Record<string, unknown>);
  const servers: McpServers = {};
  try {
    for (const [name, entry] of Object.entries(root)) {
      const n = name.trim();
      if (!n) continue;
      servers[n] = asEntry(n, entry);
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, servers };
}
