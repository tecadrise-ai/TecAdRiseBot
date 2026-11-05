import { shell } from 'electron';
import http from 'node:http';
import crypto from 'node:crypto';
import { getBaseUrl } from './controlPlane';
import { readStore, writeStore, type ZohoGrant } from './connectors';
import { keepSecret } from './secrets';
import {
  handleMcpMessage,
  S,
  STR,
  type JsonRpcMessage,
  type JsonRpcReply,
  type McpTool,
} from '../src/lib/workflow/mcpProtocol';
import type { McpServers } from '../src/lib/mcpConfig';

const CALLBACK_PORT = 18767;
const SCOPES =
  'ZohoMail.accounts.READ,ZohoMail.folders.READ,ZohoMail.messages.READ,ZohoMail.messages.CREATE';
const MCP_NAME = 'zoho_mail';
const MAX_PER_MIN = 30;
const MAX_BODY = 20_000;

export const ZOHO_DCS: Record<string, { accounts: string; mail: string; label: string }> = {
  eu: { accounts: 'https://accounts.zoho.eu', mail: 'https://mail.zoho.eu', label: 'EU (Poland)' },
  com: { accounts: 'https://accounts.zoho.com', mail: 'https://mail.zoho.com', label: 'US (.com)' },
  in: { accounts: 'https://accounts.zoho.in', mail: 'https://mail.zoho.in', label: 'India' },
  au: { accounts: 'https://accounts.zoho.com.au', mail: 'https://mail.zoho.com.au', label: 'Australia' },
  jp: { accounts: 'https://accounts.zoho.jp', mail: 'https://mail.zoho.jp', label: 'Japan' },
  uk: { accounts: 'https://accounts.zoho.uk', mail: 'https://mail.zoho.uk', label: 'UK' },
  ca: { accounts: 'https://accounts.zoho.ca', mail: 'https://mail.zoho.ca', label: 'Canada' },
  sa: { accounts: 'https://accounts.zoho.sa', mail: 'https://mail.zoho.sa', label: 'Saudi Arabia' },
};

export type ZohoConnectInput = {
  dc?: string;
  clientId?: string;
  clientSecret?: string;
  grantCode?: string;
};

const hits: number[] = [];
let connecting: Promise<{ ok: boolean; error?: string }> | null = null;

function dcOf(id: string): { accounts: string; mail: string; label: string } {
  return ZOHO_DCS[id] || ZOHO_DCS.eu;
}

function dcFromAccountsUrl(url: string): string {
  const host = url.toLowerCase();
  if (host.includes('zoho.eu')) return 'eu';
  if (host.includes('zoho.in')) return 'in';
  if (host.includes('zoho.com.au')) return 'au';
  if (host.includes('zoho.jp')) return 'jp';
  if (host.includes('zoho.uk')) return 'uk';
  if (host.includes('zoho.ca')) return 'ca';
  if (host.includes('zoho.sa')) return 'sa';
  return 'com';
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

function formPost(url: string, body: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  });
}

function waitForCode(port: number, expectedState: string): Promise<{
  code: Promise<{ code: string; accountsUrl: string }>;
}> {
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
        const accountsUrl = String(u.searchParams.get('accounts-server') || '').replace(/\/+$/, '');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        if (err) {
          res.end('<html><body><p>Zoho denied access. You can close this tab.</p></body></html>');
          server.close();
          fail(new Error(err));
          return;
        }
        if (!code || state !== expectedState) {
          res.end('<html><body><p>Bad callback. Close this tab and try Connect again.</p></body></html>');
          server.close();
          fail(new Error('Bad Zoho callback'));
          return;
        }
        res.end('<html><body><p>Zoho Mail connected. You can close this tab and return to TecAdRiseBot.</p></body></html>');
        server.close();
        ok({ code, accountsUrl });
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
    let ok: (v: { code: string; accountsUrl: string }) => void = () => undefined;
    let fail: (e: Error) => void = () => undefined;
    const code = new Promise<{ code: string; accountsUrl: string }>((resolve, reject) => {
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
      fail(new Error('Timed out waiting for Zoho. Click Connect again.'));
    }, 6 * 60 * 1000);
  });
}

async function exchange(opts: {
  accountsUrl: string;
  mailUrl: string;
  dc: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri?: string;
}): Promise<ZohoGrant> {
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
  };
  if (opts.redirectUri) body.redirect_uri = opts.redirectUri;
  const res = await formPost(`${opts.accountsUrl}/oauth/v2/token`, body);
  const j = await readJson(res);
  const access = String(j.access_token || '');
  const refresh = String(j.refresh_token || '');
  if (!res.ok || !access || !refresh) {
    throw new Error(
      String(j.error_description || j.error || j.raw || `Zoho token HTTP ${res.status}`) +
        ' Wrong DC (.eu vs .com) or a Self Client from another console is the usual cause.'
    );
  }
  const expiresIn = Number(j.expires_in) || 3600;
  return {
    dc: opts.dc,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    accessToken: access,
    refreshToken: refresh,
    expiresAt: Date.now() + expiresIn * 1000,
    accountsUrl: opts.accountsUrl,
    mailUrl: opts.mailUrl,
    mcpToken: crypto.randomBytes(18).toString('hex'),
  };
}

