import { shell } from 'electron';
import http from 'node:http';
import crypto from 'node:crypto';
import type { McpServers } from '../src/lib/mcpConfig';
import { parseMcpJson } from '../src/lib/mcpConfig';
import * as db from './db';
import { deleteEnvValue, getConnectors, getEnvMap, keepSecret, MASK, setConnectors } from './secrets';
const CANVA_MCP_URL = 'https://mcp.canva.com/mcp';
const TREG_MCP_URL = 'https://treg.to/mcp/';
const AGENTMAIL_MCP_URL = 'https://mcp.agentmail.to/mcp';
const AGENTMAIL_ENV = 'AGENTMAIL_API_KEY';
const CONTEXT_MCP_URL = 'https://mcp.context.dev/mcp';
const CONTEXT_ENV = 'CONTEXT_DEV_API_KEY';
const GITHUB_ENV = 'GITHUB_PERSONAL_ACCESS_TOKEN';
const GITHUB_ENV_ALT = 'GITHUB_TOKEN';
const GLOBAL_MCP_SETTING = 'mcp_servers_json';
const CANVA_RESOURCE = 'https://mcp.canva.com';
const AUTH_META = 'https://mcp.canva.com/.well-known/oauth-authorization-server';
const CALLBACK_PORT = 18766;
const GITHUB_CALLBACK_PORT = 18768;
const GITHUB_SCOPES = 'repo read:user read:org';
const SCOPES = [
  'profile:read',
  'design:meta:read',
  'design:content:write',
  'design:content:read',
  'folder:read',
  'folder:write',
  'brandtemplate:content:read',
  'brandtemplate:meta:read',
  'brandtemplate:content:write',
  'comment:write',
  'comment:read',
  'asset:read',
  'asset:write',
  'brandkit:read',
].join(' ');

type CanvaGrant = {
  clientId: string;
  redirectUri: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenEndpoint: string;
};

export type ZohoGrant = {
  dc: string;
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountsUrl: string;
  mailUrl: string;
  mcpToken: string;
};

export type TregGrant = { token: string; org: string };
export type AgentmailGrant = { apiKey: string };
export type ContextGrant = { apiKey: string };
export type GithubGrant = {
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  token?: string;
};

type Store = {
  canva?: CanvaGrant;
  zoho?: ZohoGrant;
  treg?: TregGrant;
  agentmail?: AgentmailGrant;
  context?: ContextGrant;
  github?: GithubGrant;
};

let connecting: Promise<{ ok: boolean; error?: string }> | null = null;

export function readStore(): Store {
  const v = getConnectors() as Store;
  return v && typeof v === 'object' ? v : {};
}

export function writeStore(next: Store): void {
  setConnectors(next);
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { raw: text };
  } catch {
    return { raw: text };
  }
}

async function authMeta(): Promise<{ authorization: string; token: string; register: string }> {
  const res = await fetch(AUTH_META);
  const j = await readJson(res);
  const authorization = String(j.authorization_endpoint || 'https://mcp.canva.com/authorize');
  const token = String(j.token_endpoint || 'https://mcp.canva.com/token');
  const register = String(j.registration_endpoint || 'https://mcp.canva.com/register');
  return { authorization, token, register };
}

async function registerClient(registerUrl: string, redirectUri: string): Promise<string> {
  const res = await fetch(registerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'TecAdRiseBot',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    }),
  });
  const j = await readJson(res);
  const id = String(j.client_id || '');
  if (!res.ok || !id) {
    throw new Error(String(j.error_description || j.error || j.raw || `Canva register HTTP ${res.status}`));
  }
  return id;
}

function formPost(url: string, body: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  });
}

