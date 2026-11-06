import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareSemver, parseLatestRelease, statusFor } from './appUpdate.ts';

describe('compareSemver', () => {
  it('orders dotted versions', () => {
    assert.equal(compareSemver('0.1.2', '0.1.2'), 0);
    assert.equal(compareSemver('0.1.2', '0.1.3'), -1);
    assert.equal(compareSemver('0.2.0', '0.1.9'), 1);
  });
});

describe('parseLatestRelease', () => {
  it('requires version and https setupUrl', () => {
    assert.equal(parseLatestRelease({ version: '0.1.2' }), null);
    const ok = parseLatestRelease({
      version: '0.1.2',
      setupUrl: 'https://tecadrise.ai/downloads/tecadrisebot/TecAdRiseBot-Setup-0.1.2.exe',
      sha256: 'a'.repeat(64),
      gitCommit: 'abc',
      gitTag: 'v0.1.2',
    });
    assert.ok(ok);
    assert.equal(ok?.version, '0.1.2');
  });
});

describe('statusFor', () => {
  const latest = parseLatestRelease({
    version: '0.1.2',
    setupUrl: 'https://tecadrise.ai/downloads/tecadrisebot/TecAdRiseBot-Setup-0.1.2.exe',
  });
  it('maps compare to UI status', () => {
    assert.equal(statusFor('0.1.2', latest, false), 'current');
    assert.equal(statusFor('0.1.1', latest, false), 'available');
    assert.equal(statusFor('0.1.3', latest, false), 'ahead');
    assert.equal(statusFor('0.1.2', null, true), 'error');
  });
});
