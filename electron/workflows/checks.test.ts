import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runChecks } from './checks.ts';

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-checks-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'count: 12\n');
  return dir;
}

test('catastrophic regex fails the check instead of freezing the process', async () => {
  const started = Date.now();
  const [r] = await runChecks(
    [{ type: 'output_matches', key: 'v', pattern: '^(a+)+$' }],
    { v: `${'a'.repeat(40)}!` },
    workspace()
  );
  assert.equal(r.ok, false);
  assert.match(r.detail, /longer than/);
  assert.ok(Date.now() - started < 5000);
});

test('output placeholders are literal inside file_contains patterns', async () => {
  const ws = workspace();
  const [hit] = await runChecks([{ type: 'file_contains', path: 'a.txt', pattern: 'count: {{output.n}}' }], { n: '12' }, ws);
  assert.equal(hit.ok, true);
  const [miss] = await runChecks([{ type: 'file_contains', path: 'a.txt', pattern: 'count: {{output.n}}' }], { n: '.*' }, ws);
  assert.equal(miss.ok, false);
});

test('shell characters in outputs are refused in command checks', async () => {
  const [r] = await runChecks([{ type: 'command', run: 'echo {{output.x}}' }], { x: 'hi & exit 0' }, workspace());
  assert.equal(r.ok, false);
  assert.match(r.detail, /shell characters/);
  const [ok] = await runChecks([{ type: 'command', run: 'echo {{output.x}}' }], { x: 'hello' }, workspace());
  assert.equal(ok.ok, true);
});

test('command timeout fails the check', async () => {
  const cmd = process.platform === 'win32' ? 'ping -n 6 127.0.0.1 > nul' : 'sleep 5';
  const [r] = await runChecks([{ type: 'command', run: cmd, timeout_s: 1 }], {}, workspace());
  assert.equal(r.ok, false);
  assert.match(r.detail, /timed out/);
});
