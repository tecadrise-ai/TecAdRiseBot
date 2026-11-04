import type { CheckResult, StepDef, StepState, WorkflowDefinition, WorkflowRun } from './types.ts';
import { normalizeDefinition } from './definition.ts';

/**
 * Pure state machine for step workflows. No I/O: callers load the run, call one
 * transition, persist the returned run, and send the returned envelope to the agent.
 */

export type RunnerEnvelope = {
  run_id: string;
  state: 'work' | 'gate_failed' | 'awaiting_review' | 'blocked' | 'done' | 'aborted' | 'rejected';
  step?: {
    id: string;
    title: string;
    instructions: string;
    done_when: string;
    required_outputs: string[];
    skippable: boolean;
    attempt: number;
    max_attempts: number;
  };
  last_failure?: { checks?: CheckResult[]; owner_reason?: string; error?: string };
  progress: { done: number; total: number };
  instruction: string;
  error?: { code: string; message: string };
};

export type Report = { result: string; outputs?: Record<string, string>; artifacts?: string[] };

export type Transition = { run: WorkflowRun; envelope: RunnerEnvelope };

const WEAK_RESULT = /^(done|ok|okay|completed?|finished|success|yes)[.!]?$/i;
export const MIN_RESULT_CHARS = 10;

function clone(run: WorkflowRun): WorkflowRun {
  return JSON.parse(JSON.stringify(run)) as WorkflowRun;
}

function currentDef(run: WorkflowRun): StepDef | undefined {
  return run.definition.steps[run.currentIndex];
}

function currentState(run: WorkflowRun): StepState | undefined {
  return run.steps[run.currentIndex];
}

export function progressOf(run: WorkflowRun): { done: number; total: number } {
  const done = run.steps.filter((s) => s.status === 'passed' || s.status === 'skipped').length;
  return { done, total: run.steps.length };
}

export function createRun(p: {
  id: string;
  token: string;
  workflowId: string;
  workflowName: string;
  version: number;
  definition: WorkflowDefinition;
  runnerAgentId: string;
  ownerAgentId: string;
  routineId: string | null;
  input: string;
  now: number;
}): WorkflowRun {
  const steps: StepState[] = p.definition.steps.map((_, i) =>
    i === 0 ? { status: 'active', attempts: 0, startedAt: p.now } : { status: 'pending', attempts: 0 }
  );
  return {
    id: p.id,
    workflowId: p.workflowId,
    workflowName: p.workflowName,
    version: p.version,
    runnerAgentId: p.runnerAgentId,
    ownerAgentId: p.ownerAgentId,
    routineId: p.routineId,
    token: p.token,
    state: 'running',
    currentIndex: 0,
    definition: p.definition,
    steps,
    input: p.input,
    blockedReason: null,
    fixesUsed: 0,
    idleTurns: 0,
    createdAt: p.now,
    updatedAt: p.now,
    finishedAt: null,
  };
}

function lastFailure(st: StepState | undefined): RunnerEnvelope['last_failure'] {
  if (!st) return undefined;
  const failedChecks = (st.checks || []).filter((c) => !c.ok);
  const ownerReason = st.verdict && !st.verdict.pass ? st.verdict.reason : undefined;
  if (!failedChecks.length && !ownerReason && !st.error) return undefined;
  return {
    ...(failedChecks.length ? { checks: failedChecks } : {}),
    ...(ownerReason ? { owner_reason: ownerReason } : {}),
    ...(st.error ? { error: st.error } : {}),
  };
}

/** What the runner sees right now. Idempotent, safe after context loss. */
export function runnerView(run: WorkflowRun, override?: Partial<RunnerEnvelope>): RunnerEnvelope {
  const progress = progressOf(run);
  const base = { run_id: run.id, progress };
  if (run.state === 'done') {
    return { ...base, state: 'done', instruction: 'Workflow finished. Give a short final summary and end your turn.', ...override };
  }
  if (run.state === 'aborted') {
    return { ...base, state: 'aborted', instruction: 'Workflow was aborted. Stop working on it and end your turn.', ...override };
  }
  if (run.state === 'awaiting_review') {
    return {
      ...base,
      state: 'awaiting_review',
      instruction: 'Your last step is being reviewed. Do nothing else. End your turn now. You will be resumed automatically.',
      ...override,
    };
  }
  if (run.state === 'needs_fix' || run.state === 'blocked') {
    return {
      ...base,
      state: 'blocked',
      instruction:
        'The workflow is blocked until the owner or a human fixes it. Do nothing else. End your turn now with a one-line status.',
      ...override,
    };
  }
  const def = currentDef(run)!;
  const st = currentState(run)!;
  const failure = lastFailure(st);
  return {
    ...base,
    state: 'work',
    step: {
      id: def.id,
      title: def.title,
      instructions: def.instructions,
      done_when: def.done_when,
      required_outputs: def.outputs,
      skippable: def.skippable,
      attempt: st.attempts + 1,
      max_attempts: def.max_attempts,
    },
    ...(failure ? { last_failure: failure } : {}),
    instruction: failure
      ? 'Your previous report for this step was rejected. Read last_failure, fix the actual problem, then call step_done again with new evidence.'
      : 'Do ONLY this step until done_when is true. Then call step_done with concrete evidence (paths, counts, values). Do not work ahead.',
    ...override,
  };
}

