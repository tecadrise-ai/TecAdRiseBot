import { app, safeStorage, shell } from 'electron';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { McpServers } from '../src/lib/mcpConfig';

const FILE = 'connectors.bin';
const CANVA_MCP_URL = 'https://mcp.canva.com/mcp';
const CANVA_RESOURCE = 'https://mcp.canva.com';
const AUTH_META = 'https://mcp.canva.com/.well-known/oauth-authorization-server';
const CALLBACK_PORT = 18766;
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

type Store = { canva?: CanvaGrant };

let connecting: Promise<{ ok: boolean; error?: string }> | null = null;

function storePath(): string {
  return path.join(app.getPath('userData'), FILE);
}

function readStore(): Store {
  try {
    if (!fs.existsSync(storePath())) return {};
    const buf = fs.readFileSync(storePath());
    const asText = buf.toString('utf8');
    let json: string;
    if (asText.startsWith('plain:')) {
      json = Buffer.from(asText.slice(6), 'base64').toString('utf8');
    } else if (safeStorage.isEncryptionAvailable()) {
      json = safeStorage.decryptString(buf);
    } else {
      return {};
    }
    const v = JSON.parse(json) as Store;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function writeStore(next: Store): void {
  const json = JSON.stringify(next);
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(storePath(), safeStorage.encryptString(json));
    return;
  }
  fs.writeFileSync(storePath(), Buffer.from(`plain:${Buffer.from(json, 'utf8').toString('base64')}`, 'utf8'));
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

function waitForCode(port: number, expectedState: string): Promise<{ code: Promise<string> }> {
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
          res.end('<html><body><p>Canva denied access. You can close this tab.</p></body></html>');
          server.close();
          fail(new Error(err));
          return;
        }
        if (!code || state !== expectedState) {
          res.end('<html><body><p>Bad callback. Close this tab and try Connect again.</p></body></html>');
          server.close();
          fail(new Error('Bad Canva callback'));
          return;
        }
        res.end('<html><body><p>Canva connected. You can close this tab and return to TecAdRiseBot.</p></body></html>');
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
      fail(new Error('Timed out waiting for Canva. Click Connect again.'));
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

export function listConnectors(): Array<{ id: string; name: string; connected: boolean }> {
  const s = readStore();
  return [{ id: 'canva', name: 'Canva', connected: Boolean(s.canva?.refreshToken) }];
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
  const token = await canvaAccessToken();
  if (!token) return {};
  return {
    canva: {
      type: 'http',
      url: CANVA_MCP_URL,
      headers: { Authorization: `Bearer ${token}` },
    },
  };
}
