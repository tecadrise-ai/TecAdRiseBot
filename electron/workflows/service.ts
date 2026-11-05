import { BrowserWindow } from 'electron';
import crypto from 'node:crypto';
import { v4 as uuid } from 'uuid';
import * as db from '../db';
import * as store from './store';
import { runChecks } from './checks';
import {
  OWNER_MCP_NAME,
  OWNER_RULES,
  RUNNER_MCP_NAME,
  RUNNER_RULES,
  ownerFixPrompt,
  ownerReviewPrompt,
  runnerKickoff,
} from './prompts';
import * as engine from '../../src/lib/workflow/engine';
import { handleMcpMessage, MAP, S, STR, type JsonRpcMessage, type JsonRpcReply, type McpTool } from '../../src/lib/workflow/mcpProtocol';
import type { RoleOverride, Workflow, WorkflowRun } from '../../src/lib/workflow/types';
import { ownerRoleOverride } from '../../src/lib/workflow/definition';
import { baseModelId, formatModelLabel, readEffort, readModelMode } from '../../src/lib/modelOptions';
import { isRunActive } from '../../src/lib/workflow/types';
import { isAgentBusy, runAgentTurn, setTurnAugmenter, type TurnExtras } from '../agentRunner';

/** Owner fix turns allowed per run before a human must step in. */
const MAX_FIXES_PER_RUN = 3;
/** Consecutive runner turns without progress before the run is blocked. */
const MAX_RUNNER_IDLE = 3;
/** Consecutive owner turns without a verdict or fix before the run is blocked. */
const MAX_OWNER_IDLE = 2;

let getBaseUrl: () => string = () => 'http://127.0.0.1:8787';
let getWindow: () => BrowserWindow | null = () => null;
const ownerTokens = new Map<string, string>();
const locks = new Map<string, Promise<unknown>>();
/** runId -> role of the turn currently dispatched for it. */
const inFlight = new Map<string, 'runner' | 'review' | 'fix'>();
/** Agents with a workflow turn dispatched but maybe not yet claimed by the runner. */
const dispatchedAgents = new Set<string>();
let pumping = false;
let pumpAgain = false;

export function configureWorkflows(opts: { getBaseUrl: () => string; getWindow: () => BrowserWindow | null }): void {
  getBaseUrl = opts.getBaseUrl;
  getWindow = opts.getWindow;
  // Every agent is the owner of its own workflows. The owner tools only touch workflows and runs owned by the
  // calling agent, so a runner can never edit the workflow it runs.
  setTurnAugmenter((agent) => ownerExtras(agent.id));
}

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail: Promise<unknown> = next.then(
    () => {
      if (locks.get(key) === tail) locks.delete(key);
    },
    () => {
      if (locks.get(key) === tail) locks.delete(key);
    }
  );
  locks.set(key, tail);
  return next;
}

/** Run view for the UI. Never exposes the runner token. */
export type RunView = Omit<WorkflowRun, 'token'> & {
  runnerName: string;
  runnerModel: string;
  ownerName: string;
  inFlight: string | null;
};

export function viewOf(run: WorkflowRun): RunView {
  const { token: _token, ...rest } = run;
  const runner = db.getAgent(run.runnerAgentId);
  return {
    ...rest,
    runnerName: runner?.name ?? '(deleted agent)',
    runnerModel: runner ? formatModelLabel(runner.model, runner.config) : '',
    ownerName: db.getAgent(run.ownerAgentId)?.name ?? '(deleted agent)',
    inFlight: inFlight.get(run.id) ?? null,
  };
}

function broadcast(run: WorkflowRun): void {
  const payload = viewOf(run);
  const seen = new Set<number>();
  const targets = [getWindow(), ...BrowserWindow.getAllWindows()];
  for (const w of targets) {
    if (!w || w.isDestroyed() || seen.has(w.id)) continue;
    seen.add(w.id);
    try {
      w.webContents.send('workflow:run', payload);
    } catch {
      /* ignore */
    }
  }
}

