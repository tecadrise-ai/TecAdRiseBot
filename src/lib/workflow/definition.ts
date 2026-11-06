import type { CheckDef, StepDef, WorkflowDefinition, WorkflowSettings, RoleOverride } from './types.ts';

export const DEFAULT_MAX_ATTEMPTS = 3;
export const MAX_STEPS = 100;

export class DefinitionError extends Error {}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function slug(v: string): string {
  return v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function assertRegex(pattern: string, where: string): void {
  if (pattern.length > 500) throw new DefinitionError(`${where}: regex longer than 500 characters`);
  try {
    new RegExp(pattern);
  } catch (e) {
    throw new DefinitionError(`${where}: invalid regex "${pattern}" (${e instanceof Error ? e.message : e})`);
  }
}

function normalizeCheck(raw: unknown, where: string): CheckDef {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DefinitionError(`${where}: check must be an object`);
  }
  const o = raw as Record<string, unknown>;
  const type = str(o.type);
  if (type === 'file_exists') {
    const path = str(o.path);
    if (!path) throw new DefinitionError(`${where}: file_exists needs "path"`);
    return { type, path };
  }
  if (type === 'file_contains') {
    const path = str(o.path);
    const pattern = str(o.pattern);
    if (!path || !pattern) throw new DefinitionError(`${where}: file_contains needs "path" and "pattern"`);
    assertRegex(pattern, where);
    return { type, path, pattern };
  }
  if (type === 'output_matches') {
    const key = str(o.key);
    const pattern = str(o.pattern);
    if (!key || !pattern) throw new DefinitionError(`${where}: output_matches needs "key" and "pattern"`);
    assertRegex(pattern, where);
    return { type, key, pattern };
  }
  if (type === 'command') {
    const run = str(o.run);
    if (!run) throw new DefinitionError(`${where}: command needs "run"`);
    const t = Number(o.timeout_s);
    const timeout_s = Number.isFinite(t) && t > 0 ? Math.min(600, Math.round(t)) : 60;
    return { type, run, timeout_s };
  }
  throw new DefinitionError(
    `${where}: unknown check type "${type}". Use file_exists, file_contains, output_matches or command.`
  );
}

function normalizeStep(raw: unknown, index: number, seen: Set<string>): StepDef {
  const where = `steps[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DefinitionError(`${where} must be an object`);
  }
  const o = raw as Record<string, unknown>;
  const title = str(o.title);
  if (!title) throw new DefinitionError(`${where}: "title" is required`);
  const instructions = str(o.instructions) || title;
  const done_when = str(o.done_when);
  if (!done_when) throw new DefinitionError(`${where}: "done_when" is required (what proves the step is done)`);
  let id = slug(str(o.id) || title) || `step-${index + 1}`;
  if (seen.has(id)) id = `${id}-${index + 1}`;
  seen.add(id);
  const outputs = Array.isArray(o.outputs) ? o.outputs.map((x) => str(x)).filter(Boolean) : [];
  const checks = Array.isArray(o.checks)
    ? o.checks.map((c, i) => normalizeCheck(c, `${where}.checks[${i}]`))
    : [];
  for (const c of checks) {
    if (c.type === 'output_matches' && !outputs.includes(c.key)) outputs.push(c.key);
  }
  const validate = str(o.validate) === 'owner' ? 'owner' : 'none';
  const ma = Number(o.max_attempts);
  const max_attempts = Number.isFinite(ma) && ma >= 1 ? Math.min(10, Math.round(ma)) : DEFAULT_MAX_ATTEMPTS;
  return {
    id,
    title,
    instructions,
    done_when,
    outputs,
    checks,
    validate,
    max_attempts,
    skippable: o.skippable === true,
  };
}

/** Parse and validate a workflow definition. Throws DefinitionError with a precise message. */
export function normalizeDefinition(raw: unknown): WorkflowDefinition {
  let v = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch (e) {
      throw new DefinitionError(`Invalid JSON: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new DefinitionError('Definition must be an object with "name" and "steps"');
  }
  const o = v as Record<string, unknown>;
  const name = str(o.name);
  if (!name) throw new DefinitionError('"name" is required');
  if (!Array.isArray(o.steps) || !o.steps.length) {
    throw new DefinitionError('"steps" must be a non-empty array');
  }
  if (o.steps.length > MAX_STEPS) throw new DefinitionError(`At most ${MAX_STEPS} steps`);
  const seen = new Set<string>();
  const steps = o.steps.map((s, i) => normalizeStep(s, i, seen));
  return { name, description: str(o.description), steps };
}

function normalizeRole(raw: unknown): RoleOverride | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const out: RoleOverride = {};
  if (str(o.model)) out.model = str(o.model);
  if (str(o.modelMode) === 'fast' || str(o.modelMode) === 'usual') out.modelMode = str(o.modelMode);
  if (str(o.effort)) out.effort = str(o.effort).toLowerCase();
  if (str(o.runtime) === 'byok') {
    out.runtime = 'byok';
    if (str(o.byokProviderId)) out.byokProviderId = str(o.byokProviderId);
    if (str(o.byokModelId)) out.byokModelId = str(o.byokModelId);
  }
  return Object.keys(out).length ? out : undefined;
}

export function normalizeSettings(raw: unknown): WorkflowSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const out: WorkflowSettings = {};
  const runner = normalizeRole(o.runner);
  const owner = normalizeRole(o.owner);
  if (runner) out.runner = runner;
  if (owner) out.owner = owner;
  return out;
}

/** The Owner role's model, mode and effort from the agent's General tab; empty fields follow the Runner. */
export function ownerRoleOverride(config: Record<string, unknown> | null | undefined): RoleOverride | undefined {
  return normalizeRole(config?.workflowOwnerOverride);
}

export const EXAMPLE_DEFINITION: WorkflowDefinition = {
  name: 'Example workflow',
  description: 'Replace with your steps. The runner sees one step at a time.',
  steps: [
    {
      id: 'collect',
      title: 'Collect input',
      instructions: 'Write the list of items to process into items.txt in your workspace, one per line.',
      done_when: 'items.txt exists and has at least one line.',
      outputs: ['count'],
      checks: [
        { type: 'file_exists', path: 'items.txt' },
        { type: 'output_matches', key: 'count', pattern: '^[1-9][0-9]*$' },
      ],
      validate: 'none',
      max_attempts: 3,
      skippable: false,
    },
    {
      id: 'process',
      title: 'Process items',
      instructions: 'Process every item from items.txt and write results to results.md.',
      done_when: 'results.md has one section per item.',
      outputs: [],
      checks: [{ type: 'file_exists', path: 'results.md' }],
      validate: 'owner',
      max_attempts: 3,
      skippable: false,
    },
  ],
};
