/**
 * Minimal MCP server over Streamable HTTP (JSON responses only, no SSE).
 * Transport-agnostic: give it one parsed JSON-RPC message and a tool set.
 */

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<unknown> | unknown;
};

export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

export type JsonRpcReply = Record<string, unknown> | null;

export const MCP_PROTOCOL_VERSION = '2025-03-26';

function ok(id: JsonRpcMessage['id'], result: unknown): JsonRpcReply {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function err(id: JsonRpcMessage['id'], code: number, message: string): JsonRpcReply {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export async function handleMcpMessage(
  msg: JsonRpcMessage,
  server: { name: string; version: string; instructions: string; tools: McpTool[] }
): Promise<JsonRpcReply> {
  const isNotification = msg.id === undefined || msg.id === null;
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
    return isNotification ? null : err(msg?.id, -32600, 'Invalid request');
  }
  switch (msg.method) {
    case 'initialize': {
      const requested = typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '';
      return ok(msg.id, {
        protocolVersion: requested || MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, version: server.version },
        instructions: server.instructions,
      });
    }
    case 'ping':
      return ok(msg.id, {});
    case 'tools/list':
      return ok(msg.id, {
        tools: server.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case 'tools/call': {
      const name = typeof msg.params?.name === 'string' ? msg.params.name : '';
      const tool = server.tools.find((t) => t.name === name);
      if (!tool) return err(msg.id, -32602, `Unknown tool ${name}`);
      const args =
        msg.params?.arguments && typeof msg.params.arguments === 'object' && !Array.isArray(msg.params.arguments)
          ? (msg.params.arguments as Record<string, unknown>)
          : {};
      try {
        const out = await tool.run(args);
        const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
        const isError = !!out && typeof out === 'object' && (out as { state?: string }).state === 'rejected';
        return ok(msg.id, { content: [{ type: 'text', text }], isError });
      } catch (e) {
        return ok(msg.id, {
          content: [{ type: 'text', text: JSON.stringify({ state: 'rejected', error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } }) }],
          isError: true,
        });
      }
    }
    default:
      if (isNotification) return null;
      return err(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export const S = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties: props,
  required,
  additionalProperties: false,
});
export const STR = (description: string) => ({ type: 'string', description });
export const MAP = (description: string) => ({
  type: 'object',
  additionalProperties: { type: 'string' },
  description,
});
