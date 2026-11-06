import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHostSystemPrompt } from './promptHost.ts';

describe('buildHostSystemPrompt', () => {
  it('names the agent, workspace, and bound MCP without curl or secret values', () => {
    const text = buildHostSystemPrompt({
      agentName: 'VPSAgent',
      agentId: 'abc',
      modelLabel: 'Composer',
      workspace: 'C:/ws',
      memoryDir: 'C:/mem',
      skillsIndex: '- foo: bar',
      soul: 'Stay on the VPS.',
      mcpNames: ['github'],
    });
    assert.match(text, /VPSAgent/);
    assert.match(text, /C:\/ws/);
    assert.match(text, /MCP available this turn: github/);
    assert.match(text, /Use a tool only when the user asked/);
    assert.match(text, /Stay on the VPS/);
    assert.doesNotMatch(text, /curl /);
    assert.doesNotMatch(text, /\/api\/secrets\//);
    assert.doesNotMatch(text, /ARCHITECTURE/);
    assert.match(text, /Today UTC: \d{4}-\d{2}-\d{2}\.$/);
  });

  it('omits the MCP line when none are bound', () => {
    const text = buildHostSystemPrompt({
      agentName: 'A',
      agentId: '1',
      modelLabel: 'm',
      workspace: 'w',
      memoryDir: 'm',
      skillsIndex: '',
      soul: '',
      mcpNames: [],
    });
    assert.doesNotMatch(text, /MCP available this turn/);
  });

  it('keeps a greeting to identity and soul only', () => {
    const text = buildHostSystemPrompt({
      agentName: 'GeneralQA',
      agentId: '1',
      modelLabel: 'm',
      workspace: 'w',
      memoryDir: 'm',
      skillsIndex: '- seo: x',
      soul: 'Answer curiosity questions.',
      mcpNames: ['zoho_mail'],
      userText: 'hello',
    });
    assert.match(text, /GeneralQA/);
    assert.match(text, /Do not call tools/);
    assert.doesNotMatch(text, /seo/);
    assert.doesNotMatch(text, /zoho_mail/);
    assert.doesNotMatch(text, /Workspace/);
    assert.doesNotMatch(text, /Today UTC/);
  });
});
