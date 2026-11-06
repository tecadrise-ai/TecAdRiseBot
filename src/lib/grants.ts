/** Per-agent attach grants. Catalog JSON is not an attach list. */

export type AgentGrants = {
  mcp: string[];
  connectors: string[];
};

export const EMPTY_GRANTS: AgentGrants = { mcp: [], connectors: [] };

/** Connector id → MCP server key when they differ. */
export const CONNECTOR_MCP_NAMES: Record<string, string> = {
  zoho: 'zoho_mail',
};

export function connectorMcpName(connectorId: string): string {
  return CONNECTOR_MCP_NAMES[connectorId] || connectorId;
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((x) => String(x || '').trim()).filter(Boolean))];
}

export function parseGrants(config: Record<string, unknown> | null | undefined): AgentGrants {
  const raw = config?.grants;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY_GRANTS };
  const o = raw as Record<string, unknown>;
  return {
    mcp: stringList(o.mcp),
    connectors: stringList(o.connectors),
  };
}

export function grantsEqual(a: AgentGrants, b: AgentGrants): boolean {
  const same = (x: string[], y: string[]) => x.slice().sort().join('\0') === y.slice().sort().join('\0');
  return same(a.mcp, b.mcp) && same(a.connectors, b.connectors);
}

type ServerMap = Record<string, unknown>;

export function pickGrantedServers<T extends ServerMap>(
  catalog: T,
  connectorServers: T,
  extra: T,
  grants: AgentGrants
): T {
  const out: ServerMap = {};
  for (const [name, server] of Object.entries(catalog)) {
    if (grants.mcp.includes(name)) out[name] = server;
  }
  const allowedConnectorKeys = new Set(grants.connectors.map(connectorMcpName));
  for (const [name, server] of Object.entries(connectorServers)) {
    if (allowedConnectorKeys.has(name) || grants.connectors.includes(name)) out[name] = server;
  }
  return { ...out, ...extra } as T;
}