function commit(run: WorkflowRun): WorkflowRun {
  store.saveRun(run);
  if (run.state === 'done' || run.state === 'aborted') store.pruneFinishedRuns(run.workflowId);
  // Outcomes a human acts on must survive a hard kill, not wait for the debounced save.
  if (run.state === 'done' || run.state === 'aborted' || run.state === 'blocked') db.flushPersist();
  broadcast(run);
  return run;
}

function ownerToken(agentId: string): string {
  let t = ownerTokens.get(agentId);
  if (!t) {
    t = crypto.randomBytes(18).toString('hex');
    ownerTokens.set(agentId, t);
  }
  return t;
}

function runnerUrl(run: WorkflowRun): string {
  return `${getBaseUrl()}/mcp/run/${encodeURIComponent(run.id)}/${run.token}`;
}

function ownerUrl(agentId: string): string {
  return `${getBaseUrl()}/mcp/owner/${encodeURIComponent(agentId)}/${ownerToken(agentId)}`;
}

function ownerExtras(agentId: string): TurnExtras {
  return {
    extraMcp: { [OWNER_MCP_NAME]: { type: 'http', url: ownerUrl(agentId) } },
    extraSystem: OWNER_RULES,
  };
}

// ---------------------------------------------------------------- runner tools

function runnerTools(runId: string): McpTool[] {
  const load = () => {
    const run = store.getRun(runId);
    if (!run) throw new Error('Run not found');
    return run;
  };
  return [
    {
      name: 'step_current',
      description: 'Get the ONE step you must work on now. Safe to call any time, including after context loss.',
      inputSchema: S({}),
      run: () => engine.runnerView(load()),
    },
    {
      name: 'step_done',
      description:
        'Report the open step as done with concrete evidence. The host runs the hard checks; on gate_failed fix and report again.',
      inputSchema: S(
        {
          step_id: STR('id of the open step from step_current'),
          result: STR('Concrete evidence: files written, counts, values, command output'),
          outputs: MAP('Required outputs, key to value'),
          artifacts: { type: 'array', items: { type: 'string' }, description: 'Paths of produced files' },
        },
        ['step_id', 'result']
      ),
      run: (a) =>
        withLock(runId, async () => {
          const run = load();
          const report: engine.Report = {
            result: clip(String(a.result ?? ''), MAX_RESULT_CHARS),
            outputs: toStringMap(a.outputs),
            artifacts: Array.isArray(a.artifacts) ? a.artifacts.slice(0, 50).map((x) => clip(String(x), 500)) : [],
          };
          const stepId = String(a.step_id ?? '');
          const pre = engine.precheckDone(run, stepId, report);
          if (pre) return pre.envelope;
          const def = run.definition.steps[run.currentIndex];
          const checks = await runChecks(def.checks, report.outputs || {}, db.agentWorkspacePath(run.runnerAgentId));
          const t = engine.applyDone(store.getRun(runId) ?? run, stepId, report, checks, Date.now());
          commit(t.run);
          if (t.run.state !== 'running') kickPump();
          return t.envelope;
        }),
    },
    {
      name: 'step_fail',
      description: 'Report that you cannot complete the open step. The workflow owner will fix it. Never fake evidence instead.',
      inputSchema: S({ step_id: STR('id of the open step'), error: STR('Why it cannot be completed') }, ['step_id', 'error']),
      run: (a) =>
        withLock(runId, async () => {
          const t = engine.applyFail(load(), String(a.step_id ?? ''), String(a.error ?? ''), Date.now());
          if (!t.envelope.error) {
            commit(t.run);
            kickPump();
          }
          return t.envelope;
        }),
    },
    {
      name: 'step_skip',
      description: 'Skip the open step, only when it is marked skippable and skipping is right.',
      inputSchema: S({ step_id: STR('id of the open step'), reason: STR('Why it is skipped') }, ['step_id', 'reason']),
      run: (a) =>
        withLock(runId, async () => {
          const t = engine.applySkip(load(), String(a.step_id ?? ''), String(a.reason ?? ''), Date.now());
          if (!t.envelope.error) {
            commit(t.run);
            kickPump();
          }
          return t.envelope;
        }),
    },
  ];
}

