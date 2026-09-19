import { useEffect, useState } from 'react';
import type { Agent, Routine } from '../types';
import { ModalBackdrop } from './ModalBackdrop';
import { ScheduleBuilder } from './ScheduleBuilder';
import { AGENT_BADGE_COLORS } from '../lib/agentColors';
import { DEFAULT_SCHEDULE, describeSchedule, encodeSchedule, type ScheduleDraft } from '../lib/schedule';
import { DEFAULT_AGENT_SOUL, resolveAgentSoul } from '../lib/soul';
import {
  baseModelId,
  dropdownModels,
  effortParam,
  readEffort,
  DEFAULT_LAST_MESSAGES,
  readLastMessages,
  readModelMode,
  type CatalogModel,
  type ModelMode,
} from '../lib/modelOptions';

type Props = {
  open: boolean;
  agent: Agent | null;
  onClose: () => void;
  onSaved: () => void;
};

export function AgentSettingsModal({ open, agent, onClose, onSaved }: Props) {
  const [tab, setTab] = useState<'general' | 'routines'>('general');
  const [name, setName] = useState('');
  const [color, setColor] = useState('#4C78FF');
  const [model, setModel] = useState('');
  const [modelMode, setModelMode] = useState<ModelMode>('usual');
  const [effort, setEffort] = useState('medium');
  const [lastMessages, setLastMessages] = useState(DEFAULT_LAST_MESSAGES);
  const [soul, setSoul] = useState('');
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  const [routines, setRoutines] = useState<Routine[]>([]);
  const [rName, setRName] = useState('');
  const [schedule, setSchedule] = useState<ScheduleDraft>(DEFAULT_SCHEDULE);
  const [rPrompt, setRPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [composing, setComposing] = useState(false);

  async function refreshRoutines() {
    if (!agent) return;
    const all = await window.tecapi.routines.list();
    setRoutines(all.filter((r) => r.agentId === agent.id));
  }

  useEffect(() => {
    if (!open || !agent) return;
    setTab('general');
    setName(agent.name);
    setColor(agent.color);
    setModel(baseModelId(agent.model));
    setModelMode(readModelMode(agent.config, agent.model));
    setEffort(readEffort(agent.config));
    setLastMessages(readLastMessages(agent.config));
    setSoul(resolveAgentSoul(agent.instructions));
    setStatus('');
    setRName('');
    setSchedule(DEFAULT_SCHEDULE);
    setRPrompt('');
    setComposing(false);
    void window.tecapi.models.list().then(setModels).catch(() => setModels([]));
    void refreshRoutines();
  }, [open, agent?.id]);

  if (!open || !agent) return null;

  async function saveGeneral() {
    setSaving(true);
    setStatus('');
    try {
      await window.tecapi.agents.update(agent.id, {
        name: name.trim() || agent.name,
        model: baseModelId(model.trim() || agent.model),
        color,
        instructions: soul.trim() ? soul : null,
        config: { ...(agent.config || {}), modelMode, effort, lastMessages },
      });
      setStatus('Saved.');
      onSaved();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function createRoutine() {
    if (!rPrompt.trim() || creating) return;
    setCreating(true);
    try {
      await window.tecapi.routines.create({
        agentId: agent.id,
        name: rName.trim() || 'Routine',
        cron: encodeSchedule(schedule),
        prompt: rPrompt.trim(),
      });
      setRName('');
      setRPrompt('');
      setComposing(false);
      await refreshRoutines();
      onSaved();
    } finally {
      setCreating(false);
    }
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal agent-settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>Agent settings - {agent.name}</h2>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            X
          </button>
        </div>

        <div className="agent-settings-tabs">
          <button
            type="button"
            className={tab === 'general' ? 'active' : ''}
            onClick={() => setTab('general')}
          >
            General
          </button>
          <button
            type="button"
            className={tab === 'routines' ? 'active' : ''}
            onClick={() => setTab('routines')}
          >
            Routines
          </button>
        </div>

        <div className="modal-body">
          {tab === 'general' && (
            <>
              <label className="field">
                <span>Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <div className="field">
                <span>Badge color</span>
                <div className="color-picker-row">
                  <div className="avatar" style={{ background: color }}>
                    {(name.trim() || agent.name).slice(0, 2).toUpperCase()}
                  </div>
                  <div className="color-swatches">
                    {AGENT_BADGE_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`color-swatch${c.toLowerCase() === color.toLowerCase() ? ' selected' : ''}`}
                        style={{ background: c }}
                        title={c}
                        onClick={() => setColor(c)}
                      />
                    ))}
                    <label className="color-swatch custom" title="Custom color">
                      <input
                        type="color"
                        value={color}
                        onChange={(e) => setColor(e.target.value)}
                      />
                    </label>
                  </div>
                </div>
              </div>
              <label className="field">
                <span>Model</span>
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                  {dropdownModels(models).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName || m.id}
                    </option>
                  ))}
                  {!dropdownModels(models).find((m) => m.id === model) && model ? (
                    <option value={model}>{model}</option>
                  ) : null}
                </select>
              </label>
              <div className="field">
                <span>Mode</span>
                <div className="seg-row">
                  <button
                    type="button"
                    className={`seg${modelMode === 'usual' ? ' active' : ''}`}
                    onClick={() => setModelMode('usual')}
                  >
                    Usual
                  </button>
                  <button
                    type="button"
                    className={`seg${modelMode === 'fast' ? ' active' : ''}`}
                    onClick={() => setModelMode('fast')}
                  >
                    Fast
                  </button>
                </div>
              </div>
              <label className="field">
                <span>Effort</span>
                <select value={effort} onChange={(e) => setEffort(e.target.value)}>
                  {effortParam(models.find((m) => m.id === model)).values.map((v) => (
                    <option key={v.value} value={v.value}>
                      {v.displayName || v.value}
                    </option>
                  ))}
                  {!effortParam(models.find((m) => m.id === model)).values.some((v) => v.value === effort) ? (
                    <option value={effort}>{effort}</option>
                  ) : null}
                </select>
                <span className="hint">Default is usual + medium. Fast, high, and max cost more.</span>
              </label>
              <label className="field">
                <span>Last messages</span>
                <input
                  type="number"
                  min={0}
                  max={50}
                  step={1}
                  value={lastMessages}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (!Number.isFinite(n)) return;
                    setLastMessages(Math.max(0, Math.min(50, Math.round(n))));
                  }}
                />
                <span className="hint">
                  Inject the last N chat lines into every turn so follow-ups like "smaller one" work. 0 turns this off. Default 5.
                </span>
              </label>
              <label className="field soul-field">
                <span>Soul (sticky rules)</span>
                <textarea
                  className="soul-editor"
                  value={soul}
                  onChange={(e) => setSoul(e.target.value)}
                  placeholder={DEFAULT_AGENT_SOUL}
                />
                <span className="hint">Only this agent. Injected on every turn. Saved with Save below. App-wide prompt is in Local user settings.</span>
              </label>
              {status ? <p className="status">{status}</p> : null}
            </>
          )}

          {tab === 'routines' && (
            <div className="routines-panel">
              <div className="routines-toolbar">
                <div>
                  <div className="routines-title">Routines</div>
                  <div className="hint" style={{ margin: 0 }}>
                    Run on a schedule for <strong>{agent.name}</strong> while the app is open.
                  </div>
                </div>
                {!composing && (
                  <button
                    type="button"
                    className="primary add-routine-btn"
                    onClick={() => setComposing(true)}
                  >
                    + Add routine
                  </button>
                )}
              </div>

              {composing && (
                <div className="routine-form">
                  <div className="routine-form-title">New routine</div>
                  <div className="routine-form-grid">
                    <label className="field">
                      <span>Name</span>
                      <input
                        value={rName}
                        onChange={(e) => setRName(e.target.value)}
                        placeholder="Morning brief"
                        autoFocus
                      />
                    </label>
                    <div className="field">
                      <ScheduleBuilder value={schedule} onChange={setSchedule} />
                    </div>
                  </div>
                  <label className="field">
                    <span>Prompt</span>
                    <textarea
                      value={rPrompt}
                      onChange={(e) => setRPrompt(e.target.value)}
                      rows={3}
                      placeholder="What should this agent do when the routine fires?"
                    />
                  </label>
                  <div className="routine-form-actions">
                    <button
                      type="button"
                      className="text-btn"
                      onClick={() => {
                        setComposing(false);
                        setRName('');
                        setRPrompt('');
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="primary"
                      disabled={!rPrompt.trim() || creating}
                      onClick={() => void createRoutine()}
                    >
                      {creating ? 'Saving…' : 'Save routine'}
                    </button>
                  </div>
                </div>
              )}

              {!composing && (
                <div className="routine-list">
                  {routines.map((r) => (
                    <div key={r.id} className={`routine-row${r.enabled ? '' : ' paused'}`}>
                      <div className="routine-meta">
                        <div className="routine-name">
                          {r.name}
                          {!r.enabled ? <span className="routine-paused-tag">Paused</span> : null}
                        </div>
                        <div className="muted">{describeSchedule(r.cron)}</div>
                        <div className="routine-prompt-preview">{r.prompt}</div>
                      </div>
                      <div className="routine-actions">
                        <button
                          type="button"
                          className="text-btn"
                          onClick={() =>
                            void window.tecapi.routines
                              .update(r.id, { enabled: r.enabled ? 0 : 1 })
                              .then(() => {
                                void refreshRoutines();
                                onSaved();
                              })
                          }
                        >
                          {r.enabled ? 'Pause' : 'Resume'}
                        </button>
                        <button
                          type="button"
                          className="text-btn"
                          onClick={() => void window.tecapi.routines.runNow(r.id)}
                        >
                          Run
                        </button>
                        <button
                          type="button"
                          className="text-btn danger-text"
                          onClick={() =>
                            void window.tecapi.routines.delete(r.id).then(() => {
                              void refreshRoutines();
                              onSaved();
                            })
                          }
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                  {routines.length === 0 && (
                    <div className="routines-empty">
                      <div className="empty-hint">No routines yet</div>
                      <button
                        type="button"
                        className="primary add-routine-btn"
                        onClick={() => setComposing(true)}
                      >
                        + Add routine
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>

        <div className="modal-footer">
          <button type="button" className="text-btn" onClick={onClose}>
            Close
          </button>
          {tab === 'general' && (
            <button
              type="button"
              className="primary"
              disabled={saving}
              onClick={() => void saveGeneral()}
            >
              Save
            </button>
          )}
        </div>
      </div>
    </ModalBackdrop>
  );
}