function reject(run: WorkflowRun, code: string, message: string): Transition {
  return {
    run,
    envelope: runnerView(run, { state: 'rejected', error: { code, message } }),
  };
}

function activateNext(run: WorkflowRun, now: number): void {
  run.currentIndex += 1;
  if (run.currentIndex >= run.steps.length) {
    run.currentIndex = run.steps.length - 1;
    run.state = 'done';
    run.finishedAt = now;
    return;
  }
  run.state = 'running';
  run.steps[run.currentIndex] = { status: 'active', attempts: 0, startedAt: now };
}

/** Pre-validation of a step_done report. Returns a rejection, or null when checks may run. */
export function precheckDone(run: WorkflowRun, stepId: string, report: Report): Transition | null {
  if (run.state !== 'running') return reject(run, 'RUN_NOT_ACTIVE', `Run is ${run.state}, not accepting reports.`);
  const def = currentDef(run);
  if (!def || def.id !== stepId) {
    return reject(run, 'TASK_NOT_AVAILABLE', `Step "${stepId}" is not the open step. Call step_current.`);
  }
  const result = String(report.result || '').trim();
  if (result.length < MIN_RESULT_CHARS || WEAK_RESULT.test(result)) {
    return reject(
      run,
      'RESULT_REQUIRED',
      'result must be concrete evidence (paths written, counts, values, command output), not just "done".'
    );
  }
  const outputs = report.outputs || {};
  const missing = def.outputs.filter((k) => !String(outputs[k] ?? '').trim());
  if (missing.length) {
    return reject(run, 'OUTPUT_REQUIRED', `Missing required outputs: ${missing.join(', ')}`);
  }
  return null;
}

/** Apply a step_done report after the hard checks ran. */
export function applyDone(
  input: WorkflowRun,
  stepId: string,
  report: Report,
  checks: CheckResult[],
  now: number
): Transition {
  const pre = precheckDone(input, stepId, report);
  if (pre) return pre;
  const run = clone(input);
  const def = currentDef(run)!;
  const st = currentState(run)!;
  st.result = String(report.result).trim();
  st.outputs = report.outputs || {};
  st.artifacts = report.artifacts || [];
  st.checks = checks;
  st.verdict = undefined;
  st.error = undefined;
  run.updatedAt = now;
  run.idleTurns = 0;

  if (checks.some((c) => !c.ok)) {
    st.attempts += 1;
    if (st.attempts >= def.max_attempts) {
      st.status = 'failed';
      st.error = `Checks failed ${st.attempts} times.`;
      run.state = 'needs_fix';
      return { run, envelope: runnerView(run) };
    }
    return {
      run,
      envelope: runnerView(run, {
        state: 'gate_failed',
        instruction: 'Hard checks failed. Read last_failure.checks, fix the problem, then call step_done again.',
      }),
    };
  }

  if (def.validate === 'owner') {
    st.status = 'review';
    run.state = 'awaiting_review';
    return { run, envelope: runnerView(run) };
  }

  st.status = 'passed';
  st.finishedAt = now;
  activateNext(run, now);
  return { run, envelope: runnerView(run) };
}

export function applyFail(input: WorkflowRun, stepId: string, error: string, now: number): Transition {
  if (input.state !== 'running') return reject(input, 'RUN_NOT_ACTIVE', `Run is ${input.state}.`);
  const def = currentDef(input);
  if (!def || def.id !== stepId) {
    return reject(input, 'TASK_NOT_AVAILABLE', `Step "${stepId}" is not the open step. Call step_current.`);
  }
  if (!String(error || '').trim()) return reject(input, 'ERROR_REQUIRED', 'Say why the step cannot be completed.');
  const run = clone(input);
  const st = currentState(run)!;
  st.status = 'failed';
  st.error = String(error).trim();
  run.state = 'needs_fix';
  run.updatedAt = now;
  run.idleTurns = 0;
  return { run, envelope: runnerView(run) };
}

