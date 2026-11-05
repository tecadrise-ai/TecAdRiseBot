import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDefinition, DefinitionError } from './definition.ts';
import {
  applyAbort,
  applyBlock,
  applyDone,
  applyFail,
  applyFix,
  applyRetry,
  applySkip,
  applyVerdict,
  createRun,
  runnerView,
} from './engine.ts';
import { handleMcpMessage } from './mcpProtocol.ts';
import type { CheckResult } from './types.ts';

const PASS: CheckResult[] = [{ type: 'file_exists', ok: true, detail: 'ok' }];
const FAIL: CheckResult[] = [{ type: 'file_exists', ok: false, detail: 'missing a.txt' }];
const EVIDENCE = { result: 'Wrote a.txt with 12 lines', outputs: { count: '12' } };

function def() {
  return normalizeDefinition({
    name: 'T',
    steps: [
      { id: 'a', title: 'A', done_when: 'a.txt exists', outputs: ['count'], max_attempts: 2 },
      { id: 'b', title: 'B', done_when: 'reviewed', validate: 'owner', max_attempts: 2 },
      { id: 'c', title: 'C', done_when: 'c', skippable: true },
    ],
  });
}

function run() {
  return createRun({
    id: 'r1',
    token: 't',
    workflowId: 'w',
    workflowName: 'T',
    version: 1,
    definition: def(),
    runnerAgentId: 'runner',
    ownerAgentId: 'owner',
    routineId: null,
    input: '',
    now: 1,
  });
}

test('definition: requires name, steps, done_when and valid checks', () => {
  assert.throws(() => normalizeDefinition({ steps: [] }), DefinitionError);
  assert.throws(() => normalizeDefinition({ name: 'x', steps: [{ title: 'a' }] }), /done_when/);
  assert.throws(
    () => normalizeDefinition({ name: 'x', steps: [{ title: 'a', done_when: 'b', checks: [{ type: 'nope' }] }] }),
    /unknown check type/
  );
  assert.throws(
    () =>
      normalizeDefinition({
        name: 'x',
        steps: [{ title: 'a', done_when: 'b', checks: [{ type: 'file_contains', path: 'f', pattern: '(' }] }],
      }),
    /invalid regex/
  );
  const d = normalizeDefinition({
    name: 'x',
    steps: [
      { title: 'Same', done_when: 'b', checks: [{ type: 'output_matches', key: 'n', pattern: '^1$' }] },
      { title: 'Same', done_when: 'b' },
    ],
  });
  assert.equal(d.steps[0].id, 'same');
  assert.equal(d.steps[1].id, 'same-2');
  assert.deepEqual(d.steps[0].outputs, ['n']);
});

test('runner sees only the open step', () => {
  const v = runnerView(run());
  assert.equal(v.state, 'work');
  assert.equal(v.step?.id, 'a');
  assert.equal(JSON.stringify(v).includes('"b"'), false);
});

test('weak evidence, wrong step and missing outputs are rejected', () => {
  assert.equal(applyDone(run(), 'a', { result: 'done' }, PASS, 2).envelope.error?.code, 'RESULT_REQUIRED');
  assert.equal(applyDone(run(), 'b', EVIDENCE, PASS, 2).envelope.error?.code, 'TASK_NOT_AVAILABLE');
  assert.equal(
    applyDone(run(), 'a', { result: 'Wrote a.txt with lines' }, PASS, 2).envelope.error?.code,
    'OUTPUT_REQUIRED'
  );
});

test('failed checks retry, then escalate to owner fix', () => {
  let t = applyDone(run(), 'a', EVIDENCE, FAIL, 2);
  assert.equal(t.envelope.state, 'gate_failed');
  assert.equal(t.run.state, 'running');
  t = applyDone(t.run, 'a', EVIDENCE, FAIL, 3);
  assert.equal(t.run.state, 'needs_fix');
  assert.equal(t.run.steps[0].status, 'failed');
});

test('owner review: reject sends back to runner, pass advances', () => {
  let r = applyDone(run(), 'a', EVIDENCE, PASS, 2).run;
  assert.equal(r.currentIndex, 1);
  r = applyDone(r, 'b', { result: 'Built report.md with 3 sections' }, [], 3).run;
  assert.equal(r.state, 'awaiting_review');
  assert.equal(runnerView(r).state, 'awaiting_review');
  const rej = applyVerdict(r, 'b', false, 'Section 2 is empty', 4);
  assert.ok(rej.ok);
  r = rej.ok ? rej.run : r;
  assert.equal(r.state, 'running');
  assert.equal(runnerView(r).last_failure?.owner_reason, 'Section 2 is empty');
  r = applyDone(r, 'b', { result: 'Filled section 2 with 4 items' }, [], 5).run;
  const pass = applyVerdict(r, 'b', true, 'All sections verified', 6);
  assert.ok(pass.ok);
  r = pass.ok ? pass.run : r;
  assert.equal(r.currentIndex, 2);
  assert.equal(r.state, 'running');
});

