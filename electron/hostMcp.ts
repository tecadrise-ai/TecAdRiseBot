import { BrowserWindow } from 'electron';
import crypto from 'node:crypto';
import * as db from './db';
import * as secrets from './secrets';
import { listConnectors } from './connectors';
import { isSmallTalk } from '../src/lib/mcpAttach';
import {
  handleMcpMessage,
  S,
  STR,
  type JsonRpcMessage,
  type JsonRpcReply,
  type McpTool,
} from '../src/lib/workflow/mcpProtocol';
import type { McpServers } from '../src/lib/mcpConfig';

export const HOST_MCP_NAME = 'tecadrise-host';

type HostPlane = {
  getBaseUrl: () => string;
  isAgentBusy: (id: string) => boolean;
  sendInterbot: (fromId: string, toId: string, text: string) => Promise<unknown>;
};

let plane: HostPlane = {
  getBaseUrl: () => 'http://127.0.0.1:8787',
  isAgentBusy: () => false,
  sendInterbot: async () => {
    throw new Error('host MCP not configured');
  },
};
const tokens = new Map<string, string>();

export function configureHostMcp(opts: HostPlane): void {
  plane = opts;
}

function hostToken(agentId: string): string {
  let t = tokens.get(agentId);
  if (!t) {
    t = crypto.randomBytes(18).toString('hex');
    tokens.set(agentId, t);
  }
  return t;
}

function emitUi(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    try {
      w.webContents.send(channel, payload);
    } catch {
      /* ignore */
    }
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function hostMcpExtras(agentId: string, userText: string): { extraMcp: McpServers } | null {
  if (isSmallTalk(userText)) return null;
  return {
    extraMcp: {
      [HOST_MCP_NAME]: {
        type: 'http',
        url: `${plane.getBaseUrl()}/mcp/host/${agentId}/${hostToken(agentId)}`,
      },
    },
  };
}

function tools(fromAgentId: string): McpTool[] {
  return [
    {
      name: 'list_peers',
      description: 'Other TecAdRiseBot agents on this PC (id and name). Use before message_agent.',
      inputSchema: S({}),
      run: () =>
        db
          .listAgents()
          .filter((a) => a.id !== fromAgentId && a.enabled)
          .map((a) => ({ id: a.id, name: a.name })),
    },
    {
      name: 'message_agent',
      description:
        'Send a message to another idle agent. You keep this turn. Do not curl the control plane.',
      inputSchema: S({ toAgentId: STR('Peer id from list_peers'), text: STR('Message body') }, [
        'toAgentId',
        'text',
      ]),
      run: async (args) => {
        const toAgentId = String(args.toAgentId || '').trim();
        const text = String(args.text || '').trim();
        if (!toAgentId || !text) return { ok: false, error: 'toAgentId and text are required' };
        if (toAgentId === fromAgentId) return { ok: false, error: 'Cannot message yourself' };
        if (plane.isAgentBusy(toAgentId)) return { ok: false, error: 'Target agent is busy' };
        await plane.sendInterbot(fromAgentId, toAgentId, text);
        const to = db.getAgent(toAgentId);
        return { ok: true, to: to?.name || toAgentId };
      },
    },
    {
      name: 'list_secret_names',
      description:
        'Names stored in secrets.bin. Values stay in the host. Use ${env:NAME} in MCP JSON. Never print values.',
      inputSchema: S({}),
      run: () => ({ store: 'secrets.bin', names: secrets.agentSecretNames() }),
    },
    {
      name: 'show_connector',
      description: 'Connector account state. Chris connects apps in Settings → Connectors. No secret values.',
      inputSchema: S({ id: STR('Optional connector id, e.g. github or zoho') }),
      run: (args) => {
        const rows = listConnectors().map((c) => ({
          id: c.id,
          name: c.name,
          connected: c.connected,
          state: c.connected ? ('ready' as const) : ('not_connected' as const),
          action: c.connected ? 'ready' : 'Chris connects this in Settings → Connectors',
        }));
        const id = String(args.id || '').trim().toLowerCase();
        if (!id) return rows;
        const hit = rows.find((r) => r.id === id);
        if (!hit) return { error: `Unknown connector ${id}`, connectors: rows };
        if (!hit.connected) emitUi('ui:show-connector', { id: hit.id, name: hit.name });
        return hit;
      },
    },
  ];
}

export async function handleHostMcp(
  agentId: string,
  token: string,
  body: unknown
): Promise<{ replies: JsonRpcReply[] } | null> {
  if (!db.getAgent(agentId) || !safeEqual(hostToken(agentId), token)) return null;
  const server = {
    name: HOST_MCP_NAME,
    version: '1.0.0',
    instructions:
      'TecAdRiseBot host tools. Secret values are never returned. Interbot uses message_agent, not curl.',
    tools: tools(agentId),
  };
  const batch = Array.isArray(body) ? body : [body];
  const replies: JsonRpcReply[] = [];
  for (const msg of batch) {
    const reply = await handleMcpMessage((msg || {}) as JsonRpcMessage, server);
    if (reply) replies.push(reply);
  }
  return { replies };
}
