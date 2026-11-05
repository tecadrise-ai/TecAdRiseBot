import * as db from '../db';
import { normalizeDefinition, normalizeSettings } from '../../src/lib/workflow/definition';
import type { Workflow, WorkflowDefinition, WorkflowRun, WorkflowSettings } from '../../src/lib/workflow/types';
import { ACTIVE_RUN_STATES } from '../../src/lib/workflow/types';

function parse<T>(raw: unknown, fallback: T): T {
  try {
    return raw ? (JSON.parse(String(raw)) as T) : fallback;
  } catch {
    return fallback;
  }
}

function mapWorkflow(r: Record<string, unknown>): Workflow {
  return {
    id: String(r.id),
    name: String(r.name),
    ownerAgentId: String(r.owner_agent_id),
    version: Number(r.version),
    definition: parse<WorkflowDefinition>(r.definition_json, { name: String(r.name), description: '', steps: [] }),
    settings: normalizeSettings(parse(r.settings_json, {})),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export function listWorkflows(ownerAgentId?: string): Workflow[] {
  const rows = ownerAgentId
    ? db.dbAll(`SELECT * FROM workflows WHERE owner_agent_id=$o ORDER BY name`, { $o: ownerAgentId })
    : db.dbAll(`SELECT * FROM workflows ORDER BY name`);
  return rows.map(mapWorkflow);
}

export function getWorkflow(id: string): Workflow | null {
  const rows = db.dbAll(`SELECT * FROM workflows WHERE id=$id`, { $id: id });
  return rows.length ? mapWorkflow(rows[0]) : null;
}

/** Create or update. Every definition change is stored as a new version. */
export function saveWorkflow(input: {
  id: string;
  ownerAgentId: string;
  definition: unknown;
  settings?: unknown;
}): Workflow {
  const definition = normalizeDefinition(input.definition);
  const now = Date.now();
  const existing = getWorkflow(input.id);
  const settings: WorkflowSettings =
    input.settings !== undefined ? normalizeSettings(input.settings) : existing?.settings ?? {};
  const defJson = JSON.stringify(definition);
  if (!existing) {
    db.dbRun(
      `INSERT INTO workflows (id, name, owner_agent_id, version, definition_json, settings_json, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
      [input.id, definition.name, input.ownerAgentId, defJson, JSON.stringify(settings), now, now]
    );
    db.dbRun(`INSERT INTO workflow_versions (workflow_id, version, definition_json, created_at) VALUES (?, 1, ?, ?)`, [
      input.id,
      defJson,
      now,
    ]);
    return getWorkflow(input.id)!;
  }
  const changed = JSON.stringify(existing.definition) !== defJson;
  const version = changed ? existing.version + 1 : existing.version;
  db.dbRun(
    `UPDATE workflows SET name=?, owner_agent_id=?, version=?, definition_json=?, settings_json=?, updated_at=? WHERE id=?`,
    [definition.name, input.ownerAgentId, version, defJson, JSON.stringify(settings), now, input.id]
  );
  if (changed) {
    db.dbRun(`INSERT INTO workflow_versions (workflow_id, version, definition_json, created_at) VALUES (?, ?, ?, ?)`, [
      input.id,
      version,
      defJson,
      now,
    ]);
  }
  return getWorkflow(input.id)!;
}

export function deleteWorkflow(id: string): void {
  db.dbRun(`DELETE FROM workflows WHERE id=?`, [id]);
  db.dbRun(`DELETE FROM workflow_versions WHERE workflow_id=?`, [id]);
}

export function saveRun(run: WorkflowRun): void {
  const exists = db.dbAll(`SELECT id FROM workflow_runs WHERE id=$id`, { $id: run.id }).length > 0;
  const json = JSON.stringify(run);
  if (exists) {
    db.dbRun(`UPDATE workflow_runs SET state=?, run_json=?, updated_at=? WHERE id=?`, [run.state, json, run.updatedAt, run.id]);
  } else {
    db.dbRun(
      `INSERT INTO workflow_runs (id, workflow_id, runner_agent_id, owner_agent_id, routine_id, state, run_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [run.id, run.workflowId, run.runnerAgentId, run.ownerAgentId, run.routineId, run.state, json, run.createdAt, run.updatedAt]
    );
  }
}

/** Finished runs kept per workflow; older done/aborted runs are deleted. */
const KEEP_FINISHED_RUNS = 50;

export function pruneFinishedRuns(workflowId: string): void {
  const rows = db.dbAll(
    `SELECT id FROM workflow_runs WHERE workflow_id=$w AND state IN ('done','aborted') ORDER BY created_at DESC LIMIT -1 OFFSET ${KEEP_FINISHED_RUNS}`,
    { $w: workflowId }
  );
  for (const r of rows) db.dbRun(`DELETE FROM workflow_runs WHERE id=?`, [String(r.id)]);
}

export function getRun(id: string): WorkflowRun | null {
  const rows = db.dbAll(`SELECT run_json FROM workflow_runs WHERE id=$id`, { $id: id });
  return rows.length ? parse<WorkflowRun | null>(rows[0].run_json, null) : null;
}

export function getLatestRunForRoutine(routineId: string): WorkflowRun | null {
  const rows = db.dbAll(
    `SELECT run_json FROM workflow_runs WHERE routine_id=$r ORDER BY created_at DESC LIMIT 1`,
    { $r: routineId }
  );
  return rows.length ? parse<WorkflowRun | null>(rows[0].run_json, null) : null;
}

export function listActiveRuns(): WorkflowRun[] {
  const states = ACTIVE_RUN_STATES.map((s) => `'${s}'`).join(',');
  return db
    .dbAll(`SELECT run_json FROM workflow_runs WHERE state IN (${states}) ORDER BY created_at`)
    .map((r) => parse<WorkflowRun | null>(r.run_json, null))
    .filter((r): r is WorkflowRun => !!r);
}

export function listRuns(filter: { workflowId?: string; agentId?: string; limit?: number } = {}): WorkflowRun[] {
  const limit = Math.max(1, Math.min(200, filter.limit ?? 30));
  let rows: Record<string, unknown>[];
  if (filter.workflowId) {
    rows = db.dbAll(`SELECT run_json FROM workflow_runs WHERE workflow_id=$w ORDER BY created_at DESC LIMIT ${limit}`, {
      $w: filter.workflowId,
    });
  } else if (filter.agentId) {
    rows = db.dbAll(
      `SELECT run_json FROM workflow_runs WHERE runner_agent_id=$a OR owner_agent_id=$a ORDER BY created_at DESC LIMIT ${limit}`,
      { $a: filter.agentId }
    );
  } else {
    rows = db.dbAll(`SELECT run_json FROM workflow_runs ORDER BY created_at DESC LIMIT ${limit}`);
  }
  return rows.map((r) => parse<WorkflowRun | null>(r.run_json, null)).filter((r): r is WorkflowRun => !!r);
}
