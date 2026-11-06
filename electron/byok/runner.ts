import { addUsage, type TokenUsage } from '../../src/lib/usage';
import { byokUsesStream, normalizeBaseUrl, pickByokModelId } from '../../src/lib/byok';
import { getByokProvider } from '../secrets';
import { openMcpBridge, type BridgedTool } from './mcpBridge';
import { byokPost, formatByokFetchError, isByokRetryable } from './http';
import type { McpServers } from '../../src/lib/mcpConfig';

const MAX_ROUNDS = 24;
const FETCH_MS = 90_000;
const FETCH_TRIES = 3;
const aborts = new Map<string, AbortController>();

export function abortByokTurn(agentId: string): void {
  const c = aborts.get(agentId);
  if (c) c.abort();
}

type ChatMsg = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | Array<Record<string, unknown>>;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
};

type ToolAcc = { id: string; name: string; args: string };

function toolsForOpenAI(tools: BridgedTool[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.openaiName,
      description: t.description,
      parameters: t.inputSchema?.type ? t.inputSchema : { type: 'object', properties: {} },
    },
  }));
}

function usageFrom(raw: unknown): TokenUsage | null {
  const u = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!u) return null;
  return addUsage(null, {
    inputTokens: Number(u.prompt_tokens) || 0,
    outputTokens: Number(u.completion_tokens) || 0,
  });
}

function userContent(text: string, images: Array<{ data: string; mimeType: string }>): ChatMsg {
  if (!images.length) return { role: 'user', content: text };
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...images.map((img) => ({
        type: 'image_url',
        image_url: { url: `data:${img.mimeType};base64,${img.data}` },
      })),
    ],
  };
}

function linkAbort(a: AbortSignal, b: AbortSignal): AbortSignal {
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === 'function') return any([a, b]);
  const c = new AbortController();
  const stop = () => c.abort();
  if (a.aborted || b.aborted) {
    c.abort();
    return c.signal;
  }
  a.addEventListener('abort', stop, { once: true });
  b.addEventListener('abort', stop, { once: true });
  return c.signal;
}

async function readSse(
  res: Response,
  onText: (t: string) => void,
  shouldStop: () => boolean
): Promise<{ content: string; tools: ToolAcc[]; usage: unknown; error?: string }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const raw = await res.text();
    return parseJsonCompletion(raw);
  }
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  const tools = new Map<number, ToolAcc>();
  let usage: unknown;
  while (!shouldStop()) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop() || '';
    for (const line of parts) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let json: {
        usage?: unknown;
        error?: { message?: string };
        choices?: Array<{
          finish_reason?: string;
          delta?: {
            content?: string | null;
            tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
          };
          message?: {
            content?: string | null;
            tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
          };
        }>;
      };
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.error?.message) return { content, tools: [...tools.values()], usage, error: json.error.message };
      if (json.usage) usage = json.usage;
      const ch = json.choices?.[0];
      const piece = String(ch?.delta?.content || ch?.message?.content || '');
      if (piece) {
        content += piece;
        onText(content);
      }
      for (const tc of ch?.delta?.tool_calls || []) {
        const i = Number(tc.index) || 0;
        const cur = tools.get(i) || { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        tools.set(i, cur);
      }
      for (const tc of ch?.message?.tool_calls || []) {
        const i = tools.size;
        tools.set(i, {
          id: String(tc.id || `call_${i}`),
          name: String(tc.function?.name || ''),
          args: String(tc.function?.arguments || '{}'),
        });
      }
    }
  }
  return { content, tools: [...tools.values()].filter((t) => t.name), usage };
}

function parseJsonCompletion(raw: string): {
  content: string;
  tools: ToolAcc[];
  usage: unknown;
  error?: string;
} {
  let parsed: {
    error?: { message?: string };
    usage?: unknown;
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
      };
    }>;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { content: '', tools: [], usage: null, error: `BYOK returned non-JSON: ${raw.slice(0, 240)}` };
  }
  if (parsed.error?.message) return { content: '', tools: [], usage: parsed.usage, error: parsed.error.message };
  const msg = parsed.choices?.[0]?.message || {};
  return {
    content: String(msg.content || ''),
    tools: (msg.tool_calls || [])
      .filter((c) => c.function?.name)
      .map((c, i) => ({
        id: String(c.id || `call_${i}`),
        name: String(c.function?.name),
        args: String(c.function?.arguments || '{}'),
      })),
    usage: parsed.usage,
  };
}