export function applySkip(input: WorkflowRun, stepId: string, reason: string, now: number, force = false): Transition {
  if (!force && input.state !== 'running') return reject(input, 'RUN_NOT_ACTIVE', `Run is ${input.state}.`);
  if (input.state === 'done' || input.state === 'aborted') return reject(input, 'RUN_NOT_ACTIVE', `Run is ${input.state}.`);
  const def = currentDef(input);
  if (!def || def.id !== stepId) {
    return reject(input, 'TASK_NOT_AVAILABLE', `Step "${stepId}" is not the open step.`);
  }
  if (!force && !def.skippable) return reject(input, 'NOT_SKIPPABLE', 'This step is not skippable.');
  if (!String(reason || '').trim()) return reject(input, 'REASON_REQUIRED', 'Give a reason for skipping.');
  const run = clone(input);
  const st = currentState(run)!;
  st.status = 'skipped';
  st.result = `Skipped: ${String(reason).trim()}`;
  st.finishedAt = now;
  run.blockedReason = null;
  run.updatedAt = now;
  run.idleTurns = 0;
  activateNext(run, now);
  return { run, envelope: runnerView(run) };
}

/** Owner verdict for a step in review. */
export function applyVerdict(
  input: WorkflowRun,
  stepId: string,
  pass: boolean,
  reason: string,
  now: number
): { ok: true; run: WorkflowRun } | { ok: false; error: string } {
  if (input.state !== 'awaiting_review') return { ok: false, error: `Run is ${input.state}, nothing to review.` };
  const def = currentDef(input);
  if (!def || def.id !== stepId) return { ok: false, error: `Step "${stepId}" is not under review.` };
  if (!String(reason || '').trim()) return { ok: false, error: 'reason is required' };
  const run = clone(input);
  const st = currentState(run)!;
  st.verdict = { pass, reason: String(reason).trim(), at: now };
  run.updatedAt = now;
  run.idleTurns = 0;
  if (pass) {
    st.status = 'passed';
    st.finishedAt = now;
    activateNext(run, now);
    return { ok: true, run };
  }
  st.attempts += 1;
  if (st.attempts >= def.max_attempts) {
    st.status = 'failed';
    st.error = `Owner rejected the step ${st.attempts} times. Last reason: ${st.verdict.reason}`;
    run.state = 'needs_fix';
    return { ok: true, run };
  }
  st.status = 'active';
  run.state = 'running';
  return { ok: true, run };
}

export type StepPatch = Partial<
  Pick<StepDef, 'title' | 'instructions' | 'done_when' | 'outputs' | 'checks' | 'validate' | 'max_attempts' | 'skippable'>
>;

/**
 * Owner fix: patch the open step in this run and restart it. Returns the patched
 * step definition so the caller can also save it as a new workflow version.
 */
export function applyFix(
  input: WorkflowRun,
  stepId: string,
  patch: StepPatch,
  now: number
): { ok: true; run: WorkflowRun; step: StepDef } | { ok: false; error: string } {
  if (input.state === 'done' || input.state === 'aborted') return { ok: false, error: `Run is ${input.state}.` };
  const def = currentDef(input);
  if (!def || def.id !== stepId) return { ok: false, error: `Step "${stepId}" is not the open step.` };
  let step: StepDef;
  try {
    const merged = { ...def, ...patch, id: def.id };
    const norm = normalizeDefinition({ name: input.definition.name, steps: [merged] });
    step = { ...norm.steps[0], id: def.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const run = clone(input);
  run.definition.steps[run.currentIndex] = step;
  run.steps[run.currentIndex] = { status: 'active', attempts: 0, startedAt: now };
  run.state = 'running';
  run.blockedReason = null;
  run.blockedFrom = null;
  run.fixesUsed += 1;
  run.idleTurns = 0;
  run.updatedAt = now;
  return { ok: true, run, step };
}

/**
 * Restart the open step without changes (owner says "transient, try again" or a human clicks Retry).
 * A run blocked while its finished step waited for review goes back to review instead of redoing the work.
 */
export function applyRetry(input: WorkflowRun, now: number): { ok: true; run: WorkflowRun } | { ok: false; error: string } {
  if (input.state === 'done' || input.state === 'aborted') return { ok: false, error: `Run is ${input.state}.` };
  const run = clone(input);
  const st = currentState(run);
  if (run.state === 'blocked' && run.blockedFrom === 'awaiting_review' && st?.status === 'review') {
    run.state = 'awaiting_review';
  } else {
    run.steps[run.currentIndex] = { status: 'active', attempts: 0, startedAt: now };
    run.state = 'running';
  }
  run.blockedReason = null;
  run.blockedFrom = null;
  run.idleTurns = 0;
  run.updatedAt = now;
  return { ok: true, run };
}

export function applyAbort(input: WorkflowRun, reason: string, now: number): WorkflowRun {
  const run = clone(input);
  if (run.state === 'done') return run;
  run.state = 'aborted';
  run.blockedReason = String(reason || 'Aborted').trim();
  run.finishedAt = now;
  run.updatedAt = now;
  return run;
}

export function applyBlock(input: WorkflowRun, reason: string, now: number): WorkflowRun {
  const run = clone(input);
  if (run.state === 'done' || run.state === 'aborted') return run;
  if (run.state !== 'blocked') run.blockedFrom = run.state;
  run.state = 'blocked';
  run.blockedReason = reason;
  run.updatedAt = now;
  return run;
}
