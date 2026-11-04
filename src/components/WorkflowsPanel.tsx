import { useEffect, useState } from 'react';
import type { Agent, Workflow, WorkflowRunView } from '../types';
import type { RoleOverride, WorkflowSettings } from '../lib/workflow/types';
import { EXAMPLE_DEFINITION } from '../lib/workflow/definition';
import { dropdownModels, effortParam, type CatalogModel } from '../lib/modelOptions';
import { WorkflowCard } from './WorkflowCard';

type Props = {
  agent: Agent;
  models: CatalogModel[];
  onSaved: () => void;
};

type Role = 'runner' | 'owner';
type RoleDraft = { model: string; modelMode: string; effort: string };

const EMPTY_ROLE: RoleDraft = { model: '', modelMode: '', effort: '' };

function toDraft(r: RoleOverride | undefined): RoleDraft {
  return { model: r?.model || '', modelMode: r?.modelMode || '', effort: r?.effort || '' };
}

function fromDraft(d: RoleDraft): RoleOverride | undefined {
  const out: RoleOverride = {};
  if (d.model) out.model = d.model;
  if (d.modelMode) out.modelMode = d.modelMode;
  if (d.effort) out.effort = d.effort;
  return Object.keys(out).length ? out : undefined;
}

export function WorkflowsPanel({ agent, models, onSaved }: Props) {
  const [ownerOn, setOwnerOn] = useState(agent.config?.workflowOwner === true);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [editId, setEditId] = useState<string | null>(null);
  const [json, setJson] = useState('');
  const [roles, setRoles] = useState<Record<Role, RoleDraft>>({ runner: EMPTY_ROLE, owner: EMPTY_ROLE });
  const [runs, setRuns] = useState<WorkflowRunView[]>([]);
  const [runnerId, setRunnerId] = useState('');
  const [runInput, setRunInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  async function refresh() {
    const [wfs, list, rs] = await Promise.all([
      window.tecapi.workflows.list(agent.id),
      window.tecapi.agents.list(),
      window.tecapi.workflows.runs({ agentId: agent.id, limit: 5 }),
    ]);
    setWorkflows(wfs);
    setAgents(list);
    setRuns(rs);
  }

  useEffect(() => {
    setOwnerOn(agent.config?.workflowOwner === true);
    setEditId(null);
    setStatus('');
    const reload = () =>
      refresh().catch((e) => setStatus(e instanceof Error ? e.message : String(e)));
    void reload();
    const offs = [
      window.tecapi.on('workflow:list-changed', () => void reload()),
      window.tecapi.on('workflow:run', (payload) => {
        const run = payload as WorkflowRunView;
        if (run.runnerAgentId !== agent.id && run.ownerAgentId !== agent.id) return;
        setRuns((prev) =>
          prev.some((r) => r.id === run.id) ? prev.map((r) => (r.id === run.id ? run : r)) : [run, ...prev].slice(0, 5)
        );
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [agent.id]);

  async function toggleOwner(on: boolean) {
    setOwnerOn(on);
    try {
      await window.tecapi.agents.update(agent.id, { config: { ...(agent.config || {}), workflowOwner: on } });
      onSaved();
    } catch (e) {
      setOwnerOn(!on);
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }

  function edit(wf: Workflow | null) {
    setStatus('');
    setEditId(wf ? wf.id : 'new');
    setJson(JSON.stringify(wf ? wf.definition : EXAMPLE_DEFINITION, null, 2));
    setRoles({ runner: toDraft(wf?.settings.runner), owner: toDraft(wf?.settings.owner) });
    const firstOther = agents.find((a) => a.id !== agent.id);
    setRunnerId((cur) => cur || firstOther?.id || '');
  }

  async function save() {
    if (busy) return;
    let definition: unknown;
    try {
      definition = JSON.parse(json);
    } catch (e) {
      setStatus(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const settings: WorkflowSettings = {};
    const runner = fromDraft(roles.runner);
    const owner = fromDraft(roles.owner);
    if (runner) settings.runner = runner;
    if (owner) settings.owner = owner;
    setBusy(true);
    setStatus('');
    try {
      const wf = await window.tecapi.workflows.save({
        id: editId && editId !== 'new' ? editId : undefined,
        ownerAgentId: agent.id,
        definition,
        settings,
      });
      setEditId(wf.id);
      setJson(JSON.stringify(wf.definition, null, 2));
      setStatus(`Saved ${wf.name} v${wf.version}.`);
      await refresh();
    } catch (e) {
      setStatus(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': /, '') : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editId || editId === 'new' || busy) return;
    if (!window.confirm('Delete this workflow? Active runs are aborted and routines using it switch to Off.')) return;
    setBusy(true);
    try {
      await window.tecapi.workflows.delete(editId);
      setEditId(null);
      await refresh();
      onSaved();
    } catch (e) {
      setStatus(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': /, '') : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function startRun() {
    if (!editId || editId === 'new' || !runnerId || busy) return;
    setBusy(true);
    setStatus('');
    try {
      await window.tecapi.workflows.start({ workflowId: editId, runnerAgentId: runnerId, input: runInput.trim() });
      setStatus('Run started. Progress shows in the runner chat.');
      await refresh();
    } catch (e) {
      setStatus(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': /, '') : String(e));
    } finally {
      setBusy(false);
    }
  }

  function setRole(role: Role, patch: Partial<RoleDraft>) {
    setRoles((prev) => ({ ...prev, [role]: { ...prev[role], ...patch } }));
  }

  function roleRow(role: Role) {
    const d = roles[role];
    const efforts = effortParam(models.find((m) => m.id === d.model)).values;
    return (
      <>
        <span>{role === 'runner' ? 'Runner' : 'Owner'}</span>
        <select value={d.model} onChange={(e) => setRole(role, { model: e.target.value })}>
          <option value="">Agent default model</option>
          {dropdownModels(models).map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName || m.id}
            </option>
          ))}
          {d.model && !dropdownModels(models).some((m) => m.id === d.model) ? (
            <option value={d.model}>{d.model}</option>
          ) : null}
        </select>
        <select value={d.modelMode} onChange={(e) => setRole(role, { modelMode: e.target.value })}>
          <option value="">Agent default mode</option>
          <option value="usual">Usual</option>
          <option value="fast">Fast</option>
        </select>
        <select value={d.effort} onChange={(e) => setRole(role, { effort: e.target.value })}>
          <option value="">Agent default effort</option>
          {efforts.map((v) => (
            <option key={v.value} value={v.value}>
              {v.displayName || v.value}
            </option>
          ))}
          {d.effort && !efforts.some((v) => v.value === d.effort) ? <option value={d.effort}>{d.effort}</option> : null}
        </select>
      </>
    );
  }

  return (
    <div className="wf-panel">
      <label className="check-row">
        <input type="checkbox" checked={ownerOn} onChange={(e) => void toggleOwner(e.target.checked)} />
        <span>Workflow owner</span>
      </label>
      <div className="hint" style={{ margin: 0 }}>
        A workflow owner gets tools to create and edit workflows, reviews steps marked for review, and fixes
        broken steps. Runner agents only ever see their current step. Pick a workflow for a runner in its
        Routines tab with Task mode Step workflow.
      </div>

      {ownerOn ? (
        <>
          <div className="routines-toolbar">
            <div className="routines-title">Workflows owned by {agent.name}</div>
            {editId === null ? (
              <button type="button" className="primary add-routine-btn" onClick={() => edit(null)}>
                + New workflow
              </button>
            ) : null}
          </div>

          {editId === null ? (
            <div className="routine-list">
              {workflows.map((wf) => (
                <div key={wf.id} className="routine-row">
                  <div className="routine-meta">
                    <div className="routine-name">
                      {wf.name} <span className="muted">v{wf.version}</span>
                    </div>
                    <div className="muted">{wf.definition.steps.length} steps</div>
                    {wf.definition.description ? (
                      <div className="routine-prompt-preview">{wf.definition.description}</div>
                    ) : null}
                  </div>
                  <div className="routine-actions">
                    <button type="button" className="text-btn" onClick={() => edit(wf)}>
                      Edit
                    </button>
                  </div>
                </div>
              ))}
              {workflows.length === 0 ? (
                <div className="empty-hint">No workflows yet. Create one here or ask this agent to build one.</div>
              ) : null}
            </div>
          ) : (
            <div className="routine-form">
              <div className="routine-form-title">{editId === 'new' ? 'New workflow' : 'Edit workflow'}</div>
              <label className="field">
                <span>Definition (JSON)</span>
                <textarea
                  className="wf-editor"
                  spellCheck={false}
                  value={json}
                  onChange={(e) => setJson(e.target.value)}
                />
                <span className="hint">
                  Each step: id, title, instructions, done_when, outputs, checks (file_exists, file_contains,
                  output_matches, command), validate (none or owner), max_attempts, skippable. Saving a changed
                  definition creates a new version. Running runs keep their version.
                </span>
              </label>
              <div className="field">
                <span>Model overrides (optional)</span>
                <div className="wf-overrides">
                  {roleRow('runner')}
                  {roleRow('owner')}
                </div>
              </div>
              {editId !== 'new' ? (
                <div className="field">
                  <span>Start a run now</span>
                  <div className="wf-overrides" style={{ gridTemplateColumns: '1fr 2fr auto' }}>
                    <select value={runnerId} onChange={(e) => setRunnerId(e.target.value)}>
                      <option value="">Runner agent</option>
                      {agents
                        .filter((a) => a.id !== agent.id)
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                    </select>
                    <input
                      value={runInput}
                      onChange={(e) => setRunInput(e.target.value)}
                      placeholder="Optional run input for the runner"
                    />
                    <button type="button" className="text-btn" disabled={!runnerId || busy} onClick={() => void startRun()}>
                      Start
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="routine-form-actions">
                {editId !== 'new' ? (
                  <button type="button" className="text-btn danger-text" disabled={busy} onClick={() => void remove()}>
                    Delete
                  </button>
                ) : null}
                <button type="button" className="text-btn" onClick={() => setEditId(null)}>
                  Close editor
                </button>
                <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
                  {busy ? 'Saving...' : 'Save workflow'}
                </button>
              </div>
            </div>
          )}
        </>
      ) : null}

      {status ? <p className="status">{status}</p> : null}

      {runs.length ? (
        <>
          <div className="routines-title">Recent runs</div>
          {runs.map((r) => (
            <WorkflowCard key={r.id} run={r} />
          ))}
        </>
      ) : null}
    </div>
  );
}