function waitForCode(
  port: number,
  expectedState: string,
  product = 'Canva'
): Promise<{ code: Promise<string> }> {
  return new Promise((resolveListen, rejectListen) => {
    let settled = false;
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url || '/', `http://127.0.0.1:${port}`);
        if (u.pathname !== '/callback') {
          res.writeHead(404);
          res.end();
          return;
        }
        const err = u.searchParams.get('error');
        const code = u.searchParams.get('code') || '';
        const state = u.searchParams.get('state') || '';
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        if (err) {
          res.end(`<html><body><p>${product} denied access. You can close this tab.</p></body></html>`);
          server.close();
          fail(new Error(err));
          return;
        }
        if (!code || state !== expectedState) {
          res.end('<html><body><p>Bad callback. Close this tab and try Connect again.</p></body></html>');
          server.close();
          fail(new Error(`Bad ${product} callback`));
          return;
        }
        res.end(
          `<html><body><p>${product} connected. You can close this tab and return to TecAdRiseBot.</p></body></html>`
        );
        server.close();
        ok(code);
      } catch (e) {
        try {
          res.writeHead(500);
          res.end();
        } catch {
          /* ignore */
        }
        server.close();
        fail(e instanceof Error ? e : new Error(String(e)));
      }
    });
    let ok: (code: string) => void = () => undefined;
    let fail: (e: Error) => void = () => undefined;
    const code = new Promise<string>((resolve, reject) => {
      ok = (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      fail = (e) => {
        if (settled) return;
        settled = true;
        reject(e);
      };
    });
    server.on('error', (e) => {
      fail(e instanceof Error ? e : new Error(String(e)));
      rejectListen(e);
    });
    server.listen(port, '127.0.0.1', () => resolveListen({ code }));
    setTimeout(() => {
      server.close();
      fail(new Error(`Timed out waiting for ${product}. Click Connect again.`));
    }, 6 * 60 * 1000);
  });
}

async function exchangeCode(opts: {
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  code: string;
  verifier: string;
}): Promise<CanvaGrant> {
  const res = await formPost(opts.tokenEndpoint, {
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.verifier,
    resource: CANVA_RESOURCE,
  });
  const j = await readJson(res);
  const access = String(j.access_token || '');
  const refresh = String(j.refresh_token || '');
  if (!res.ok || !access || !refresh) {
    throw new Error(String(j.error_description || j.error || j.raw || `Canva token HTTP ${res.status}`));
  }
  const expiresIn = Number(j.expires_in) || 3600;
  return {
    clientId: opts.clientId,
    redirectUri: opts.redirectUri,
    accessToken: access,
    refreshToken: refresh,
    expiresAt: Date.now() + expiresIn * 1000,
    tokenEndpoint: opts.tokenEndpoint,
  };
}