/** Evidence is persisted in every run row and rewritten on each save, so keep it bounded. */
const MAX_RESULT_CHARS = 8000;
const MAX_OUTPUT_CHARS = 4000;
const MAX_OUTPUT_KEYS = 50;

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}... [truncated]` : s;
}

function toStringMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, MAX_OUTPUT_KEYS)) {
    if (val != null) out[k] = clip(typeof val === 'string' ? val : JSON.stringify(val), MAX_OUTPUT_CHARS);
  }
  return out;
}

// ----------------------------------------------------------------- owner tools

function ownedWorkflow(agentId: string, id: string): Workflow {
  const wf = store.getWorkflow(id);
  if (!wf || wf.ownerAgentId !== agentId) throw new Error(`Workflow ${id} not found or not owned by you`);
  return wf;
}

function ownedRun(agentId: string, id: string): WorkflowRun {
  const run = store.getRun(id);
  if (!run || run.ownerAgentId !== agentId) throw new Error(`Run ${id} not found or not owned by you`);
  return run;
}

/**
 * Verdicts and fixes are only accepted inside the owner turn the dispatcher started for that run.
 * Otherwise the runner could ask the owner in plain chat (or via the HTTP API) to approve its own step.
 */
function requireOwnerTurn(runId: string, role: 'review' | 'fix'): { state: 'rejected'; error: { code: string; message: string } } | null {
  if (inFlight.get(runId) === role) return null;
  return {
    state: 'rejected',
    error: {
      code: 'NOT_YOUR_TURN',
      message: `This run is not waiting for a ${role} from you right now. The host starts a dedicated ${role} turn when it is.`,
    },
  };
}

function summary(wf: Workflow) {
  return { workflow_id: wf.id, name: wf.name, version: wf.version, steps: wf.definition.steps.length };
}

function ownerTools(agentId: string): McpTool[] {
  return [
    {
      name: 'workflow_list',
      description: 'List the workflows you own.',
      inputSchema: S({}),
      run: () => ({ workflows: store.listWorkflows(agentId).map(summary) }),
    },
    {
      name: 'workflow_get',
      description: 'Read one of your workflows: definition, version and model settings.',
      inputSchema: S({ workflow_id: STR('Workflow id') }, ['workflow_id']),
      run: (a) => {
        const wf = ownedWorkflow(agentId, String(a.workflow_id ?? ''));
        return { ...summary(wf), definition: wf.definition, settings: wf.settings };
      },
    },
    {
      name: 'workflow_save',
      description:
        'Create a workflow (omit workflow_id) or update one you own. definition = { name, description?, steps: [{ id?, title, instructions, done_when, outputs?, checks?, validate?: "none"|"owner", max_attempts?, skippable? }] }. Every change becomes a new version; running runs keep their version.',
      inputSchema: S(
        {
          workflow_id: STR('Existing workflow id to update. Omit to create.'),
          definition: { type: 'object', description: 'Workflow definition object' },
        },
        ['definition']
      ),
      run: (a) => {
        const id = String(a.workflow_id ?? '').trim();
        if (id) ownedWorkflow(agentId, id);
        const wf = store.saveWorkflow({ id: id || uuid(), ownerAgentId: agentId, definition: a.definition });
        broadcastWorkflows();
        return { ok: true, ...summary(wf), step_ids: wf.definition.steps.map((s) => s.id) };
      },
    },
    {
      name: 'run_status',
      description: 'Read a run of one of your workflows: state, every step status, evidence and verdicts.',
      inputSchema: S({ run_id: STR('Run id') }, ['run_id']),
      run: (a) => {
        const { token: _t, ...rest } = ownedRun(agentId, String(a.run_id ?? ''));
        return rest;
      },
    },
    {
      name: 'review_verdict',
      description: 'Record your review of a step in review. pass=false sends it back to the runner with your reason.',
      inputSchema: S(
        {
          run_id: STR('Run id'),
          step_id: STR('Step id under review'),
          pass: { type: 'boolean', description: 'true if the step meets done_when' },
          reason: STR('Concrete reason. On fail, exactly what the runner must fix.'),
        },
        ['run_id', 'step_id', 'pass', 'reason']
      ),
      run: (a) =>
        withLock(String(a.run_id ?? ''), async () => {
          const run = ownedRun(agentId, String(a.run_id ?? ''));
          const denied = requireOwnerTurn(run.id, 'review');
          if (denied) return denied;
          const r = engine.applyVerdict(run, String(a.step_id ?? ''), a.pass === true, String(a.reason ?? ''), Date.now());
          if (!r.ok) return { state: 'rejected', error: { code: 'REVIEW_REJECTED', message: r.error } };
          commit(r.run);
          kickPump();
          return { ok: true, run_state: r.run.state, progress: engine.progressOf(r.run) };
        }),
    },
    {
      name: 'fix_step',
      description:
        'Fix the open (failed) step of a run and restart it. patch may change title, instructions, done_when, outputs, checks, validate, max_attempts, skippable. update_workflow (default true) also saves the fix as a new workflow version.',
      inputSchema: S(
        {
          run_id: STR('Run id'),
          step_id: STR('Open step id'),
          patch: { type: 'object', description: 'Fields of the step to change' },
          update_workflow: { type: 'boolean', description: 'Also save as a new workflow version (default true)' },
        },
        ['run_id', 'step_id', 'patch']
      ),
      run: (a) =>
        withLock(String(a.run_id ?? ''), async () => {
          const run = ownedRun(agentId, String(a.run_id ?? ''));
          const denied = requireOwnerTurn(run.id, 'fix');
          if (denied) return denied;
          if (run.state !== 'needs_fix') {
            return { state: 'rejected', error: { code: 'FIX_REJECTED', message: `Run is ${run.state}, nothing to fix.` } };
          }
          const patch = a.patch && typeof a.patch === 'object' ? (a.patch as engine.StepPatch) : {};
          const r = engine.applyFix(run, String(a.step_id ?? ''), patch, Date.now());
          if (!r.ok) return { state: 'rejected', error: { code: 'FIX_REJECTED', message: r.error } };
          let savedVersion: number | null = null;
          let workflowNote: string | undefined;
          if (a.update_workflow !== false) {
            const wf = store.getWorkflow(run.workflowId);
            if (!wf) workflowNote = 'Workflow no longer exists, only this run was fixed.';
            else if (wf.version !== run.version) {
              workflowNote = `Workflow is now v${wf.version} but this run uses v${run.version}. Only this run was fixed, update the workflow with workflow_save if the newer version needs the same fix.`;
            } else if (!wf.definition.steps.some((s) => s.id === r.step.id)) {
              workflowNote = `Step ${r.step.id} is not in the saved workflow, only this run was fixed.`;
            } else {
              const steps = wf.definition.steps.map((s) => (s.id === r.step.id ? r.step : s));
              const saved = store.saveWorkflow({ id: wf.id, ownerAgentId: wf.ownerAgentId, definition: { ...wf.definition, steps } });
              if (saved.version !== wf.version) {
                savedVersion = saved.version;
                r.run.version = saved.version;
              }
              broadcastWorkflows();
            }
          }
          commit(r.run);
          kickPump();
          return { ok: true, run_state: r.run.state, workflow_version: savedVersion, ...(workflowNote ? { note: workflowNote } : {}) };
        }),
    },
    {
      name: 'retry_step',
      description: 'Restart the open step of a run unchanged (transient error like a timeout).',
      inputSchema: S({ run_id: STR('Run id'), reason: STR('Why a plain retry should work') }, ['run_id', 'reason']),
      run: (a) =>
        withLock(String(a.run_id ?? ''), async () => {
          const run = ownedRun(agentId, String(a.run_id ?? ''));
          const denied = requireOwnerTurn(run.id, 'fix');
          if (denied) return denied;
          if (run.state !== 'needs_fix') {
            return { state: 'rejected', error: { code: 'RETRY_REJECTED', message: `Run is ${run.state}, nothing to retry.` } };
          }
          const r = engine.applyRetry(run, Date.now());
          if (!r.ok) return { state: 'rejected', error: { code: 'RETRY_REJECTED', message: r.error } };
          r.run.fixesUsed += 1;
          commit(r.run);
          kickPump();
          return { ok: true, run_state: r.run.state };
        }),
    },
    {
      name: 'abort_run',
      description:
        'Pause a run at the current step. Done steps stay done. A human Resume or resume_run continues from that step. Prefer this over inventing a hard stop when a local tool is down.',
      inputSchema: S({ run_id: STR('Run id'), reason: STR('Why') }, ['run_id', 'reason']),
      run: (a) =>
        withLock(String(a.run_id ?? ''), async () => {
          const run = engine.applyAbort(ownedRun(agentId, String(a.run_id ?? '')), String(a.reason ?? ''), Date.now());
          commit(run);
          return { ok: true, run_state: run.state };
        }),
    },
    {
      name: 'resume_run',
      description:
        'Resume an aborted run from the open step. Passed and skipped steps stay done. Use after the blocker is fixed (service back up, wrong gate removed).',
      inputSchema: S({ run_id: STR('Run id'), reason: STR('Why it can continue now') }, ['run_id', 'reason']),
      run: (a) =>
        withLock(String(a.run_id ?? ''), async () => {
          const run = ownedRun(agentId, String(a.run_id ?? ''));
          if (run.state !== 'aborted') {
            return { state: 'rejected', error: { code: 'RESUME_REJECTED', message: `Run is ${run.state}, nothing to resume.` } };
          }
          const r = engine.applyRetry(run, Date.now());
          if (!r.ok) return { state: 'rejected', error: { code: 'RESUME_REJECTED', message: r.error } };
          commit(r.run);
          kickPump();
          return { ok: true, run_state: r.run.state, progress: engine.progressOf(r.run) };
        }),
    },
  ];
}

// ------------------------------------------------------------------ MCP entry

export type McpRoute = { kind: 'run'; runId: string; token: string } | { kind: 'owner'; agentId: string; token: string };

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Returns null when the route or token is invalid (caller answers 404). */
export async function handleMcp(route: McpRoute, body: unknown): Promise<{ replies: JsonRpcReply[] } | null> {
  let tools: McpTool[];
  let instructions: string;
  if (route.kind === 'run') {
    const run = store.getRun(route.runId);
    if (!run || !safeEqual(run.token, route.token)) return null;
    tools = runnerTools(run.id);
    instructions = 'Step workflow. Call step_current, do ONLY that step, report with step_done and real evidence. Never work ahead.';
  } else {
    if (!db.getAgent(route.agentId) || !safeEqual(ownerToken(route.agentId), route.token)) return null;
    tools = ownerTools(route.agentId);
    instructions = 'Workflow owner tools: create and fix workflows, review steps.';
  }
  const server = { name: route.kind === 'run' ? RUNNER_MCP_NAME : OWNER_MCP_NAME, version: '1.0.0', instructions, tools };
  const batch = Array.isArray(body) ? body : [body];
  const replies: JsonRpcReply[] = [];
  for (const msg of batch) {
    const reply = await handleMcpMessage((msg || {}) as JsonRpcMessage, server);
    if (reply) replies.push(reply);
  }
  return { replies };
}

// ------------------------------------------------------------------- starting

function broadcastWorkflows(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    try {
      w.webContents.send('workflow:list-changed', {});
    } catch {
      /* ignore */
    }
  }
}

export function startRun(input: {
  workflowId: string;
  runnerAgentId: string;
  routineId?: string | null;
  input?: string;
}): RunView {
  const wf = store.getWorkflow(input.workflowId);
  if (!wf) throw new Error('Workflow not found');
  const runner = db.getAgent(input.runnerAgentId);
  if (!runner) throw new Error('Runner agent not found');
  // The runner's Owner agent (General tab) reviews and fixes; without one, the workflow's owner does.
  const configuredOwner = typeof runner.config?.workflowOwnerAgentId === 'string' ? runner.config.workflowOwnerAgentId : '';
  const ownerAgentId = configuredOwner && db.getAgent(configuredOwner) ? configuredOwner : wf.ownerAgentId;
  if (!db.getAgent(ownerAgentId)) throw new Error('Owner agent not found');
  const run = engine.createRun({
    id: uuid(),
    token: crypto.randomBytes(18).toString('hex'),
    workflowId: wf.id,
    workflowName: wf.name,
    version: wf.version,
    definition: wf.definition,
    runnerAgentId: input.runnerAgentId,
    ownerAgentId,
    routineId: input.routineId ?? null,
    input: input.input ?? '',
    now: Date.now(),
  });
  commit(run);
  kickPump();
  return viewOf(run);
}

/** Routine fired in Step workflow mode: resume its active or aborted run, or start a new one. */
export function startFromRoutine(r: db.RoutineRow): { ok: boolean; run?: RunView; note?: string } {
  if (!r.workflowId) return { ok: false, note: 'Routine has no workflow' };
  const active = store.listActiveRuns().find((x) => x.routineId === r.id && x.state !== 'blocked');
  if (active) {
    kickPump();
    return {
      ok: true,
      run: viewOf(active),
      note: 'Previous run still active, resumed.',
    };
  }
  const latest = store.getLatestRunForRoutine(r.id);
  if (latest?.state === 'aborted') {
    const rsm = engine.applyRetry(latest, Date.now());
    if (rsm.ok) {
      commit(rsm.run);
      db.flushPersist();
      kickPump();
      return {
        ok: true,
        run: viewOf(rsm.run),
        note: `Resumed aborted run from step ${rsm.run.currentIndex + 1}.`,
      };
    }
  }
  try {
    return { ok: true, run: startRun({ workflowId: r.workflowId, runnerAgentId: r.agentId, routineId: r.id, input: r.prompt }) };
  } catch (e) {
    console.error('[TecAdRiseBot] workflow start failed', r.id, e);
    return { ok: false, note: e instanceof Error ? e.message : String(e) };
  }
}

// ------------------------------------------------------------ human actions

export function humanAction(runId: string, action: 'retry' | 'skip' | 'abort'): Promise<RunView> {
  return withLock(runId, async () => {
    const run = store.getRun(runId);
    if (!run) throw new Error('Run not found');
    const now = Date.now();
    let next: WorkflowRun;
    if (action === 'abort') next = engine.applyAbort(run, 'Aborted by user', now);
    else if (action === 'skip') {
      const def = run.definition.steps[run.currentIndex];
      if (!def) throw new Error('Run has no open step');
      const t = engine.applySkip(run, def.id, 'Skipped by user', now, true);
      if (t.envelope.error) throw new Error(t.envelope.error.message);
      next = t.run;
    } else {
      const r = engine.applyRetry(run, now);
      if (!r.ok) throw new Error(r.error);
      next = r.run;
    }
    commit(next);
    db.flushPersist();
    kickPump();
    return viewOf(next);
  });
}

// ---------------------------------------------------------------- dispatcher

export function kickPump(): void {
  setTimeout(() => void pump(), 50);
}

/** Called by the scheduler tick and after every state change. */
export async function pump(): Promise<void> {
  if (pumping) {
    pumpAgain = true;
    return;
  }
  pumping = true;
  try {
    do {
      pumpAgain = false;
      for (const run of store.listActiveRuns()) dispatch(run);
    } while (pumpAgain);
  } catch (e) {
    console.error('[TecAdRiseBot] workflow pump', e);
  } finally {
    pumping = false;
  }
}

function agentFree(agentId: string): boolean {
  return !isAgentBusy(agentId) && !dispatchedAgents.has(agentId);
}

function fingerprint(run: WorkflowRun): string {
  const st = run.steps[run.currentIndex];
  return `${run.state}:${run.currentIndex}:${st?.status}:${st?.attempts}:${st?.result ?? ''}:${st?.verdict?.at ?? ''}`;
}

function dispatch(run: WorkflowRun): void {
  if (inFlight.has(run.id) || run.state === 'blocked') return;
  for (const id of [run.runnerAgentId, run.ownerAgentId]) {
    if (!db.getAgent(id)) {
      commit(engine.applyBlock(run, `Agent ${id} no longer exists.`, Date.now()));
      return;
    }
  }
  const wf = store.getWorkflow(run.workflowId);
  if (run.state === 'running') {
    if (!agentFree(run.runnerAgentId)) return;
    void runTurn(run, 'runner', wf);
  } else if (run.state === 'awaiting_review') {
    if (!agentFree(run.ownerAgentId)) return;
    void runTurn(run, 'review', wf);
  } else if (run.state === 'needs_fix') {
    if (run.fixesUsed >= MAX_FIXES_PER_RUN) {
      commit(engine.applyBlock(run, `Owner fix limit (${MAX_FIXES_PER_RUN}) reached. A human must retry, skip or abort.`, Date.now()));
      return;
    }
    if (!agentFree(run.ownerAgentId)) return;
    void runTurn(run, 'fix', wf);
  }
}

/**
 * Owner turns run with the runner agent's model, mode and effort, then the workflow's owner settings, then the
 * runner's own Owner overrides (General tab), each field overriding the previous one.
 */
function ownerOverride(run: WorkflowRun, wf: Workflow | null): RoleOverride | undefined {
  const runner = db.getAgent(run.runnerAgentId);
  if (!runner) return wf?.settings.owner;
  return { ...runnerSettings(runner), ...wf?.settings.owner, ...ownerRoleOverride(runner.config) };
}

function runnerSettings(runner: db.AgentRow): RoleOverride {
  return {
    model: baseModelId(runner.model),
    modelMode: readModelMode(runner.config, runner.model),
    effort: readEffort(runner.config),
  };
}

/** Model settings the runner's Owner agent works with: the runner's settings plus its Owner row overrides. */
export function ownerSettingsForRunner(runnerAgentId: string): RoleOverride | undefined {
  const runner = db.getAgent(runnerAgentId);
  return runner ? { ...runnerSettings(runner), ...ownerRoleOverride(runner.config) } : undefined;
}

async function runTurn(run: WorkflowRun, role: 'runner' | 'review' | 'fix', wf: Workflow | null): Promise<void> {
  const agentId = role === 'runner' ? run.runnerAgentId : run.ownerAgentId;
  const before = fingerprint(run);
  inFlight.set(run.id, role);
  dispatchedAgents.add(agentId);
  broadcast(run);
  const runnerWs = db.agentWorkspacePath(run.runnerAgentId);
  const runnerName = db.getAgent(run.runnerAgentId)?.name ?? 'runner';
  let extras: TurnExtras;
  let userText: string;
  if (role === 'runner') {
    const started = run.currentIndex === 0 && run.steps[0].attempts === 0 && !run.steps[0].result && run.idleTurns === 0;
    userText = runnerKickoff(run, engine.runnerView(run), started ? 'start' : 'resume');
    extras = {
      extraMcp: { [RUNNER_MCP_NAME]: { type: 'http', url: runnerUrl(run) } },
      modelOverride: wf?.settings.runner,
      checklistBlock: RUNNER_RULES,
      meta: { workflow: { runId: run.id, role } },
      noTodoSeed: true,
      noAutoContinue: true,
      noAugment: true,
    };
  } else {
    userText = role === 'review' ? ownerReviewPrompt(run, runnerName, runnerWs) : ownerFixPrompt(run, runnerName, runnerWs);
    extras = {
      ...ownerExtras(run.ownerAgentId),
      modelOverride: ownerOverride(run, wf),
      extraDirs: [runnerWs],
      meta: { workflow: { runId: run.id, role } },
      noTodoSeed: true,
      noAutoContinue: true,
    };
  }
  let stopped = false;
  try {
    const res = await runAgentTurn({ agentId, userText, win: getWindow(), source: 'routine', extras });
    stopped = !!res.stopped;
  } catch (e) {
    console.error('[TecAdRiseBot] workflow turn failed', run.id, role, e);
  }
  // inFlight stays set until the idle/block bookkeeping is committed, so the pump cannot start a second turn.
  try {
    await settleTurn(run.id, role, before, stopped);
  } catch (e) {
    console.error('[TecAdRiseBot] workflow turn settle failed', run.id, role, e);
  } finally {
    inFlight.delete(run.id);
    dispatchedAgents.delete(agentId);
  }
  const after = store.getRun(run.id);
  if (after) broadcast(after);
  kickPump();
}

function settleTurn(runId: string, role: 'runner' | 'review' | 'fix', before: string, stopped: boolean): Promise<void> {
  return withLock(runId, async () => {
    const cur = store.getRun(runId);
    if (!cur || !isRunActive(cur.state)) return;
    if (stopped) {
      commit(engine.applyBlock(cur, `Stopped by user during ${role} turn. Retry to continue.`, Date.now()));
      return;
    }
    if (fingerprint(cur) !== before) return;
    const idle = { ...cur, idleTurns: cur.idleTurns + 1, updatedAt: Date.now() };
    const limit = role === 'runner' ? MAX_RUNNER_IDLE : MAX_OWNER_IDLE;
    if (idle.idleTurns >= limit) {
      const who = role === 'runner' ? 'Runner' : 'Owner';
      const what = role === 'runner' ? 'reporting step progress' : role === 'review' ? 'recording a verdict' : 'fixing the step';
      commit(engine.applyBlock(idle, `${who} ended ${idle.idleTurns} turns without ${what}.`, Date.now()));
      return;
    }
    commit(idle);
  });
}

// ------------------------------------------------------------------ queries

export function listWorkflowsView(ownerAgentId?: string): Workflow[] {
  return store.listWorkflows(ownerAgentId);
}

export function listRunsView(filter: { workflowId?: string; agentId?: string; limit?: number }): RunView[] {
  return store.listRuns(filter).map(viewOf);
}

export function getRunView(id: string): RunView | null {
  const run = store.getRun(id);
  return run ? viewOf(run) : null;
}

export function saveWorkflowFromUi(input: { id?: string; ownerAgentId: string; definition: unknown; settings?: unknown }): Workflow {
  if (!db.getAgent(input.ownerAgentId)) throw new Error('Owner agent not found');
  const wf = store.saveWorkflow({ id: input.id || uuid(), ownerAgentId: input.ownerAgentId, definition: input.definition, settings: input.settings });
  broadcastWorkflows();
  return wf;
}

export async function deleteWorkflowFromUi(id: string): Promise<{ ok: true }> {
  for (const active of store.listActiveRuns().filter((r) => r.workflowId === id)) {
    await withLock(active.id, async () => {
      const run = store.getRun(active.id);
      if (run) commit(engine.applyAbort(run, 'Workflow deleted', Date.now()));
    });
  }
  for (const r of db.listRoutines().filter((x) => x.workflowId === id)) {
    db.updateRoutine(r.id, { workflowId: null });
  }
  store.deleteWorkflow(id);
  broadcastWorkflows();
  return { ok: true };
}
