export const RUNTIME_CURSOR = 'cursor_sdk';
export const RUNTIME_BYOK = 'byok';
export type AgentRuntime = typeof RUNTIME_CURSOR | typeof RUNTIME_BYOK;

export const BYOK_PRESETS = [
  { name: 'Hugging Face', baseUrl: 'https://router.huggingface.co/v1' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { name: 'Claude', baseUrl: 'https://api.anthropic.com/v1' },
  { name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1' },
] as const;

export const HF_BYOK_NAME = BYOK_PRESETS[0].name;
export const HF_BYOK_URL = BYOK_PRESETS[0].baseUrl;
/** 32k context. Too small for a full host prompt plus MCP tools. */
export const HF_BYOK_MODEL_LEGACY = 'Qwen/Qwen2.5-72B-Instruct';
/** OpenAI-compatible on the HF router; tool calling; ~262k context. */
export const HF_BYOK_MODEL = 'Qwen/Qwen3-Next-80B-A3B-Instruct';

export type ByokProviderPublic = {
  id: string;
  name: string;
  baseUrl: string;
  hasKey: boolean;
  masked: string;
  /** Comma-separated model ids for the agent dropdown. */
  models: string;
};

export function parseByokModels(raw: string | null | undefined): string[] {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Agent dropdown and runner: only ids from Settings → BYOK (secrets.bin). */
export function pickByokModelId(saved: string | null | undefined, modelsRaw: string | null | undefined): string {
  const ids = parseByokModels(modelsRaw);
  const id = String(saved || '').trim();
  if (id && ids.includes(id)) return id;
  return ids[0] || '';
}

export function readAgentRuntime(config: Record<string, unknown> | null | undefined): AgentRuntime {
  const raw = String(config?.runtime || '').trim();
  return raw === RUNTIME_BYOK ? RUNTIME_BYOK : RUNTIME_CURSOR;
}

export function readByokProviderId(config: Record<string, unknown> | null | undefined): string {
  return String(config?.byokProviderId || '').trim();
}

export function readByokModelId(config: Record<string, unknown> | null | undefined): string {
  return String(config?.byokModelId || '').trim();
}

export function normalizeBaseUrl(url: string): string {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '');
}

/** NVIDIA NIM's OpenAI gateway resets Node HTTP/2 streaming (`fetch failed`). Use JSON responses. */
export function byokUsesStream(baseUrl: string): boolean {
  try {
    return !/(^|\.)nvidia\.com$/i.test(new URL(normalizeBaseUrl(baseUrl)).hostname);
  } catch {
    return true;
  }
}

/** When an agent is BYOK, Runner and Owner both use this provider/model. */
export function byokRoleFromConfig(
  config: Record<string, unknown> | null | undefined
): { runtime: typeof RUNTIME_BYOK; byokProviderId: string; byokModelId: string } | null {
  if (readAgentRuntime(config) !== RUNTIME_BYOK) return null;
  return {
    runtime: RUNTIME_BYOK,
    byokProviderId: readByokProviderId(config),
    byokModelId: readByokModelId(config),
  };
}
