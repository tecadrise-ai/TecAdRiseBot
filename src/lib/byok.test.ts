import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BYOK_PRESETS,
  byokRoleFromConfig,
  byokUsesStream,
  normalizeBaseUrl,
  parseByokModels,
  pickByokModelId,
  readAgentRuntime,
  readByokModelId,
  RUNTIME_BYOK,
  RUNTIME_CURSOR,
} from './byok.ts';

describe('readAgentRuntime', () => {
  it('defaults to cursor_sdk', () => {
    assert.equal(readAgentRuntime(null), RUNTIME_CURSOR);
    assert.equal(readAgentRuntime({}), RUNTIME_CURSOR);
    assert.equal(readAgentRuntime({ runtime: 'byok' }), RUNTIME_BYOK);
  });
});

describe('readByokModelId', () => {
  it('uses the saved id and does not inject a Hugging Face model', () => {
    assert.equal(readByokModelId({}), '');
    assert.equal(readByokModelId({ byokModelId: 'z-ai/glm-5.3-flash' }), 'z-ai/glm-5.3-flash');
  });
});

describe('parseByokModels', () => {
  it('splits comma-separated model ids', () => {
    assert.deepEqual(parseByokModels('z-ai/glm-5.3-flash, moonshotai/kimi-k3.1-pro'), [
      'z-ai/glm-5.3-flash',
      'moonshotai/kimi-k3.1-pro',
    ]);
    assert.deepEqual(parseByokModels('  '), []);
  });
});

describe('pickByokModelId', () => {
  it('uses only ids from secrets and drops leftover agent ids', () => {
    const secrets = 'Qwen/Qwen3-Next-80B-A3B-Instruct';
    assert.equal(pickByokModelId('Qwen/Qwen3-Next-80B-A3B-Instruct', secrets), 'Qwen/Qwen3-Next-80B-A3B-Instruct');
    assert.equal(pickByokModelId('Qwen3-Next-80B-A3B-Instruct', secrets), 'Qwen/Qwen3-Next-80B-A3B-Instruct');
    assert.equal(pickByokModelId('', secrets), 'Qwen/Qwen3-Next-80B-A3B-Instruct');
    assert.equal(pickByokModelId('x', ''), '');
  });
});

describe('BYOK_PRESETS', () => {
  it('includes Hugging Face, OpenRouter, OpenAI, Claude, and NVIDIA NIM', () => {
    assert.deepEqual(
      BYOK_PRESETS.map((p) => p.name),
      ['Hugging Face', 'OpenRouter', 'OpenAI', 'Claude', 'NVIDIA NIM']
    );
    for (const p of BYOK_PRESETS) assert.match(p.baseUrl, /^https:\/\//);
  });
});

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes', () => {
    assert.equal(normalizeBaseUrl('https://router.huggingface.co/v1/'), 'https://router.huggingface.co/v1');
  });
});

describe('byokUsesStream', () => {
  it('disables SSE for NVIDIA NIM and keeps it for Hugging Face', () => {
    assert.equal(byokUsesStream('https://integrate.api.nvidia.com/v1'), false);
    assert.equal(byokUsesStream('https://router.huggingface.co/v1'), true);
  });
});

describe('byokRoleFromConfig', () => {
  it('applies the same BYOK model to runner and owner', () => {
    const role = byokRoleFromConfig({ runtime: 'byok', byokProviderId: 'p1', byokModelId: 'z-ai/glm-5.3-flash' });
    assert.deepEqual(role, {
      runtime: RUNTIME_BYOK,
      byokProviderId: 'p1',
      byokModelId: 'z-ai/glm-5.3-flash',
    });
    assert.equal(byokRoleFromConfig({}), null);
  });
});
