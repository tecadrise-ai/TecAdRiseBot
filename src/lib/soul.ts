export const DEFAULT_AGENT_SOUL =
  'You are a helpful assistant living in the TecAdRiseBot app.';

export function resolveAgentSoul(raw: string | null | undefined): string {
  const t = String(raw || '').trim();
  if (!t) return DEFAULT_AGENT_SOUL;
  if (/Agentic-first/i.test(t) || /PATCH your own instructions/i.test(t)) {
    return DEFAULT_AGENT_SOUL;
  }
  return t;
}
