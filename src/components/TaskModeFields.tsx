import type { Workflow } from '../types';

export type TaskMode = 'off' | 'todos' | 'workflow';

type Props = {
  /** Runner agent of the routine. Its own workflows are excluded, a runner cannot review itself. */
  agentId: string;
  mode: TaskMode;
  workflowId: string;
  workflows: Workflow[];
  onMode: (mode: TaskMode) => void;
  onWorkflow: (id: string) => void;
};

export function TaskModeFields({ agentId, mode, workflowId, workflows, onMode, onWorkflow }: Props) {
  const usable = workflows.filter((w) => w.ownerAgentId !== agentId);
  return (
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
            <span className="hint">No workflows yet. Create one in another agent's Workflows tab, that agent is its owner.</span>
          ) : null}
        </label>
      ) : null}
    </div>
  );
}
