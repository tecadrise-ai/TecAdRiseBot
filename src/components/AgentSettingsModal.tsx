import { useEffect, useState } from 'react';
import type { Agent, Routine } from '../types';
import { ModalBackdrop } from './ModalBackdrop';
import { ScheduleBuilder } from './ScheduleBuilder';
import { AGENT_BADGE_COLORS } from '../lib/agentColors';
import { DEFAULT_SCHEDULE, decodeSchedule, describeSchedule, encodeSchedule, type ScheduleDraft } from '../lib/schedule';
import { mcpJsonFromConfig, parseMcpJson } from '../lib/mcpConfig';
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
  const [tab, setTab] = useState<'general' | 'routines' | 'mcp' | 'session'>('general');
  const [name, setName] = useState('');
  const [color, setColor] = useState('#4C78FF');
  const [model, setModel] = useState('');
  const [modelMode, setModelMode] = useState<ModelMode>('usual');
  const [effort, setEffort] = useState('medium');
  const [lastMessages, setLastMessages] = useState(DEFAULT_LAST_MESSAGES);
  const [soul, setSoul] = useState('');
  const [mcpJson, setMcpJson] = useState('{\n}\n');
  const [mcpBusy, setMcpBusy] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  const [routines, setRoutines] = useState<Routine[]>([]);
  const [rName, setRName] = useState('');
  const [schedule, setSchedule] = useState<ScheduleDraft>(DEFAULT_SCHEDULE);
  const [rPrompt, setRPrompt] = useState('');
  const [rForceTodos, setRForceTodos] = useState(false);
  const [creating, setCreating] = useState(false);
  const [composing, setComposing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  function resetRoutineForm() {
    setRName('');
    setSchedule(DEFAULT_SCHEDULE);
    setRPrompt('');
    setRForceTodos(false);
    setComposing(false);
    setEditingId(null);
  }

  function startEdit(r: Routine) {
    setEditingId(r.id);
    setRName(r.name);
    setSchedule(decodeSchedule(r.cron));
    setRPrompt(r.prompt);
    setRForceTodos(Boolean(r.forceTodos));
    setComposing(true);
  }

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
    setMcpJson(mcpJsonFromConfig(agent.config));
    setStatus('');
    setRName('');
    setSchedule(DEFAULT_SCHEDULE);
    setRPrompt('');
    setRForceTodos(false);
    setComposing(false);
    setEditingId(null);
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

  async function clearSession() {
    if (clearing) return;
    const ok = window.confirm(
      `Clear chat history for ${agent.name}? This cannot be undone.`
    );
    if (!ok) return;
    setClearing(true);
    setStatus('');
    try {
      await window.tecapi.messages.clear(agent.id);
      setStatus('Session cleared.');
      onSaved();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setClearing(false);
    }
  }

  async function saveRoutine() {
    if (!rPrompt.trim() || creating) return;
    setCreating(true);
    try {
      const payload = {
        name: rName.trim() || 'Routine',
        cron: encodeSchedule(schedule),
        prompt: rPrompt.trim(),
        forceTodos: rForceTodos ? 1 : 0,
      };
      if (editingId) {
        await window.tecapi.routines.update(editingId, payload);
      } else {
        await window.tecapi.routines.create({
          agentId: agent.id,
          ...payload,
        });
      }
      resetRoutineForm();
      await refreshRoutines();
      onSaved();
    } finally {
      setCreating(false);
    }
  }

  async function registerMcp() {
    if (mcpBusy) return;
    setMcpBusy(true);
    setStatus('');
    const parsed = parseMcpJson(mcpJson);
    if (!parsed.ok) {
      setStatus(parsed.error);
      setMcpBusy(false);
      return;
    }
    try {
      await window.tecapi.agents.update(agent.id, {
        config: { ...(agent.config || {}), mcpServers: parsed.servers },
      });
      const result = await window.tecapi.agents.registerMcp(agent.id);
      setStatus(result.ok ? result.note || 'Registered.' : result.error || 'Register failed');
      onSaved();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setMcpBusy(false);
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
          <button
            type="button"
            className={tab === 'mcp' ? 'active' : ''}
            onClick={() => setTab('mcp')}
          >
            MCP
          </button>
          <button
            type="button"
            className={tab === 'session' ? 'active' : ''}
            onClick={() => setTab('session')}
          >
            Session
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
                    onClick={() => {
                      resetRoutineForm();
                      setComposing(true);
                    }}
                  >
                    + Add routine
                  </button>
                )}
              </div>

              {composing && (
                <div className="routine-form">
                  <div className="routine-form-title">{editingId ? 'Edit routine' : 'New routine'}</div>
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
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={rForceTodos}
                      onChange={(e) => setRForceTodos(e.target.checked)}
                    />
                    <span>Force updateTodos</span>
                  </label>
                  <label className="field">
                    <span>Prompt</span>
                    <textarea
                      value={rPrompt}
                      onChange={(e) => setRPrompt(e.target.value)}
                      rows={10}
                      placeholder="What should this agent do when the routine fires?"
                    />
                  </label>
                  <div className="routine-form-actions">
                    <button
                      type="button"
                      className="text-btn"
                      onClick={() => resetRoutineForm()}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="primary"
                      disabled={!rPrompt.trim() || creating}
                      onClick={() => void saveRoutine()}
                    >
                      {creating ? 'Saving...' : editingId ? 'Save changes' : 'Save routine'}
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
                          {r.forceTodos ? <span className="routine-paused-tag">updateTodos</span> : null}
                        </div>
                        <div className="muted">{describeSchedule(r.cron)}</div>
                        <div className="routine-prompt-preview">{r.prompt}</div>
                      </div>
                      <div className="routine-actions">
                        <button
                          type="button"
                          className="text-btn"
                          onClick={() => startEdit(r)}
                        >
                          Edit
                        </button>
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
                        onClick={() => {
                          resetRoutineForm();
                          setComposing(true);
                        }}
                      >
                        + Add routine
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {tab === 'session' && (
            <div className="session-panel">
              <p className="hint" style={{ marginTop: 0 }}>
                Clear the current session to wipe this agent&apos;s chat history. The next message
                starts a fresh SDK session. Soul, MCP, and routines stay as they are.
              </p>
              {status ? <p className="status">{status}</p> : null}
            </div>
          )}

          {tab === 'mcp' && (
            <div className="mcp-panel">
              <div className="hint" style={{ marginTop: 0 }}>
                Extra MCP for this agent only. Merged on top of Local user → MCP. Same name wins here.
                Empty {'{}'} still keeps globals. Register attaches this mix on this session. Next chat
                turn also sends the merged list.
              </div>
              <label className="field">
                <span>mcpServers</span>
                <textarea
                  className="mcp-editor"
                  spellCheck={false}
                  value={mcpJson}
                  onChange={(e) => setMcpJson(e.target.value)}
                  placeholder={'{\n  "name": { "command": "npx", "args": ["-y", "pkg"] }\n}\n'}
                />
              </label>
              {status ? <p className="status">{status}</p> : null}
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
          {tab === 'mcp' && (
            <button
              type="button"
              className="primary"
              disabled={mcpBusy}
              onClick={() => void registerMcp()}
            >
              {mcpBusy ? 'Registering...' : 'Register'}
            </button>
          )}
          {tab === 'session' && (
            <button
              type="button"
              className="primary danger-btn"
              disabled={clearing}
              onClick={() => void clearSession()}
            >
              {clearing ? 'Clearing...' : 'Clear current session'}
            </button>
          )}
        </div>
      </div>
    </ModalBackdrop>
  );
}