export async function runByokCompletion(opts: {
  agentId: string;
  providerId: string;
  modelId?: string;
  system: string;
  user: string;
  images?: Array<{ data: string; mimeType: string }>;
  mcpServers?: McpServers;
  onDelta: (text: string) => void;
  shouldStop: () => boolean;
}): Promise<{ text: string; usage: TokenUsage | null; error?: string }> {
  const provider = getByokProvider(opts.providerId);
  if (!provider?.apiKey) {
    return {
      text: '',
      usage: null,
      error:
        'No BYOK provider key. Open Settings → BYOK, paste the token (stored only in secrets.bin), then pick that provider on the agent.',
    };
  }
  const base = normalizeBaseUrl(provider.baseUrl);
  const apiKey = String(provider.apiKey || '').trim();
  const model = pickByokModelId(opts.modelId, provider.models);
  if (!model) {
    return {
      text: '',
      usage: null,
      error: `No model selected for ${provider.name}. Add model ids in Settings → BYOK, then pick one in agent settings.`,
    };
  }
  const ac = new AbortController();
  aborts.set(opts.agentId, ac);
  const bridge = await openMcpBridge(opts.mcpServers);
  const openaiTools = toolsForOpenAI(bridge.tools);
  const messages: ChatMsg[] = [
    { role: 'system', content: opts.system },
    userContent(opts.user, opts.images || []),
  ];
  let text = '';
  let usage: TokenUsage | null = null;
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (opts.shouldStop() || ac.signal.aborted) return { text: text || 'Stopped.', usage };
      const stream = byokUsesStream(base);
      const body: Record<string, unknown> = {
        model,
        messages,
        stream,
        temperature: 0.2,
      };
      if (openaiTools.length) body.tools = openaiTools;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json',
      };
      if (!stream) {
        body.max_tokens = 4096;
        headers['NVCF-POLL-SECONDS'] = '55';
      }
      const tries = stream ? 1 : FETCH_TRIES;
      let res: Response | undefined;
      let rawText = '';
      for (let attempt = 1; attempt <= tries; attempt++) {
        if (opts.shouldStop() || ac.signal.aborted) return { text: text || 'Stopped.', usage };
        if (attempt > 1) opts.onDelta(`Contacting ${provider.name} (retry ${attempt}/${tries})…`);
        try {
          const init = {
            headers,
            body: JSON.stringify(body),
            signal: linkAbort(ac.signal, AbortSignal.timeout(FETCH_MS)),
          };
          res = stream
            ? await fetch(`${base}/chat/completions`, { method: 'POST', ...init })
            : await byokPost(`${base}/chat/completions`, init);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/abort/i.test(msg)) {
            return {
              text,
              usage,
              error: opts.shouldStop()
                ? undefined
                : `${provider.name} timed out after ${FETCH_MS / 1000}s. Try again.`,
            };
          }
          if (attempt < FETCH_TRIES && isByokRetryable(e)) continue;
          return { text, usage, error: formatByokFetchError(provider.name, e) };
        }
        const ctype = (res.headers.get('content-type') || '').toLowerCase();
        rawText = ctype.includes('json') && !ctype.includes('event-stream') ? await res.text() : '';
        if (!res.ok && attempt < FETCH_TRIES && isByokRetryable(null, res.status)) continue;
        break;
      }
      if (!res) return { text, usage, error: `${provider.name} request failed.` };
      if (!res.ok) {
        const errBody = rawText || (await res.text().catch(() => ''));
        if (res.status === 401 || res.status === 403) {
          return {
            text,
            usage,
            error: `${provider.name} rejected the token. Paste a valid key in Settings → BYOK and Save.`,
          };
        }
        if (res.status === 404 && /not found for account/i.test(errBody)) {
          return {
            text,
            usage,
            error: `${provider.name}: model ${model} is not enabled on this NVIDIA account. Open the model on build.nvidia.com, generate a key, and use that exact model id.`,
          };
        }
        if (res.status === 504) {
          return {
            text,
            usage,
            error: `${provider.name} did not finish ${model} in time (the NVIDIA function is still starting). Send again.`,
          };
        }
        return { text, usage, error: `BYOK ${provider.name} ${res.status}: ${errBody.slice(0, 400)}` };
      }
      const parsed = rawText
        ? parseJsonCompletion(rawText)
        : await readSse(res, (t) => {
            text = t;
            opts.onDelta(t);
          }, () => opts.shouldStop() || ac.signal.aborted);
      if (parsed.error) return { text: parsed.content || text, usage, error: parsed.error };
      const part = usageFrom(parsed.usage);
      if (part && (part.inputTokens || part.outputTokens)) usage = addUsage(usage, part);
      if (parsed.content && parsed.content !== text) {
        text = parsed.content;
        opts.onDelta(text);
      }
      const toolCalls = parsed.tools.filter((t) => t.name);
      if (!toolCalls.length) return { text: text.trim(), usage };
      messages.push({
        role: 'assistant',
        content: parsed.content || text,
        tool_calls: toolCalls.map((c, i) => ({
          id: c.id || `call_${round}_${i}`,
          type: 'function',
          function: { name: c.name, arguments: c.args || '{}' },
        })),
      });
      for (let i = 0; i < toolCalls.length; i++) {
        if (opts.shouldStop() || ac.signal.aborted) return { text: text || 'Stopped.', usage };
        const c = toolCalls[i];
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(c.args || '{}') as Record<string, unknown>;
        } catch {
          args = {};
        }
        let result: string;
        try {
          result = await bridge.callTool(c.name, args);
        } catch (e) {
          result = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
        }
        messages.push({
          role: 'tool',
          tool_call_id: c.id || `call_${round}_${i}`,
          name: c.name,
          content: result.slice(0, 80_000),
        });
      }
    }
    return { text: text.trim() || '(tool loop limit)', usage };
  } catch (e) {
    if (ac.signal.aborted || opts.shouldStop()) return { text: text || 'Stopped.', usage };
    return { text, usage, error: e instanceof Error ? e.message : String(e) };
  } finally {
    aborts.delete(opts.agentId);
    bridge.close();
  }
}
