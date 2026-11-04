import { useEffect, useState } from 'react';
import type { Agent, Workflow, WorkflowRunView } from '../types';
import type { WorkflowSettings } from '../lib/workflow/types';
import { EXAMPLE_DEFINITION } from '../lib/workflow/definition';
import type { CatalogModel } from '../lib/modelOptions';
import { WorkflowCard } from './WorkflowCard';
import { WorkflowTable } from './WorkflowTable';

type Props = {
  agent: Agent;
  models: CatalogModel[];
  onSaved: () => void;
};

export function WorkflowsPanel({ agent, onSaved }: Props) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [editId, setEditId] = useState<string | null>(null);
  const [json, setJson] = useState('');
  const [runs, setRuns] = useState<WorkflowRunView[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [view, setView] = useState<'table' | 'json'>('table');

  async function refresh() {
    const [wfs, rs] = await Promise.all([
      window.tecapi.workflows.list(agent.id),
      window.tecapi.workflows.runs({ agentId: agent.id, limit: 5 }),
    ]);
    setWorkflows(wfs);
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

  return (
    <div className="wf-panel">
      <div className="hint" style={{ margin: 0 }}>
        Workflows defined by {agent.name}. A Runner agent runs a workflow from its Routines tab (Task mode Step
        workflow) and only ever sees its current step. The Runner&apos;s Owner agent, set in the Runner&apos;s General
        tab, reviews and fixes the steps but never runs workflows. See Settings/Architecture for more info.
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
              <div className="wf-view-bar">
                <span>Definition</span>
                <div className="composer-target" role="radiogroup" aria-label="View">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={view === 'table'}
                    className={view === 'table' ? 'active' : ''}
                    onClick={() => setView('table')}
                  >
                    Table
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={view === 'json'}
                    className={view === 'json' ? 'active' : ''}
                    onClick={() => setView('json')}
                  >
                    JSON
                  </button>
                </div>
              </div>
              <div className="field">
                {view === 'table' ? (
                  <WorkflowTable json={json} onChange={setJson} />
                ) : (
                  <textarea
                    className="wf-editor"
                    spellCheck={false}
                    value={json}
                    onChange={(e) => setJson(e.target.value)}
                  />
                )}
                <span className="hint">
                  Each step: id, title, instructions, done_when, outputs, checks (file_exists, file_contains,
                  output_matches, command), validate (none or owner), max_attempts, skippable. Saving a changed
                  definition creates a new version. Running runs keep their version.
                </span>
              </div>
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
          {[...runs].sort((a, b) => b.createdAt - a.createdAt).map((r) => (
            <WorkflowCard key={r.id} run={r} />
          ))}
        </>
      ) : null}
    </div>
  );
}
