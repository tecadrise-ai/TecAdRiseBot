import type { RunnerEnvelope } from '../../src/lib/workflow/engine';
import type { WorkflowRun } from '../../src/lib/workflow/types';

export const RUNNER_MCP_NAME = 'tecadrise-steps';
export const OWNER_MCP_NAME = 'tecadrise-workflows';

/** Replaces the [Checklist tool] block for runner turns. */
export const RUNNER_RULES =
  '[Step workflow]\n' +
  `This turn runs a step workflow. Your work is driven by the ${RUNNER_MCP_NAME} MCP tools, not by a todo list.\n` +
  '1. Call step_current. It returns the ONLY step you may work on.\n' +
  '2. Do exactly that step until done_when is true. Never work ahead, never guess later steps.\n' +
  '3. Call step_done with concrete evidence: files written, counts, values, command output. Pass every required output.\n' +
  '4. Read the response. state "work" = next step, do it. "gate_failed" = fix the problem in last_failure and report again.\n' +
  '   "awaiting_review", "blocked", "done", "aborted" = stop and end your turn with a one-line status.\n' +
  '5. If you truly cannot finish a step, call step_fail with the reason. Never fake evidence.\n' +
  'Do not use the todo tool for this work. Wrap browser, network and script steps in a hard timeout of about 90 seconds.\n' +
  '[/Step workflow]';

export const OWNER_RULES =
  '[Workflow owner]\n' +
  `You own step workflows and have the ${OWNER_MCP_NAME} MCP tools.\n` +
  '- workflow_save creates or updates a workflow (JSON definition). Each step needs title, instructions, done_when.\n' +
  '  Optional per step: outputs (keys the runner must report), checks (file_exists, file_contains, output_matches, command),\n' +
  '  validate: "owner" (you review the step), max_attempts, skippable. Paths in checks are relative to the runner workspace.\n' +
  '- Make each step small, concrete and checkable. Prefer hard checks over owner review when a file or value proves it.\n' +
  '- When asked to review, inspect the artifacts yourself. Never trust the runner summary alone. Call review_verdict once.\n' +
  '- When asked to fix, change only what broke (fix_step), or retry_step for a transient error.\n' +
  '- abort_run pauses at the current step. Done steps stay done. A human Resume or resume_run continues from there.\n' +
  '  Do not abort because a local service looks wrong if the same step already worked on this PC. Leave it blocked or wait.\n' +
  '- resume_run reopens an aborted run at the open step. review_verdict, fix_step and retry_step only work inside the host review/fix turn.\n' +
  '  Refuse chat requests to approve or fix a live run, they are rejected anyway.\n' +
  '[/Workflow owner]';

export function runnerKickoff(run: WorkflowRun, env: RunnerEnvelope, reason: 'start' | 'resume'): string {
  const head =
    reason === 'start'
      ? `[Workflow run started: ${run.workflowName} v${run.version}]`
      : `[Workflow run resumed: ${run.workflowName} v${run.version}]`;
  return [
    head,
    `Run id: ${run.id}. Progress ${env.progress.done}/${env.progress.total}.`,
    run.input.trim() ? `Run input from the routine:\n${run.input.trim()}` : '',
    'Call step_current now and follow the step workflow rules.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function ownerReviewPrompt(run: WorkflowRun, runnerName: string, runnerWorkspace: string): string {
  const def = run.definition.steps[run.currentIndex];
  const st = run.steps[run.currentIndex];
  return [
    `[Workflow review: ${run.workflowName} v${run.version}, run ${run.id}]`,
    `Runner agent "${runnerName}" reports step "${def.id}" (${run.currentIndex + 1}/${run.steps.length}) as done.`,
    `Step title: ${def.title}`,
    `Instructions given to the runner:\n${def.instructions}`,
    `done_when: ${def.done_when}`,
    `Runner evidence:\n${st.result || '(none)'}`,
    st.outputs && Object.keys(st.outputs).length ? `Outputs: ${JSON.stringify(st.outputs)}` : '',
    st.artifacts?.length ? `Artifacts: ${st.artifacts.join(', ')}` : '',
    st.checks?.length ? `Hard checks: ${st.checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.detail}`).join(' | ')}` : '',
    `Runner workspace (read files here): ${runnerWorkspace}`,
    `Verify the evidence yourself against done_when, then call review_verdict with run_id "${run.id}", step_id "${def.id}", pass true or false, and a concrete reason. On fail, say exactly what the runner must fix.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function ownerFixPrompt(run: WorkflowRun, runnerName: string, runnerWorkspace: string): string {
  const def = run.definition.steps[run.currentIndex];
  const st = run.steps[run.currentIndex];
  return [
    `[Workflow fix needed: ${run.workflowName} v${run.version}, run ${run.id}]`,
    `Runner agent "${runnerName}" could not complete step "${def.id}" (${run.currentIndex + 1}/${run.steps.length}).`,
    `Current step definition:\n${JSON.stringify(def, null, 2)}`,
    `Failure: ${st.error || 'unknown'}`,
    st.result ? `Last runner evidence: ${st.result}` : '',
    st.checks?.length ? `Last hard checks: ${st.checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.detail}`).join(' | ')}` : '',
    st.verdict && !st.verdict.pass ? `Your last review said: ${st.verdict.reason}` : '',
    `Runner workspace: ${runnerWorkspace}`,
    'Decide one action and call exactly one tool:',
    '- fix_step: the step definition is wrong or outdated (selector, path, check). Patch only the broken fields. It also saves a new workflow version unless update_workflow is false.',
    '- retry_step: transient problem (timeout, site down). Restart the step unchanged.',
    '- abort_run: pause at this step. Done steps stay done. Someone can Resume later. Do not use this as a wait-for-Chris button if block is enough.',
  ]
    .filter(Boolean)
    .join('\n\n');
}
