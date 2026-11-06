import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { McpServerEntry, McpServers } from '../../src/lib/mcpConfig';
import { MCP_PROTOCOL_VERSION } from '../../src/lib/workflow/mcpProtocol';

const HTTP_CONNECT_MS = 12_000;
/** npx GitHub MCP often needs a cold start; 4s skipped it and BYOK had no connector tools. */
const STDIO_CONNECT_MS = 30_000;
const CALL_MS = 45_000;
const TOOL_CAP = 128;
const KEEP_SERVER = /^(tecadrise-host|github|agentmail|zoho)/i;

function connectBudget(entry: McpServerEntry): number {
  return entry.command && !entry.url ? STDIO_CONNECT_MS : HTTP_CONNECT_MS;
}

export type BridgedTool = {
  server: string;
  name: string;
  openaiName: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type Session = {
  server: string;
  call: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  notify?: (method: string, params?: Record<string, unknown>) => void;
  close: () => void;
};

function openaiName(server: string, tool: string): string {
  const raw = `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64);
  return raw || 'tool';
}

function timeout(ms: number, label: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(label)), ms);
  });
}

async function httpCall(
  entry: McpServerEntry,
  method: string,
  params: Record<string, unknown> | undefined,
  id: number,
  ms: number
): Promise<unknown> {
  const url = String(entry.url || '');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(entry.headers || {}),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }),
    signal: AbortSignal.timeout(ms),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 240)}`);
  const trimmed = text.trim();
  if (!trimmed) return {};
  const jsonLine = trimmed.startsWith('data:')
    ? trimmed
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .filter((l) => l && l !== '[DONE]')
        .at(-1) || trimmed
    : trimmed;
  const parsed = JSON.parse(jsonLine) as { result?: unknown; error?: { message?: string } };
  if (parsed.error) throw new Error(parsed.error.message || 'MCP error');
  return parsed.result;
}

function stdioSession(server: string, entry: McpServerEntry): Session {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const isWin = process.platform === 'win32';
  let command = String(entry.command);
  if (isWin && command.toLowerCase() === 'npx') command = 'npx.cmd';
  const ghTok = entry.env?.GITHUB_PERSONAL_ACCESS_TOKEN || entry.env?.GITHUB_TOKEN;
  const child: ChildProcessWithoutNullStreams = spawn(command, entry.args || [], {
    cwd: entry.cwd,
    env: {
      ...process.env,
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      ...(entry.env || {}),
      ...(ghTok ? { GITHUB_PERSONAL_ACCESS_TOKEN: ghTok, GITHUB_TOKEN: ghTok } : {}),
    },
    shell: false,
    windowsHide: true,
  });
  let buf = Buffer.alloc(0);
  child.stdout.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const mark = buf.indexOf('Content-Length:');
      if (mark < 0) {
        if (buf.length > 8192) buf = buf.subarray(buf.length - 128);
        break;
      }
      if (mark > 0) buf = buf.subarray(mark);
      const head = buf.toString('utf8', 0, Math.min(buf.length, 256));
      const m = /Content-Length:\s*(\d+)/i.exec(head);
      if (!m) break;
      const hi = buf.indexOf('\r\n\r\n');
      if (hi < 0) break;
      const len = Number(m[1]);
      const start = hi + 4;
      if (buf.length < start + len) break;
      const body = buf.subarray(start, start + len).toString('utf8');
      buf = buf.subarray(start + len);
      try {
        const msg = JSON.parse(body) as { id?: number; result?: unknown; error?: { message?: string } };
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || 'MCP error'));
          else p.resolve(msg.result);
        }
      } catch {
        /* ignore */
      }
    }
  });
  child.stderr?.on('data', () => undefined);
  const send = (obj: unknown) => {
    const raw = Buffer.from(JSON.stringify(obj), 'utf8');
    child.stdin.write(`Content-Length: ${raw.length}\r\n\r\n`);
    child.stdin.write(raw);
  };
  const notify = (method: string, params?: Record<string, unknown>) => {
    send({ jsonrpc: '2.0', method, params: params || {} });
  };
  const call = (method: string, params?: Record<string, unknown>) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ jsonrpc: '2.0', id, method, params: params || {} });
      const wait = method === 'tools/call' ? CALL_MS : STDIO_CONNECT_MS;
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`MCP timeout ${server} ${method}`));
        }
      }, wait);
    });
  };
  return {
    server,
    call,
    notify,
    close: () => {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

async function connectOne(server: string, entry: McpServerEntry): Promise<{ session: Session; tools: BridgedTool[] }> {
  const budget = connectBudget(entry);
  let call: Session['call'];
  let close: () => void = () => undefined;
  let notify: Session['notify'];
  let session: Session;
  if (entry.url) {
    let n = 1;
    await httpCall(
      entry,
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'tecadrisebot-byok', version: '0.1.5' },
      },
      n++,
      budget
    );
    call = (method, params) => httpCall(entry, method, params, n++, method === 'tools/call' ? CALL_MS : budget);
    session = { server, call, close };
  } else if (entry.command) {
    session = stdioSession(server, entry);
    try {
      await session.call('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'tecadrisebot-byok', version: '0.1.5' },
      });
      session.notify?.('notifications/initialized');
    } catch (e) {
      session.close();
      throw e;
    }
    call = session.call;
    notify = session.notify;
    close = session.close;
  } else {
    throw new Error('skip');
  }

  const listed = (await call('tools/list', {})) as {
    tools?: Array<{ name?: string; description?: string; inputSchema?: Record<string, unknown> }>;
  };
  const tools: BridgedTool[] = [];
  for (const t of listed?.tools || []) {
    if (!t?.name) continue;
    tools.push({
      server,
      name: t.name,
      openaiName: openaiName(server, t.name),
      description: `[${server}] ${t.description || t.name}`.slice(0, 512),
      inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
    });
  }
  return { session: { server, call, notify, close }, tools };
}

function pickTools(tools: BridgedTool[]): BridgedTool[] {
  const first = tools.filter((t) => KEEP_SERVER.test(t.server));
  const rest = tools.filter((t) => !KEEP_SERVER.test(t.server));
  return [...first, ...rest].slice(0, TOOL_CAP);
}

export async function openMcpBridge(servers: McpServers | undefined): Promise<{
  tools: BridgedTool[];
  callTool: (openaiName: string, args: Record<string, unknown>) => Promise<string>;
  close: () => void;
}> {
  const sessions: Session[] = [];
  const tools: BridgedTool[] = [];
  const byOpenai = new Map<string, { server: string; name: string }>();
  const entries = Object.entries(servers || {});
  const settled = await Promise.all(
    entries.map(([server, entry]) =>
      Promise.race([connectOne(server, entry), timeout(connectBudget(entry) + 1_000, `MCP ${server} skipped`)])
        .then((hit) => {
          sessions.push(hit.session);
          for (const t of hit.tools) {
            tools.push(t);
            byOpenai.set(t.openaiName, { server: t.server, name: t.name });
          }
        })
        .catch(() => undefined)
    )
  );
  void settled;

  return {
    tools: pickTools(tools),
    callTool: async (name, args) => {
      const hit = byOpenai.get(name);
      if (!hit) return JSON.stringify({ error: `unknown tool ${name}` });
      const sess = sessions.find((s) => s.server === hit.server);
      if (!sess) return JSON.stringify({ error: `MCP ${hit.server} is down` });
      const result = await sess.call('tools/call', { name: hit.name, arguments: args });
      return typeof result === 'string' ? result : JSON.stringify(result);
    },
    close: () => {
      for (const s of sessions) s.close();
    },
  };
}