test('fail, owner fix and retry restart the step', () => {
  let r = applyFail(run(), 'a', 'Selector changed on the site', 2).run;
  assert.equal(r.state, 'needs_fix');
  const fix = applyFix(r, 'a', { instructions: 'Use the new selector #lead-form' }, 3);
  assert.ok(fix.ok);
  r = fix.ok ? fix.run : r;
  assert.equal(r.state, 'running');
  assert.equal(r.fixesUsed, 1);
  assert.equal(r.definition.steps[0].instructions, 'Use the new selector #lead-form');
  assert.equal(r.steps[0].attempts, 0);
  const bad = applyFix(r, 'a', { checks: [{ type: 'nope' } as never] }, 4);
  assert.equal(bad.ok, false);
  const retry = applyRetry(applyFail(r, 'a', 'Timeout', 5).run, 6);
  assert.ok(retry.ok && retry.run.state === 'running');
});

test('human retry of a run blocked during review resumes the review, not the work', () => {
  let r = applyDone(run(), 'a', EVIDENCE, PASS, 2).run;
  r = applyDone(r, 'b', { result: 'Built report.md with 3 sections' }, [], 3).run;
  assert.equal(r.state, 'awaiting_review');
  r = applyBlock(r, 'Owner ended 2 turns without recording a verdict.', 4);
  assert.equal(r.blockedFrom, 'awaiting_review');
  const retry = applyRetry(r, 5);
  assert.ok(retry.ok);
  r = retry.ok ? retry.run : r;
  assert.equal(r.state, 'awaiting_review');
  assert.equal(r.steps[1].status, 'review');
  assert.equal(r.steps[1].result, 'Built report.md with 3 sections');
  assert.equal(r.blockedFrom, null);

  const fromRunning = applyRetry(applyBlock(run(), 'Runner idle', 6), 7);
  assert.ok(fromRunning.ok && fromRunning.run.state === 'running');
});

test('abort pauses the run; retry resumes the open step and keeps earlier steps', () => {
  let r = applyDone(run(), 'a', EVIDENCE, PASS, 2).run;
  r = applyFail(r, 'b', 'Voice engine down', 3).run;
  assert.equal(r.currentIndex, 1);
  r = applyAbort(r, 'Waiting for VoiceStudio', 4);
  assert.equal(r.state, 'aborted');
  assert.equal(r.finishedAt, 4);
  assert.equal(r.steps[0].status, 'passed');
  const retry = applyRetry(r, 5);
  assert.ok(retry.ok);
  r = retry.ok ? retry.run : r;
  assert.equal(r.state, 'running');
  assert.equal(r.finishedAt, null);
  assert.equal(r.currentIndex, 1);
  assert.equal(r.steps[0].status, 'passed');
  assert.equal(r.steps[1].status, 'active');
});

test('definition rejects very long regexes', () => {
  assert.throws(
    () =>
      normalizeDefinition({
        name: 'x',
        steps: [{ title: 'a', done_when: 'b', checks: [{ type: 'output_matches', key: 'n', pattern: 'a'.repeat(501) }] }],
      }),
    /longer than 500/
  );
});

test('skip only when skippable unless forced, finishing the last step completes the run', () => {
  let r = applyDone(run(), 'a', EVIDENCE, PASS, 2).run;
  assert.equal(applySkip(r, 'b', 'not needed', 3).envelope.error?.code, 'NOT_SKIPPABLE');
  r = applySkip(r, 'b', 'human skipped', 3, true).run;
  r = applySkip(r, 'c', 'not needed today', 4).run;
  assert.equal(r.state, 'done');
  assert.equal(runnerView(r).state, 'done');
  assert.equal(applyAbort(r, 'x', 5).state, 'done');
});

test('mcp protocol: initialize, list, call, notification', async () => {
  const server = {
    name: 's',
    version: '1',
    instructions: 'i',
    tools: [{ name: 'echo', description: 'e', inputSchema: {}, run: (a: Record<string, unknown>) => ({ got: a.x }) }],
  };
  const init = (await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, server)) as {
    result: { protocolVersion: string };
  };
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, server), null);
  const list = (await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, server)) as {
    result: { tools: Array<{ name: string; run?: unknown }> };
  };
  assert.equal(list.result.tools[0].name, 'echo');
  assert.equal(list.result.tools[0].run, undefined);
  const call = (await handleMcpMessage(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { x: 7 } } },
    server
  )) as { result: { content: Array<{ text: string }> } };
  assert.deepEqual(JSON.parse(call.result.content[0].text), { got: 7 });
  const unknown = (await handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'x' } }, server)) as {
    error: { code: number };
  };
  assert.equal(unknown.error.code, -32602);
});
