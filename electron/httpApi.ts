import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import * as cp from './controlPlane';

let server: http.Server | null = null;
let boundPort = 0;

type Json = unknown;

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function parseJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    throw new Error('JSON body must be an object');
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : 'Invalid JSON');
  }
}

function send(res: ServerResponse, status: number, body: Json): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function notFound(res: ServerResponse): void {
  send(res, 404, { error: 'Not found' });
}

function badRequest(res: ServerResponse, message: string): void {
  send(res, 400, { error: message });
}

function match(
  method: string,
  pathname: string,
  wantMethod: string,
  pattern: string
): Record<string, string> | null {
  if (method !== wantMethod) return null;
  const pParts = pattern.split('/').filter(Boolean);
  const aParts = pathname.split('/').filter(Boolean);
  if (pParts.length !== aParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pParts.length; i++) {
    const pp = pParts[i];
    const ap = aParts[i];
    if (pp.startsWith(':')) params[pp.slice(1)] = decodeURIComponent(ap);
    else if (pp !== ap) return null;
  }
  return params;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const host = req.headers.host || `127.0.0.1:${boundPort || cp.getApiPort()}`;
  const url = new URL(req.url || '/', `http://${host}`);
  const method = (req.method || 'GET').toUpperCase();
  const path = url.pathname.replace(/\/+$/, '') || '/';

  try {
    if (method === 'GET' && (path === '/api' || path === '/')) {
      send(res, 200, cp.getCatalog());
      return;
    }
    if (method === 'GET' && path === '/api/health') {
      send(res, 200, { ok: true, app: cp.APP_NAME, port: cp.getApiPort() });
      return;
    }

    if (method === 'GET' && path === '/api/agents') {
      send(res, 200, { agents: cp.listAgents() });
      return;
    }

    {
      const m = match(method, path, 'POST', '/api/agents');
      if (m) {
        const body = await parseJson(req);
        if (typeof body.name !== 'string' || !body.name.trim()) {
          badRequest(res, 'name is required');
          return;
        }
        const agent = cp.createAgent({
          name: body.name,
          model: typeof body.model === 'string' ? body.model : undefined,
          instructions: typeof body.instructions === 'string' ? body.instructions : null,
          config:
            body.config && typeof body.config === 'object' && !Array.isArray(body.config)
              ? (body.config as Record<string, unknown>)
              : null,
          enabled: typeof body.enabled === 'number' ? body.enabled : undefined,
        });
        send(res, 201, { agent });
        return;
      }
    }

    {
      const m = match(method, path, 'GET', '/api/agents/:id');
      if (m) {
        const agent = cp.getAgent(m.id);
        if (!agent) {
          send(res, 404, { error: 'Agent not found' });
          return;
        }
        send(res, 200, { agent, status: cp.getRunStatus(m.id) });
        return;
      }
    }

    {
      const m = match(method, path, 'PATCH', '/api/agents/:id');
      if (m) {
        const body = await parseJson(req);
        const patch: Parameters<typeof cp.updateAgent>[1] = {};
        if (typeof body.name === 'string') patch.name = body.name;
        if (typeof body.color === 'string') patch.color = body.color;
        if (typeof body.model === 'string') patch.model = body.model;
        if (body.instructions === null || typeof body.instructions === 'string') {
          patch.instructions = body.instructions as string | null;
        }
        if (body.config === null) patch.config = null;
        else if (body.config && typeof body.config === 'object' && !Array.isArray(body.config)) {
          patch.config = body.config as Record<string, unknown>;
        }
        if (typeof body.enabled === 'number') patch.enabled = body.enabled;
        const agent = cp.updateAgent(m.id, patch);
        if (!agent) {
          send(res, 404, { error: 'Agent not found' });
          return;
        }
        send(res, 200, { agent });
        return;
      }
    }

    {
      const m = match(method, path, 'DELETE', '/api/agents/:id');
      if (m) {
        if (!cp.getAgent(m.id)) {
          send(res, 404, { error: 'Agent not found' });
          return;
        }
        send(res, 200, await cp.deleteAgent(m.id));
        return;
      }
    }

    {
      const m = match(method, path, 'GET', '/api/agents/:id/messages');
      if (m) {
        if (!cp.getAgent(m.id)) {
          send(res, 404, { error: 'Agent not found' });
          return;
        }
        const limit = Number(url.searchParams.get('limit') || 100);
        const beforeRaw = url.searchParams.get('before');
        const before = beforeRaw ? Number(beforeRaw) : undefined;
        const messages = cp.listMessages(m.id, {
          limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 1000) : 100,
          before: before != null && Number.isFinite(before) ? before : undefined,
        });
        send(res, 200, { agentId: m.id, messages, count: messages.length });
        return;
      }
    }

    {
      const m = match(method, path, 'POST', '/api/agents/:id/messages');
      if (m) {
        if (!cp.getAgent(m.id)) {
          send(res, 404, { error: 'Agent not found' });
          return;
        }
        const body = await parseJson(req);
        const text = typeof body.text === 'string' ? body.text : '';
        if (!text.trim()) {
          badRequest(res, 'text is required');
          return;
        }
        if (cp.getRunStatus(m.id).busy) {
          send(res, 409, { error: 'Agent is busy' });
          return;
        }
        try {
          const result = await cp.sendChat(m.id, text, { source: 'http' });
          send(res, 200, result);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes('busy')) {
            send(res, 409, { error: 'Agent is busy' });
            return;
          }
          send(res, 500, { error: msg });
        }
        return;
      }
    }

    {
      const m = match(method, path, 'GET', '/api/agents/:id/status');
      if (m) {
        if (!cp.getAgent(m.id)) {
          send(res, 404, { error: 'Agent not found' });
          return;
        }
        send(res, 200, cp.getRunStatus(m.id));
        return;
      }
    }

    {
      const m = match(method, path, 'GET', '/api/agents/:id/snapshot');
      if (m) {
        try {
          send(res, 200, cp.snapshotForAgent(m.id));
        } catch {
          send(res, 404, { error: 'Agent not found' });
        }
        return;
      }
    }

    {
      const m = match(method, path, 'POST', '/api/agents/:id/interbot');
      if (m) {
        const body = await parseJson(req);
        const toAgentId = typeof body.toAgentId === 'string' ? body.toAgentId : '';
        const text = typeof body.text === 'string' ? body.text : '';
        if (!toAgentId || !text.trim()) {
          badRequest(res, 'toAgentId and text are required');
          return;
        }
        try {
          const result = await cp.sendInterbot(m.id, toAgentId, text);
          send(res, 200, result);
        } catch (e) {
          send(res, 404, { error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
    }

    if (method === 'GET' && path === '/api/routines') {
      const agentId = url.searchParams.get('agentId') || undefined;
      send(res, 200, { routines: cp.listRoutines(agentId || undefined) });
      return;
    }

    if (method === 'POST' && path === '/api/routines') {
      const body = await parseJson(req);
      if (
        typeof body.agentId !== 'string' ||
        typeof body.name !== 'string' ||
        typeof body.cron !== 'string' ||
        typeof body.prompt !== 'string'
      ) {
        badRequest(res, 'agentId, name, cron, prompt are required');
        return;
      }
      try {
        const routine = cp.createRoutine({
          agentId: body.agentId,
          name: body.name,
          cron: body.cron,
          prompt: body.prompt,
          enabled: typeof body.enabled === 'number' ? body.enabled : undefined,
        });
        send(res, 201, { routine });
      } catch (e) {
        send(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }

    {
      const m = match(method, path, 'PATCH', '/api/routines/:id');
      if (m) {
        const body = await parseJson(req);
        const patch: Parameters<typeof cp.updateRoutine>[1] = {};
        if (typeof body.name === 'string') patch.name = body.name;
        if (typeof body.cron === 'string') patch.cron = body.cron;
        if (typeof body.prompt === 'string') patch.prompt = body.prompt;
        if (typeof body.enabled === 'number') patch.enabled = body.enabled;
        const routine = cp.updateRoutine(m.id, patch);
        if (!routine) {
          send(res, 404, { error: 'Routine not found' });
          return;
        }
        send(res, 200, { routine });
        return;
      }
    }

    {
      const m = match(method, path, 'DELETE', '/api/routines/:id');
      if (m) {
        const existing = cp.listRoutines().find((r) => r.id === m.id);
        if (!existing) {
          send(res, 404, { error: 'Routine not found' });
          return;
        }
        send(res, 200, cp.deleteRoutine(m.id));
        return;
      }
    }

    {
      const m = match(method, path, 'POST', '/api/routines/:id/run');
      if (m) {
        try {
          const result = await cp.runRoutineNow(m.id);
          send(res, 200, result);
        } catch (e) {
          send(res, 404, { error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
    }

    if (method === 'GET' && path === '/api/settings') {
      send(res, 200, cp.getPublicSettings());
      return;
    }

    if (method === 'PATCH' && path === '/api/settings') {
      const body = await parseJson(req);
      const settings = cp.patchPublicSettings({
        accountName: typeof body.accountName === 'string' ? body.accountName : undefined,
        selectedModel: typeof body.selectedModel === 'string' ? body.selectedModel : undefined,
        apiPort: typeof body.apiPort === 'number' ? body.apiPort : undefined,
        applyModelToAllAgents:
          typeof body.applyModelToAllAgents === 'boolean' ? body.applyModelToAllAgents : undefined,
      });
      send(res, 200, {
        settings,
        note:
          typeof body.apiPort === 'number'
            ? 'apiPort stored; restart the app (or HTTP server) for a new listen port to take effect'
            : undefined,
      });
      return;
    }

    if (method === 'POST' && path === '/api/settings/api-key') {
      const body = await parseJson(req);
      if (typeof body.apiKey !== 'string' || !body.apiKey.trim()) {
        badRequest(res, 'apiKey is required');
        return;
      }
      const result = cp.setApiKey(body.apiKey);
      send(res, result.ok ? 200 : 500, {
        ...result,
        warning:
          'API key stored locally via Electron safeStorage. Never commit or share this value. GET /api/settings never returns the raw key.',
      });
      return;
    }

    if (method === 'GET' && path === '/api/models') {
      const models = await cp.listModels();
      send(res, 200, { models });
      return;
    }

    notFound(res);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'Request body too large') {
      send(res, 413, { error: msg });
      return;
    }
    console.error('httpApi error', e);
    send(res, 500, { error: msg });
  }
}

export type HttpApiInfo = { port: number; baseUrl: string };

export function startHttpApi(preferredPort?: number): Promise<HttpApiInfo> {
  return new Promise((resolve, reject) => {
    if (server) {
      resolve({ port: boundPort, baseUrl: cp.getBaseUrl() });
      return;
    }

    const port = preferredPort ?? cp.getApiPort();
    cp.setApiPort(port);

    const s = http.createServer((req, res) => {
      void handle(req, res);
    });

    s.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && preferredPort == null) {
        // Try next ports
        s.close();
        server = null;
        const next = port + 1;
        if (next > port + 20) {
          reject(err);
          return;
        }
        startHttpApi(next).then(resolve, reject);
        return;
      }
      reject(err);
    });

    s.listen(port, '127.0.0.1', () => {
      server = s;
      const addr = s.address();
      boundPort = typeof addr === 'object' && addr ? addr.port : port;
      cp.setApiPort(boundPort);
      console.log(`[TecAdRiseBot] Control plane listening on ${cp.getBaseUrl()}`);
      resolve({ port: boundPort, baseUrl: cp.getBaseUrl() });
    });
  });
}

export function stopHttpApi(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => {
      server = null;
      boundPort = 0;
      resolve();
    });
  });
}

export function getHttpApiInfo(): HttpApiInfo | null {
  if (!server || !boundPort) return null;
  return { port: boundPort, baseUrl: `http://127.0.0.1:${boundPort}` };
}
