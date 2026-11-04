import { useEffect, useState } from 'react';
import type { Agent, Workflow, WorkflowRunView } from '../types';
import type { WorkflowSettings } from '../lib/workflow/types';
import { EXAMPLE_DEFINITION } from '../lib/workflow/definition';
import type { CatalogModel } from '../lib/modelOptions';
import { WorkflowCard } from './WorkflowCard';

type Props = {
  agent: Agent;
  models: CatalogModel[];
  onSaved: () => void;
};

export function WorkflowsPanel({ agent, onSaved }: Props) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [editId, setEditId] = useState<string | null>(null);
  const [json, setJson] = useState('');
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

  function edit(wf: Workflow | null) {
    setStatus('');
    setEditId(wf ? wf.id : 'new');
    setJson(JSON.stringify(wf ? wf.definition : EXAMPLE_DEFINITION, null, 2));
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
    const settings: WorkflowSettings = workflows.find((w) => w.id === editId)?.settings ?? {};
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

  return (
    <div className="wf-panel">
      <div className="hint" style={{ margin: 0 }}>
        {agent.name} is the owner of the workflows below. It creates and edits them, reviews steps marked for
        review, and fixes broken steps. Runner agents only ever see their current step. Pick a workflow for a
        runner in its Routines tab with Task mode Step workflow.
      </div>

      {(
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
      )}

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