async function refreshGrant(g: CanvaGrant): Promise<CanvaGrant> {
  const res = await formPost(g.tokenEndpoint, {
    grant_type: 'refresh_token',
    refresh_token: g.refreshToken,
    client_id: g.clientId,
    resource: CANVA_RESOURCE,
  });
  const j = await readJson(res);
  const access = String(j.access_token || '');
  if (!res.ok || !access) {
    throw new Error(String(j.error_description || j.error || 'Canva refresh failed'));
  }
  const expiresIn = Number(j.expires_in) || 3600;
  return {
    ...g,
    accessToken: access,
    refreshToken: String(j.refresh_token || g.refreshToken),
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

export type ConnectorRow = {
  id: string;
  name: string;
  connected: boolean;
  dc?: string;
  hasClientId?: boolean;
  hasClientSecret?: boolean;
  clientIdMask?: string;
  clientSecretMask?: string;
  hasToken?: boolean;
  org?: string;
};

export function listConnectors(): ConnectorRow[] {
  const s = readStore();
  const zoho = s.zoho;
  const treg = s.treg;
  const agentmail = s.agentmail;
  const context = s.context;
  return [
    { id: 'canva', name: 'Canva', connected: Boolean(s.canva?.refreshToken) },
    {
      id: 'agentmail',
      name: 'AgentMail',
      connected: Boolean(agentmail?.apiKey),
      hasToken: Boolean(agentmail?.apiKey),
    },
    {
      id: 'context',
      name: 'Context.dev',
      connected: Boolean(context?.apiKey),
      hasToken: Boolean(context?.apiKey),
    },
    {
      id: 'github',
      name: 'GitHub',
      connected: Boolean(s.github?.accessToken),
      hasToken: Boolean(s.github?.accessToken || s.github?.token),
      hasClientId: Boolean(s.github?.clientId),
      hasClientSecret: Boolean(s.github?.clientSecret),
    },
    {
      id: 'zoho',
      name: 'Zoho Mail',
      connected: Boolean(zoho?.refreshToken),
      dc: zoho?.dc,
      hasClientId: Boolean(zoho?.clientId),
      hasClientSecret: Boolean(zoho?.clientSecret),
      clientIdMask: zoho?.clientId ? MASK : '',
      clientSecretMask: zoho?.clientSecret ? MASK : '',
    },
    {
      id: 'treg',
      name: 'Treg',
      connected: Boolean(treg?.token),
      hasToken: Boolean(treg?.token),
      org: treg?.org || 'tecadrisebot',
    },
  ].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export async function connectCanva(): Promise<{ ok: boolean; error?: string }> {
  if (connecting) return connecting;
  connecting = (async () => {
    const redirectUri = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
    const meta = await authMeta();
    const clientId = await registerClient(meta.register, redirectUri);
    const { verifier, challenge } = pkce();
    const state = b64url(crypto.randomBytes(16));
    const pending = await waitForCode(CALLBACK_PORT, state);
    const auth = new URL(meta.authorization);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('client_id', clientId);
    auth.searchParams.set('redirect_uri', redirectUri);
    auth.searchParams.set('code_challenge', challenge);
    auth.searchParams.set('code_challenge_method', 'S256');
    auth.searchParams.set('state', state);
    auth.searchParams.set('scope', SCOPES);
    auth.searchParams.set('resource', CANVA_RESOURCE);
    await shell.openExternal(auth.toString());
    const code = await pending.code;
    const grant = await exchangeCode({
      tokenEndpoint: meta.token,
      clientId,
      redirectUri,
      code,
      verifier,
    });
    writeStore({ ...readStore(), canva: grant });
    return { ok: true as const };
  })()
    .catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
    .finally(() => {
      connecting = null;
    });
  return connecting;
}

export function disconnectCanva(): { ok: true } {
  const s = readStore();
  delete s.canva;
  writeStore(s);
  return { ok: true };
}

export function disconnectZoho(): { ok: true } {
  const s = readStore();
  if (s.zoho) {
    s.zoho = {
      ...s.zoho,
      accessToken: '',
      refreshToken: '',
      expiresAt: 0,
      mcpToken: '',
    };
  }
  writeStore(s);
  return { ok: true };
}

function headerVal(h: Record<string, string> | undefined, names: string[]): string {
  if (!h) return '';
  for (const n of names) {
    const hit = Object.entries(h).find(([k]) => k.toLowerCase() === n.toLowerCase());
    if (hit) return String(hit[1] || '');
  }
  return '';
}

function tregTokenFromHeaders(h: Record<string, string> | undefined): string {
  const raw = headerVal(h, ['X-Treg-Token', 'Authorization']);
  return raw.replace(/^Bearer\s+/i, '').trim();
}

function resolveHeaderSecret(raw: string): string {
  const t = String(raw || '').trim();
  const env = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(t);
  if (env) return getEnvMap()[env[1]] || '';
  return t.replace(/^Bearer\s+/i, '').trim();
}

/** Pull a hardcoded treg block out of Common MCP into secrets.bin. */
export function absorbTregFromServers(servers: McpServers): { servers: McpServers; moved: boolean } {
  const entry = servers.treg;
  if (!entry) return { servers, moved: false };
  const token = tregTokenFromHeaders(entry.headers);
  const org = headerVal(entry.headers, ['X-Treg-Org']) || 'tecadrisebot';
  if (token) {
    const cur = readStore();
    const stored = keepSecret(token, cur.treg?.token);
    writeStore({ ...cur, treg: { token: stored || token, org: cur.treg?.org || org } });
  }
  const next = { ...servers };
  delete next.treg;
  return { servers: next, moved: true };
}

export function absorbAgentmailFromServers(servers: McpServers): { servers: McpServers; moved: boolean } {
  const entry = servers.agentmail;
  if (!entry) return { servers, moved: false };
  const fromHeader = resolveHeaderSecret(headerVal(entry.headers, ['x-api-key', 'Authorization']));
  const fromEnv = getEnvMap()[AGENTMAIL_ENV] || '';
  const token = fromHeader || fromEnv;
  if (token) {
    const cur = readStore();
    const stored = keepSecret(token, cur.agentmail?.apiKey);
    writeStore({ ...cur, agentmail: { apiKey: stored || token } });
  }
  const next = { ...servers };
  delete next.agentmail;
  return { servers: next, moved: true };
}

export function absorbContextFromServers(servers: McpServers): { servers: McpServers; moved: boolean } {
  const entry = servers.context || servers['context-dev'];
  if (!entry) return { servers, moved: false };
  const fromHeader = resolveHeaderSecret(headerVal(entry.headers, ['Authorization', 'x-api-key']));
  const fromEnv = getEnvMap()[CONTEXT_ENV] || '';
  const token = fromHeader || fromEnv;
  if (token) {
    const cur = readStore();
    const stored = keepSecret(token, cur.context?.apiKey);
    writeStore({ ...cur, context: { apiKey: stored || token } });
  }
  const next = { ...servers };
  delete next.context;
  delete next['context-dev'];
  return { servers: next, moved: true };
}

export function absorbConnectorMcp(servers: McpServers): { servers: McpServers; notes: string[] } {
  const notes: string[] = [];
  let cur = servers;
  const treg = absorbTregFromServers(cur);
  cur = treg.servers;
  if (treg.moved) notes.push('Treg');
  const mail = absorbAgentmailFromServers(cur);
  cur = mail.servers;
  if (mail.moved) notes.push('AgentMail');
  const ctx = absorbContextFromServers(cur);
  cur = ctx.servers;
  if (ctx.moved) notes.push('Context.dev');
  const gh = absorbGithubFromServers(cur);
  cur = gh.servers;
  if (gh.moved) notes.push('GitHub');
  return { servers: cur, notes };
}

export function absorbGithubFromServers(servers: McpServers): { servers: McpServers; moved: boolean } {
  const entry = servers.github;
  if (!entry) return { servers, moved: false };
  const fromHeader = resolveHeaderSecret(headerVal(entry.headers, ['Authorization']));
  const env = getEnvMap();
  const token = fromHeader || env[GITHUB_ENV] || env[GITHUB_ENV_ALT] || '';
  if (token) {
    const cur = readStore();
    const stored = keepSecret(token, cur.github?.token);
    writeStore({ ...cur, github: { token: stored || token } });
  }
  const next = { ...servers };
  delete next.github;
  return { servers: next, moved: true };
}

export function migrateTregFromMcpJson(): void {
  const raw = db.getSetting(GLOBAL_MCP_SETTING);
  if (raw) {
    const parsed = parseMcpJson(raw);
    if (parsed.ok) {
      const { servers, notes } = absorbConnectorMcp(parsed.servers);
      if (notes.length) db.setSetting(GLOBAL_MCP_SETTING, JSON.stringify(servers));
    }
  }
  const cur = readStore();
  if (!cur.agentmail?.apiKey) {
    const k = getEnvMap()[AGENTMAIL_ENV];
    if (k) writeStore({ ...cur, agentmail: { apiKey: k } });
  }
  if (getEnvMap()[AGENTMAIL_ENV]) deleteEnvValue(AGENTMAIL_ENV);
  const after = readStore();
  if (!after.context?.apiKey) {
    const k = getEnvMap()[CONTEXT_ENV];
    if (k) writeStore({ ...after, context: { apiKey: k } });
  }
  if (getEnvMap()[CONTEXT_ENV]) deleteEnvValue(CONTEXT_ENV);
  const ghStore = readStore();
  if (!ghStore.github?.token) {
    const env = getEnvMap();
    const k = env[GITHUB_ENV] || env[GITHUB_ENV_ALT];
    if (k) writeStore({ ...ghStore, github: { token: k } });
  }
  if (getEnvMap()[GITHUB_ENV]) deleteEnvValue(GITHUB_ENV);
  if (getEnvMap()[GITHUB_ENV_ALT]) deleteEnvValue(GITHUB_ENV_ALT);
}

export function connectTreg(input: { token?: string; org?: string } = {}): { ok: boolean; error?: string } {
  const stored = readStore().treg;
  const token = keepSecret(String(input.token || ''), stored?.token);
  const org = String(input.org || stored?.org || 'tecadrisebot').trim() || 'tecadrisebot';
  if (!token) return { ok: false, error: 'Paste the treg team token, then Connect or Save.' };
  writeStore({ ...readStore(), treg: { token, org } });
  return { ok: true };
}

export function disconnectTreg(): { ok: true } {
  const s = readStore();
  if (s.treg) s.treg = { ...s.treg, token: '' };
  writeStore(s);
  return { ok: true };
}

export function connectAgentmail(input: { apiKey?: string } = {}): { ok: boolean; error?: string } {
  const stored = readStore().agentmail;
  const apiKey = keepSecret(String(input.apiKey || ''), stored?.apiKey);
  if (!apiKey) return { ok: false, error: 'Paste the AgentMail API key, then Connect or Save.' };
  writeStore({ ...readStore(), agentmail: { apiKey } });
  return { ok: true };
}

export function disconnectAgentmail(): { ok: true } {
  const s = readStore();
  if (s.agentmail) s.agentmail = { apiKey: '' };
  writeStore(s);
  return { ok: true };
}

export function connectContext(input: { apiKey?: string } = {}): { ok: boolean; error?: string } {
  const stored = readStore().context;
  const apiKey = keepSecret(String(input.apiKey || ''), stored?.apiKey);
  if (!apiKey) return { ok: false, error: 'Paste the Context.dev API key, then Connect or Save.' };
  writeStore({ ...readStore(), context: { apiKey } });
  return { ok: true };
}

export function disconnectContext(): { ok: true } {
  const s = readStore();
  if (s.context) s.context = { apiKey: '' };
  writeStore(s);
  return { ok: true };
}

function githubAccess(g: GithubGrant | undefined): string {
  return String(g?.accessToken || g?.token || '');
}

export async function connectGithub(
  input: { clientId?: string; clientSecret?: string } = {}
): Promise<{ ok: boolean; error?: string }> {
  if (connecting) return connecting;
  connecting = (async () => {
    const stored = readStore().github;
    const clientId = keepSecret(String(input.clientId || ''), stored?.clientId);
    const clientSecret = keepSecret(String(input.clientSecret || ''), stored?.clientSecret);
    if (!clientId || !clientSecret) {
      throw new Error(
        'Register a GitHub OAuth App at github.com/settings/developers (name it TecAdRiseBot). Callback URL: http://127.0.0.1:18768/callback. Expand GitHub, Save Client ID and Client secret, then Connect. GitHub will ask you to approve TecAdRiseBot.'
      );
    }
    const redirectUri = `http://127.0.0.1:${GITHUB_CALLBACK_PORT}/callback`;
    const state = b64url(crypto.randomBytes(16));
    const pending = await waitForCode(GITHUB_CALLBACK_PORT, state, 'GitHub');
    const auth = new URL('https://github.com/login/oauth/authorize');
    auth.searchParams.set('client_id', clientId);
    auth.searchParams.set('redirect_uri', redirectUri);
    auth.searchParams.set('scope', GITHUB_SCOPES);
    auth.searchParams.set('state', state);
    await shell.openExternal(auth.toString());
    const code = await pending.code;
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    const j = await readJson(res);
    const access = String(j.access_token || '');
    if (!res.ok || !access) {
      throw new Error(String(j.error_description || j.error || j.raw || `GitHub token HTTP ${res.status}`));
    }
    writeStore({
      ...readStore(),
      github: { clientId, clientSecret, accessToken: access, token: '' },
    });
    return { ok: true as const };
  })()
    .catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
    .finally(() => {
      connecting = null;
    });
  return connecting;
}

export function disconnectGithub(): { ok: true } {
  const s = readStore();
  if (s.github) {
    s.github = {
      ...s.github,
      accessToken: '',
      token: '',
    };
  }
  writeStore(s);
  return { ok: true };
}

export function revealConnectorField(id: string, field: string): string {
  const s = readStore();
  let v = '';
  if (id === 'zoho') {
    if (field === 'clientId') v = s.zoho?.clientId || '';
    else if (field === 'clientSecret') v = s.zoho?.clientSecret || '';
  }
  if (id === 'treg') {
    if (field === 'token') v = s.treg?.token || '';
    else if (field === 'org') v = s.treg?.org || '';
  }
  if (id === 'agentmail' && field === 'apiKey') v = s.agentmail?.apiKey || '';
  if (id === 'context' && field === 'apiKey') v = s.context?.apiKey || '';
  if (id === 'github') {
    if (field === 'token') v = githubAccess(s.github);
    else if (field === 'clientId') v = s.github?.clientId || '';
    else if (field === 'clientSecret') v = s.github?.clientSecret || '';
  }
  if (!v.trim() || /^[\s*•]+$/.test(v)) return '';
  return v;
}

function emptyZoho(): ZohoGrant {
  return {
    dc: 'eu',
    clientId: '',
    clientSecret: '',
    accessToken: '',
    refreshToken: '',
    expiresAt: 0,
    accountsUrl: '',
    mailUrl: '',
    mcpToken: '',
  };
}

export function saveConnectorField(
  id: string,
  field: string,
  value: string
): { ok: boolean; error?: string } {
  if (id === 'agentmail') {
    const s = readStore();
    if (field !== 'apiKey') return { ok: false, error: 'Unknown field' };
    const next = keepSecret(value, s.agentmail?.apiKey);
    if (!next) return { ok: false, error: 'Enter an AgentMail API key' };
    s.agentmail = { apiKey: next };
    writeStore(s);
    return { ok: true };
  }
  if (id === 'context') {
    const s = readStore();
    if (field !== 'apiKey') return { ok: false, error: 'Unknown field' };
    const next = keepSecret(value, s.context?.apiKey);
    if (!next) return { ok: false, error: 'Enter a Context.dev API key' };
    s.context = { apiKey: next };
    writeStore(s);
    return { ok: true };
  }
  if (id === 'github') {
    const s = readStore();
    const g: GithubGrant = { ...(s.github || {}) };
    if (field === 'clientId') {
      const next = keepSecret(value, g.clientId);
      if (!next) return { ok: false, error: 'Enter a GitHub Client ID' };
      g.clientId = next;
    } else if (field === 'clientSecret') {
      const next = keepSecret(value, g.clientSecret);
      if (!next) return { ok: false, error: 'Enter a GitHub Client secret' };
      g.clientSecret = next;
    } else if (field === 'token') {
      const next = keepSecret(value, githubAccess(g));
      if (!next) return { ok: false, error: 'Enter a GitHub token' };
      g.token = next;
    } else {
      return { ok: false, error: 'Unknown field' };
    }
    s.github = g;
    writeStore(s);
    return { ok: true };
  }
  if (id === 'treg') {
    const s = readStore();
    const t = { token: s.treg?.token || '', org: s.treg?.org || 'tecadrisebot' };
    if (field === 'org') {
      t.org = String(value || '').trim() || 'tecadrisebot';
    } else if (field === 'token') {
      const next = keepSecret(value, t.token);
      if (!next) return { ok: false, error: 'Enter a treg token' };
      t.token = next;
    } else {
      return { ok: false, error: 'Unknown field' };
    }
    s.treg = t;
    writeStore(s);
    return { ok: true };
  }
  if (id !== 'zoho') return { ok: false, error: 'Unknown connector' };
  const s = readStore();
  const z = s.zoho ? { ...s.zoho } : emptyZoho();
  if (field === 'dc') {
    z.dc = String(value || 'eu');
  } else if (field === 'clientId') {
    const next = keepSecret(value, z.clientId);
    if (!next) return { ok: false, error: 'Enter a Client ID' };
    z.clientId = next;
  } else if (field === 'clientSecret') {
    const next = keepSecret(value, z.clientSecret);
    if (!next) return { ok: false, error: 'Enter a Client secret' };
    z.clientSecret = next;
  } else {
    return { ok: false, error: 'Unknown field' };
  }
  s.zoho = z;
  writeStore(s);
  return { ok: true };
}

export function clearConnectorField(id: string, field: string): { ok: true } {
  const s = readStore();
  if (id === 'zoho' && s.zoho) {
    if (field === 'clientId') s.zoho.clientId = '';
    if (field === 'clientSecret') s.zoho.clientSecret = '';
    if (field === 'all') {
      s.zoho.clientId = '';
      s.zoho.clientSecret = '';
    }
    writeStore(s);
  }
  if (id === 'canva' && field === 'all') {
    delete s.canva;
    writeStore(s);
  }
  if (id === 'agentmail') {
    if (field === 'apiKey' || field === 'all') {
      s.agentmail = { apiKey: '' };
      writeStore(s);
    }
  }
  if (id === 'context') {
    if (field === 'apiKey' || field === 'all') {
      s.context = { apiKey: '' };
      writeStore(s);
    }
  }
  if (id === 'github') {
    const g: GithubGrant = { ...(s.github || {}) };
    if (field === 'token') {
      g.token = '';
      g.accessToken = '';
    }
    if (field === 'clientId') g.clientId = '';
    if (field === 'clientSecret') g.clientSecret = '';
    if (field === 'all') {
      g.token = '';
      g.accessToken = '';
      g.clientId = '';
      g.clientSecret = '';
    }
    s.github = g;
    writeStore(s);
  }
  if (id === 'treg') {
    if (!s.treg) s.treg = { token: '', org: 'tecadrisebot' };
    if (field === 'token') s.treg.token = '';
    if (field === 'org') s.treg.org = 'tecadrisebot';
    if (field === 'all') {
      s.treg.token = '';
      s.treg.org = 'tecadrisebot';
    }
    writeStore(s);
  }
  return { ok: true };
}

async function canvaAccessToken(): Promise<string | null> {
  const s = readStore();
  let g = s.canva;
  if (!g?.refreshToken) return null;
  if (g.accessToken && g.expiresAt > Date.now() + 60_000) return g.accessToken;
  try {
    g = await refreshGrant(g);
    writeStore({ ...readStore(), canva: g });
    return g.accessToken;
  } catch {
    console.warn('[TecAdRiseBot] Canva token refresh failed');
    return g.accessToken || null;
  }
}

/** Global HTTP MCP from Connectors. Tokens stay here, not in MCP JSON. */
export async function connectorMcpServers(): Promise<McpServers> {
  const out: McpServers = {};
  const token = await canvaAccessToken();
  if (token) {
    out.canva = {
      type: 'http',
      url: CANVA_MCP_URL,
      headers: { Authorization: `Bearer ${token}` },
    };
  }
  const { zohoMailMcp } = await import('./zohoMail');
  Object.assign(out, zohoMailMcp());
  const ghTok = githubAccess(readStore().github);
  if (ghTok) {
    out.github = {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: ghTok },
    };
  }
  const ctx = readStore().context;
  if (ctx?.apiKey) {
    out.context = {
      type: 'http',
      url: CONTEXT_MCP_URL,
      headers: { Authorization: `Bearer ${ctx.apiKey}` },
    };
  }
  const mail = readStore().agentmail;
  if (mail?.apiKey) {
    out.agentmail = {
      type: 'http',
      url: AGENTMAIL_MCP_URL,
      headers: { 'x-api-key': mail.apiKey },
    };
  }
  const treg = readStore().treg;
  if (treg?.token) {
    out.treg = {
      type: 'http',
      url: TREG_MCP_URL,
      headers: {
        Authorization: `Bearer ${treg.token}`,
        'X-Treg-Token': treg.token,
        'X-Treg-Org': treg.org || 'tecadrisebot',
      },
    };
  }
  return out;
}
