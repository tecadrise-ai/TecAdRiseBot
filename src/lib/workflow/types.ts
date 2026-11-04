export type CheckDef =
  | { type: 'file_exists'; path: string }
  | { type: 'file_contains'; path: string; pattern: string }
  | { type: 'output_matches'; key: string; pattern: string }
  | { type: 'command'; run: string; timeout_s?: number };

export type StepDef = {
  id: string;
  title: string;
  instructions: string;
  done_when: string;
  outputs: string[];
  checks: CheckDef[];
  validate: 'none' | 'owner';
  max_attempts: number;
  skippable: boolean;
};

export type WorkflowDefinition = {
  name: string;
  description: string;
  steps: StepDef[];
};

export type RoleOverride = { model?: string; modelMode?: string; effort?: string };

export type WorkflowSettings = {
  runner?: RoleOverride;
  owner?: RoleOverride;
};

export type Workflow = {
  id: string;
  name: string;
  ownerAgentId: string;
  version: number;
  definition: WorkflowDefinition;
  settings: WorkflowSettings;
  createdAt: number;
  updatedAt: number;
};

export type StepStatus = 'pending' | 'active' | 'review' | 'passed' | 'failed' | 'skipped';

export type CheckResult = { type: string; ok: boolean; detail: string };

export type StepState = {
  status: StepStatus;
  attempts: number;
  result?: string;
  outputs?: Record<string, string>;
  artifacts?: string[];
  checks?: CheckResult[];
  verdict?: { pass: boolean; reason: string; at: number };
  error?: string;
  startedAt?: number;
  finishedAt?: number;
};

/**
 * running: runner works on the active step.
 * awaiting_review: owner must review the step in "review".
 * needs_fix: a step failed, owner must fix it (or a human).
 * blocked: automation gave up, a human must act in the UI.
 */
export type RunState = 'running' | 'awaiting_review' | 'needs_fix' | 'blocked' | 'done' | 'aborted';

export type WorkflowRun = {
  id: string;
  workflowId: string;
  workflowName: string;
  version: number;
  runnerAgentId: string;
  ownerAgentId: string;
  routineId: string | null;
  token: string;
  state: RunState;
  currentIndex: number;
  definition: WorkflowDefinition;
  steps: StepState[];
  input: string;
  blockedReason: string | null;
  /** State the run was in when it got blocked, so a human Retry can resume a pending review. */
  blockedFrom?: RunState | null;
  /** Owner fix turns used in this run. */
  fixesUsed: number;
  /** Consecutive runner or owner turns that changed nothing. */
  idleTurns: number;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
};

export const ACTIVE_RUN_STATES: RunState[] = ['running', 'awaiting_review', 'needs_fix', 'blocked'];

export function isRunActive(state: RunState): boolean {
  return ACTIVE_RUN_STATES.includes(state);
}