async function refreshGrant(g: ZohoGrant): Promise<ZohoGrant> {
  const res = await formPost(`${g.accountsUrl}/oauth/v2/token`, {
    grant_type: 'refresh_token',
    refresh_token: g.refreshToken,
    client_id: g.clientId,
    client_secret: g.clientSecret,
  });
  const j = await readJson(res);
  const access = String(j.access_token || '');
  if (!res.ok || !access) {
    throw new Error(String(j.error_description || j.error || 'Zoho refresh failed'));
  }
  const expiresIn = Number(j.expires_in) || 3600;
  return {
    ...g,
    accessToken: access,
    refreshToken: String(j.refresh_token || g.refreshToken),
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

export async function zohoAccessToken(): Promise<string | null> {
  const s = readStore();
  let g = s.zoho;
  if (!g?.refreshToken) return null;
  if (g.accessToken && g.expiresAt > Date.now() + 60_000) return g.accessToken;
  try {
    g = await refreshGrant(g);
    writeStore({ ...readStore(), zoho: g });
    return g.accessToken;
  } catch {
    console.warn('[TecAdRiseBot] Zoho token refresh failed');
    return g.accessToken || null;
  }
}

export function zohoMailMcp(): McpServers {
  const g = readStore().zoho;
  if (!g?.refreshToken || !g.mcpToken) return {};
  return {
    [MCP_NAME]: {
      type: 'http',
      url: `${getBaseUrl()}/mcp/zoho/${g.mcpToken}`,
    },
  };
}

export async function connectZoho(input: ZohoConnectInput = {}): Promise<{ ok: boolean; error?: string }> {
  if (connecting) return connecting;
  connecting = (async () => {
    const stored = readStore().zoho;
    const dcPick = String(input.dc || stored?.dc || 'eu');
    const dc = ZOHO_DCS[dcPick] ? dcPick : 'eu';
    const hosts = dcOf(dc);
    const clientId = keepSecret(String(input.clientId || ''), stored?.clientId);
    const clientSecret = keepSecret(String(input.clientSecret || ''), stored?.clientSecret);
    const grantCode = String(input.grantCode || '').trim();
    if (!clientId || !clientSecret) {
      throw new Error('Zoho Client ID and Client Secret from api-console.zoho.eu (or your DC) are required.');
    }
    let grant: ZohoGrant;
    if (grantCode) {
      grant = await exchange({
        accountsUrl: hosts.accounts,
        mailUrl: hosts.mail,
        dc,
        clientId,
        clientSecret,
        code: grantCode,
      });
    } else {
      const redirectUri = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
      const state = crypto.randomBytes(16).toString('hex');
      const pending = await waitForCode(CALLBACK_PORT, state);
      const auth = new URL(`${hosts.accounts}/oauth/v2/auth`);
      auth.searchParams.set('response_type', 'code');
      auth.searchParams.set('client_id', clientId);
      auth.searchParams.set('redirect_uri', redirectUri);
      auth.searchParams.set('scope', SCOPES);
      auth.searchParams.set('access_type', 'offline');
      auth.searchParams.set('prompt', 'consent');
      auth.searchParams.set('state', state);
      await shell.openExternal(auth.toString());
      const got = await pending.code;
      const accountsUrl = got.accountsUrl || hosts.accounts;
      const gotDc = dcFromAccountsUrl(accountsUrl);
      grant = await exchange({
        accountsUrl,
        mailUrl: dcOf(gotDc).mail,
        dc: gotDc,
        clientId,
        clientSecret,
        code: got.code,
        redirectUri,
      });
    }
    writeStore({ ...readStore(), zoho: grant });
    return { ok: true as const };
  })()
    .catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
    .finally(() => {
      connecting = null;
    });
  return connecting;
}

function rateLimit(): string | null {
  const now = Date.now();
  while (hits.length && hits[0] < now - 60_000) hits.shift();
  if (hits.length >= MAX_PER_MIN) {
    return `Zoho free plan is about ${MAX_PER_MIN} API calls/minute. Wait a minute and retry.`;
  }
  hits.push(now);
  return null;
}

async function zohoCall(method: 'GET' | 'POST', path: string, opts?: { query?: Record<string, string>; json?: Record<string, unknown> }): Promise<unknown> {
  const limited = rateLimit();
  if (limited) return { state: 'rejected', error: { code: 'RATE_LIMIT', message: limited } };
  const s = readStore().zoho;
  const token = await zohoAccessToken();
  if (!s?.mailUrl || !token) return { state: 'rejected', error: { code: 'NOT_CONNECTED', message: 'Zoho Mail is not connected.' } };
  const url = new URL(path.startsWith('/') ? path : `/${path}`, `${s.mailUrl.replace(/\/+$/, '')}/`);
  if (opts?.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v) url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      Accept: 'application/json',
      ...(opts?.json ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts?.json ? JSON.stringify(opts.json) : undefined,
  });
  const j = await readJson(res);
  if (res.status === 401 || res.status === 404) {
    return {
      state: 'rejected',
      error: {
        code: 'ZOHO_HTTP',
        message: `Zoho HTTP ${res.status}. Wrong DC (.com vs .eu), missing CREATE scope, or a Self Client from another console is the usual cause.`,
      },
    };
  }
  if (!res.ok) {
    return { state: 'rejected', error: { code: 'ZOHO_HTTP', message: String(j.error || j.raw || `Zoho HTTP ${res.status}`) } };
  }
  return j;
}

function zohoGet(path: string, query?: Record<string, string>): Promise<unknown> {
  return zohoCall('GET', path, { query });
}

function clip(v: unknown): unknown {
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  if (text.length <= MAX_BODY) return v;
  return `${text.slice(0, MAX_BODY)}\n…[truncated ${text.length - MAX_BODY} chars]`;
}

function tools(): McpTool[] {
  return [
    {
      name: 'zoho_mail_accounts',
      description: 'List Zoho Mail accounts for the connected mailbox. Read-only. Call this first to get accountId.',
      inputSchema: S({}, []),
      run: () => zohoGet('/api/accounts'),
    },
    {
      name: 'zoho_mail_folders',
      description: 'List folders in a Zoho Mail account. Read-only.',
      inputSchema: S({ accountId: STR('From zoho_mail_accounts') }, ['accountId']),
      run: (a) => zohoGet(`/api/accounts/${encodeURIComponent(String(a.accountId))}/folders`),
    },
    {
      name: 'zoho_mail_messages',
      description: 'List messages in a folder. Read-only. Default 20, max 50. Free plan ~30 API calls/minute.',
      inputSchema: S(
        {
          accountId: STR('From zoho_mail_accounts'),
          folderId: STR('From zoho_mail_folders'),
          limit: { type: 'string', description: '1-50, default 20' },
        },
        ['accountId', 'folderId']
      ),
      run: (a) => {
        const n = Math.min(50, Math.max(1, Number(a.limit) || 20));
        return zohoGet(`/api/accounts/${encodeURIComponent(String(a.accountId))}/messages/view`, {
          folderId: String(a.folderId),
          limit: String(n),
        });
      },
    },
    {
      name: 'zoho_mail_message',
      description: 'Get one message body. Read-only. Long bodies are truncated.',
      inputSchema: S(
        {
          accountId: STR('From zoho_mail_accounts'),
          folderId: STR('Folder id of the message'),
          messageId: STR('Message id'),
        },
        ['accountId', 'folderId', 'messageId']
      ),
      run: async (a) =>
        clip(
          await zohoGet(
            `/api/accounts/${encodeURIComponent(String(a.accountId))}/folders/${encodeURIComponent(String(a.folderId))}/messages/${encodeURIComponent(String(a.messageId))}/content`
          )
        ),
    },
    {
      name: 'zoho_mail_send',
      description:
        'Send an email from the connected Zoho mailbox. fromAddress must be that account. Free plan send limits apply. ~30 API calls/minute.',
      inputSchema: S(
        {
          accountId: STR('From zoho_mail_accounts'),
          fromAddress: STR('Sender address on this Zoho account'),
          toAddress: STR('To, comma-separated if several'),
          subject: STR('Subject'),
          content: STR('Body'),
          ccAddress: STR('Optional Cc'),
          bccAddress: STR('Optional Bcc'),
          mailFormat: STR('html or plaintext, default html'),
        },
        ['accountId', 'fromAddress', 'toAddress', 'subject', 'content']
      ),
      run: (a) => {
        const mailFormat = String(a.mailFormat || 'html').toLowerCase() === 'plaintext' ? 'plaintext' : 'html';
        const json: Record<string, unknown> = {
          fromAddress: String(a.fromAddress).trim(),
          toAddress: String(a.toAddress).trim(),
          subject: String(a.subject),
          content: String(a.content),
          mailFormat,
        };
        const cc = String(a.ccAddress || '').trim();
        const bcc = String(a.bccAddress || '').trim();
        if (cc) json.ccAddress = cc;
        if (bcc) json.bccAddress = bcc;
        return zohoCall('POST', `/api/accounts/${encodeURIComponent(String(a.accountId))}/messages`, { json });
      },
    },
  ];
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export async function handleZohoMcp(token: string, body: unknown): Promise<{ replies: JsonRpcReply[] } | null> {
  const g = readStore().zoho;
  if (!g?.mcpToken || !safeEqual(g.mcpToken, token)) return null;
  const server = {
    name: MCP_NAME,
    version: '1.0.0',
    instructions:
      'Zoho Mail: list with zoho_mail_accounts, folders, messages. Send with zoho_mail_send (fromAddress must be the connected mailbox). About 30 calls/minute on the free plan. If HTTP 401/404, wrong DC or missing CREATE scope (Disconnect and Connect again).',
    tools: tools(),
  };
  const batch = Array.isArray(body) ? body : [body];
  const replies: JsonRpcReply[] = [];
  for (const msg of batch) {
    const reply = await handleMcpMessage((msg || {}) as JsonRpcMessage, server);
    if (reply) replies.push(reply);
  }
  return { replies };
}
