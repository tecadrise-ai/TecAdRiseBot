import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fmtUsed, labelUsed, labelsFromUnknown, mergeUsed, skillFromPath } from './usedHoldings.ts';

describe('labelUsed', () => {
  it('maps zoho, playwright, and host tools', () => {
    assert.equal(labelUsed('zoho_mail_accounts'), 'Zoho');
    assert.equal(labelUsed('browser_navigate'), 'Playwright');
    assert.equal(labelUsed('mcp_playwright_browser_click'), 'Playwright');
    assert.equal(labelUsed('message_agent'), 'Host');
    assert.equal(labelUsed('Shell'), 'Shell');
  });
});

describe('labelsFromUnknown', () => {
  it('picks names from tool-call deltas', () => {
    const labels = labelsFromUnknown({
      update: {
        type: 'tool-call-started',
        toolCall: { name: 'zoho_mail_folders', mcpServer: 'zoho_mail' },
      },
    });
    assert.deepEqual(labels, ['Zoho']);
  });

  it('names a skill from a Read path', () => {
    const labels = labelsFromUnknown({
      type: 'tool-call-completed',
      name: 'Read',
      arguments: { path: 'C:/Users/Chris/AppData/Roaming/TecAdRiseBot/skills/tecadrisebot/SKILL.md' },
    });
    assert.ok(labels.includes('tecadrisebot'));
    assert.ok(labels.includes('Read'));
  });
});

describe('mergeUsed / fmtUsed', () => {
  it('keeps first-seen order and formats brackets', () => {
    assert.deepEqual(mergeUsed(['Zoho'], ['Playwright', 'zoho']), ['Zoho', 'Playwright']);
    assert.equal(fmtUsed(['Zoho', 'Playwright']), '[Zoho, Playwright]');
    assert.equal(fmtUsed([]), '');
  });
});

describe('skillFromPath', () => {
  it('reads the skills folder name on Windows paths', () => {
    assert.equal(skillFromPath('C:\\data\\skills\\seo\\SKILL.md'), 'seo');
    assert.equal(skillFromPath('/tmp/foo.md'), null);
  });
});
