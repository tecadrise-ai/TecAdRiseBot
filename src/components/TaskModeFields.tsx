import type { Workflow } from '../types';
import type { RoleOverride, WorkflowSettings } from '../lib/workflow/types';
import { dropdownModels, effortParam, type CatalogModel } from '../lib/modelOptions';

export type TaskMode = 'off' | 'todos' | 'workflow';

type Props = {
  /** Runner agent of the routine. Its own workflows are excluded, a runner cannot review itself. */
  agentId: string;
  mode: TaskMode;
  workflowId: string;
  workflows: Workflow[];
  onMode: (mode: TaskMode) => void;
  onWorkflow: (id: string) => void;
  /** Runner/owner model overrides for this routine, empty fields fall back to the workflow, then the agent. */
  settings: WorkflowSettings;
  onSettings: (s: WorkflowSettings) => void;
  models: CatalogModel[];
};

function setField(r: RoleOverride | undefined, key: keyof RoleOverride, value: string): RoleOverride | undefined {
  const next: RoleOverride = { ...r };
  if (value) next[key] = value;
  else delete next[key];
  if (key === 'model') delete next.effort;
  return Object.keys(next).length ? next : undefined;
}

export function TaskModeFields({
  agentId,
  mode,
  workflowId,
  workflows,
  onMode,
  onWorkflow,
  settings,
  onSettings,
  models,
}: Props) {
  const usable = workflows.filter((w) => w.ownerAgentId !== agentId);
  const selected = workflows.find((w) => w.id === workflowId);
  const options = dropdownModels(models);

  function roleRow(role: 'runner' | 'owner', label: string) {
    const r = settings[role];
    const base = selected?.settings[role];
    const efforts = effortParam(models.find((m) => m.id === (r?.model || base?.model))).values;
    const update = (key: keyof RoleOverride, value: string) => onSettings({ ...settings, [role]: setField(r, key, value) });
    return (
      <>
        <span>{label}</span>
        <select value={r?.model || ''} onChange={(e) => update('model', e.target.value)}>
          <option value="">{base?.model ? `Workflow default (${base.model})` : 'Agent default model'}</option>
          {options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName || m.id}
            </option>
          ))}
          {r?.model && !options.some((m) => m.id === r.model) ? <option value={r.model}>{r.model}</option> : null}
        </select>
        <select value={r?.modelMode || ''} onChange={(e) => update('modelMode', e.target.value)}>
          <option value="">{base?.modelMode ? `Workflow default (${base.modelMode})` : 'Agent default mode'}</option>
          <option value="usual">Usual</option>
          <option value="fast">Fast</option>
        </select>
        <select value={r?.effort || ''} onChange={(e) => update('effort', e.target.value)}>
          <option value="">{base?.effort ? `Workflow default (${base.effort})` : 'Agent default effort'}</option>
          {efforts.map((v) => (
            <option key={v.value} value={v.value}>
              {v.displayName || v.value}
            </option>
          ))}
          {r?.effort && !efforts.some((v) => v.value === r.effort) ? <option value={r.effort}>{r.effort}</option> : null}
        </select>
      </>
    );
  }

  return (
    <>
      <div className="routine-form-grid">
        <label className="field">
          <span>Task mode</span>
          <select value={mode} onChange={(e) => onMode(e.target.value as TaskMode)}>
            <option value="off">Off</option>
            <option value="todos">Force updateTodos</option>
            <option value="workflow">Step workflow</option>
          </select>
        </label>
        {mode === 'workflow' ? (
          <label className="field">
            <span>Workflow</span>
            <select value={workflowId} onChange={(e) => onWorkflow(e.target.value)}>
              <option value="">Select a workflow</option>
              {usable.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} (v{w.version}, {w.definition.steps.length} steps)
                </option>
              ))}
              {workflowId && !usable.some((w) => w.id === workflowId) ? (
                <option value={workflowId}>Unavailable workflow</option>
              ) : null}
            </select>
            {usable.length === 0 ? (
              <span className="hint">No workflows yet. Enable Workflow owner on another agent and create one there.</span>
            ) : null}
          </label>
        ) : null}
      </div>
      {mode === 'workflow' ? (
        <div className="field">
          <span>Workflow agents</span>
          <div className="wf-overrides">
            {roleRow('runner', 'Runner')}
            {roleRow('owner', 'Owner')}
          </div>
          <span className="hint">
            Runner is this agent, it executes the steps. Owner is {selected ? `the agent that owns "${selected.name}"` : 'the workflow owner agent'},
            it reviews and fixes steps. Empty fields use the workflow default, then the agent's own settings.
          </span>
        </div>
      ) : null}
    </>
  );
}
