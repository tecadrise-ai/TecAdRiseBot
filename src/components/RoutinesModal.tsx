import { useEffect, useState } from 'react';
import type { Agent, Routine } from '../types';
import { ModalBackdrop } from './ModalBackdrop';

type Props = {
  open: boolean;
  agents: Agent[];
  selectedAgentId: string | null;
  onClose: () => void;
};

export function RoutinesModal({ open, agents, selectedAgentId, onClose }: Props) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [name, setName] = useState('Hourly check-in');
  const [cron, setCron] = useState('0 * * * *');
  const [prompt, setPrompt] = useState('Give a one-paragraph status update for this workspace.');
  const [agentId, setAgentId] = useState(selectedAgentId ?? '');
  const [error, setError] = useState('');

  async function refresh() {
    setRoutines(await window.tecapi.routines.list());
  }

  useEffect(() => {
    if (open) {
      setAgentId(selectedAgentId ?? agents[0]?.id ?? '');
      void refresh();
    }
  }, [open, selectedAgentId, agents]);

  if (!open) return null;

  async function create() {
    setError('');
    try {
      await window.tecapi.routines.create({
        agentId,
        name: name.trim() || 'Routine',
        cron: cron.trim(),
        prompt: prompt.trim(),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal medium-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Scheduled routines</h2>
        <p className="hint">
          In-app cron while TecAdRiseBot is open (checked every 15s). Example:{' '}
          <code>*/5 * * * *</code> every 5 minutes.
        </p>

        <div className="routine-form">
          <label className="field">
            <span>Agent</span>
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>Cron</span>
            <input value={cron} onChange={(e) => setCron(e.target.value)} />
          </label>
          <label className="field">
            <span>Prompt</span>
            <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
          {error && <p className="status error">{error}</p>}
          <button type="button" className="primary" onClick={() => void create()}>
            Create routine
          </button>
        </div>

        <div className="routine-list">
          {routines.map((r) => {
            const agent = agents.find((a) => a.id === r.agentId);
            return (
              <div key={r.id} className="routine-row">
                <div>
                  <strong>{r.name}</strong>
                  <div className="muted">
                    {agent?.name ?? r.agentId} · <code>{r.cron}</code>
                    {r.lastRunAt ? ` · last ${new Date(r.lastRunAt).toLocaleString()}` : ''}
                  </div>
                </div>
                <div className="row">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      void window.tecapi.routines
                        .update(r.id, { enabled: r.enabled ? 0 : 1 })
                        .then(refresh)
                    }
                  >
                    {r.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void window.tecapi.routines.runNow(r.id)}
                  >
                    Run now
                  </button>
                  <button
                    type="button"
                    className="danger-link"
                    onClick={() => void window.tecapi.routines.delete(r.id).then(refresh)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
          {routines.length === 0 && <div className="empty-hint">No routines yet</div>}
        </div>

        <div className="row end">
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
