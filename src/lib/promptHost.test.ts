import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHostSystemPrompt } from './promptHost.ts';

describe('buildHostSystemPrompt', () => {
  it('names the agent, workspace, and Soul without curl or secret values', () => {
    const text = buildHostSystemPrompt({
      agentName: 'VPSAgent',
      agentId: 'abc',
      modelLabel: 'Composer',
      workspace: 'C:/ws',
      memoryDir: 'C:/mem',
      skillsIndex: '- foo: bar',
      soul: 'Stay on the VPS.',
      system: 'Global rule. SAFEWORD=unittest',
      memory: 'Open index.md then the linked note.',
    });
    assert.match(text, /Global rule\. SAFEWORD=unittest/);
    assert.match(text, /Open index\.md then the linked note/);
    assert.match(text, /VPSAgent/);
    assert.match(text, /C:\/ws/);
    assert.match(text, /C:\/mem/);
    assert.match(text, /Stay on the VPS/);
    assert.match(text, /Skills:\n- foo: bar/);
    assert.doesNotMatch(text, /MCP available this turn/);
    assert.doesNotMatch(text, /Connected apps/);
    assert.doesNotMatch(text, /curl /);
    assert.doesNotMatch(text, /\/api\/secrets\//);
    assert.doesNotMatch(text, /ARCHITECTURE/);
    assert.doesNotMatch(text, /TodoWrite/);
    assert.doesNotMatch(text, /unless the user asked/);
    assert.match(text, /Today UTC: \d{4}-\d{2}-\d{2}\.$/);
  });
});
