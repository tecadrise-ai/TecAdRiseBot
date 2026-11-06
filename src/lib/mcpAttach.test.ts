import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSmallTalk, needsProductSkill, needsWorkflowTools, pickMcpServers, selectOptionalMcp } from './mcpAttach.ts';

describe('isSmallTalk', () => {
  it('matches bare greetings', () => {
    assert.equal(isSmallTalk('hi'), true);
    assert.equal(isSmallTalk('ok'), true);
    assert.equal(isSmallTalk('check my email'), false);
  });
});

describe('selectOptionalMcp', () => {
  const names = ['playwright', 'github', 'zoho_mail', 'canva'];

  it('attaches none on hi', () => {
    assert.deepEqual(selectOptionalMcp(names, 'hi'), []);
  });

  it('attaches zoho for check my email (including typo eamil)', () => {
    assert.deepEqual(selectOptionalMcp(names, 'ok ? check my eamil'), ['zoho_mail']);
  });

  it('attaches playwright when the browser is named', () => {
    assert.deepEqual(selectOptionalMcp(names, 'open the page in playwright'), ['playwright']);
  });

  it('attaches none when the job does not name an app', () => {
    assert.deepEqual(selectOptionalMcp(names, 'ssh into the vps and restart nginx'), []);
  });

  it('does not keep zoho on a later hello', () => {
    assert.deepEqual(selectOptionalMcp(names, 'hello', 'check my email'), []);
  });
});

describe('needsWorkflowTools', () => {
  it('is false for hello and true for workflow work', () => {
    assert.equal(needsWorkflowTools('hello'), false);
    assert.equal(needsWorkflowTools('save a workflow for the daily video'), true);
  });
});

describe('needsProductSkill', () => {
  it('is true for host and API-key questions, false for hello and email', () => {
    assert.equal(needsProductSkill('hello'), false);
    assert.equal(needsProductSkill('check my email'), false);
    assert.equal(needsProductSkill('where do I store an API key'), true);
    assert.equal(needsProductSkill('how does this app work'), true);
  });
});

describe('pickMcpServers', () => {
  it('keeps agent JSON always, optional only when selected', () => {
    const picked = pickMcpServers(
      { workflow: { url: 'w' } },
      { zoho_mail: { url: 'z' }, playwright: { url: 'p' } },
      'check inbox'
    );
    assert.deepEqual(Object.keys(picked).sort(), ['workflow', 'zoho_mail']);
  });
});
