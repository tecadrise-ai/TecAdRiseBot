import { useEffect, useState } from 'react';
import type { Agent, Routine, Workflow } from '../types';
import { ModalBackdrop } from './ModalBackdrop';
import { TaskModeFields, type TaskMode } from './TaskModeFields';
import { WorkflowsPanel } from './WorkflowsPanel';
import { normalizeSettings } from '../lib/workflow/definition';
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
  readToastEnabled,
  type CatalogModel,
  type ModelMode,
} from '../lib/modelOptions';

type SettingsTab = 'general' | 'routines' | 'workflows' | 'mcp';

type Props = {
  open: boolean;
  agent: Agent | null;
  initialTab?: SettingsTab;
  onClose: () => void;
  onSaved: () => void;
  onSessionCleared?: (agentId: string) => void;
};

export function AgentSettingsModal({ open, agent, initialTab = 'general', onClose, onSaved, onSessionCleared }: Props) {
  const [tab, setTab] = useState<SettingsTab>('general');
  const [name, setName] = useState('');
  const [color, setColor] = useState('#4C78FF');
  const [toastEnabled, setToastEnabled] = useState(true);
  const [model, setModel] = useState('');
  const [modelMode, setModelMode] = useState<ModelMode>('usual');
  const [effort, setEffort] = useState('medium');
  const [ownerModel, setOwnerModel] = useState('');
  const [ownerMode, setOwnerMode] = useState<ModelMode>('usual');
  const [ownerEffort, setOwnerEffort] = useState('medium');
  const [ownerAgentId, setOwnerAgentId] = useState('');
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [lastMessages, setLastMessages] = useState(DEFAULT_LAST_MESSAGES);
  const [soul, setSoul] = useState('');
  const [mcpJson, setMcpJson] = useState('{\n}\n');
  const [mcpBusy, setMcpBusy] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  const [routines, setRoutines] = useState<Routine[]>([]);
  const [rName, setRName] = useState('');
  const [schedule, setSchedule] = useState<ScheduleDraft>(DEFAULT_SCHEDULE);
  const [rPrompt, setRPrompt] = useState('');
  const [rTaskMode, setRTaskMode] = useState<TaskMode>('off');
  const [rWorkflowId, setRWorkflowId] = useState('');
  const [allWorkflows, setAllWorkflows] = useState<Workflow[]>([]);
  const [creating, setCreating] = useState(false);
  const [composing, setComposing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  function resetRoutineForm() {
    setRName('');
    setSchedule(DEFAULT_SCHEDULE);
    setRPrompt('');
    setRTaskMode('off');
    setRWorkflowId('');
    setComposing(false);
    setEditingId(null);
  }

  function startEdit(r: Routine) {
    setEditingId(r.id);
    setRName(r.name);
    setSchedule(decodeSchedule(r.cron));
    setRPrompt(r.prompt);
    setRTaskMode(r.workflowId ? 'workflow' : r.forceTodos ? 'todos' : 'off');
    setRWorkflowId(r.workflowId || '');
    setComposing(true);
  }

  async function refreshRoutines() {
    if (!agent) return;
    const [all, wfs] = await Promise.all([window.tecapi.routines.list(), window.tecapi.workflows.list(agent.id)]);
    setRoutines(all.filter((r) => r.agentId === agent.id));
    setAllWorkflows(wfs);
  }

  useEffect(() => {
    if (!open || !agent) return;
    setTab(initialTab);
    setName(agent.name);
    setColor(agent.color);
    setToastEnabled(readToastEnabled(agent.config));
    setModel(baseModelId(agent.model));
    setModelMode(readModelMode(agent.config, agent.model));
    setEffort(readEffort(agent.config));
    const ov = normalizeSettings({ owner: agent.config?.workflowOwnerOverride }).owner ?? {};
    setOwnerModel(ov.model || baseModelId(agent.model));
    setOwnerMode((ov.modelMode as ModelMode) || readModelMode(agent.config, agent.model));
    setOwnerEffort(ov.effort || readEffort(agent.config));
    setOwnerAgentId(typeof agent.config?.workflowOwnerAgentId === 'string' ? agent.config.workflowOwnerAgentId : '');
    void window.tecapi.agents
      .list()
      .then(setAllAgents)
      .catch(() => setAllAgents([]));
    setLastMessages(readLastMessages(agent.config));
    setSoul(resolveAgentSoul(agent.instructions));
    setMcpJson(mcpJsonFromConfig(agent.config));
    setStatus('');
    setConfirmClear(false);
    setRName('');
    setSchedule(DEFAULT_SCHEDULE);
    setRPrompt('');
    setRTaskMode('off');
    setRWorkflowId('');
    setComposing(false);
    setEditingId(null);
    void window.tecapi.models
      .list()
      .then((list) => {
        if (list.length) setModels(list);
        else setStatus('Could not load the model list. Check the API key in Settings, then reopen.');
      })
      .catch((e) => setStatus(`Could not load the model list: ${e instanceof Error ? e.message : String(e)}`));
    void refreshRoutines();
  }, [open, agent?.id, initialTab]);

  if (!open || !agent) return null;

  const ownerEfforts = effortParam(models.find((m) => m.id === ownerModel)).values;

  async function saveGeneral() {
    setSaving(true);
    setStatus('');
    try {
      const {
        resumeSession: _oldResume,
        promptProtocolVersion: _oldProtocol,
        workflowOwnerOverride: _oldOwner,
        workflowOwnerAgentId: _oldOwnerAgent,
        ...keptConfig
      } = agent!.config || {};
      const ownerOverride = normalizeSettings({
        owner: {
          model: ownerModel !== model ? ownerModel : undefined,
          modelMode: ownerMode !== modelMode ? ownerMode : undefined,
          effort: ownerEffort !== effort ? ownerEffort : undefined,
        },
      }).owner;
      await window.tecapi.agents.update(agent!.id, {
        name: name.trim() || agent!.name,
        model: baseModelId(model.trim() || agent!.model),
        color,
        instructions: soul.trim() ? soul : null,
        config: {
          ...keptConfig,
          modelMode,
          effort,
          lastMessages,
          toastEnabled,
          ...(ownerAgentId ? { workflowOwnerAgentId: ownerAgentId } : {}),
          ...(ownerOverride ? { workflowOwnerOverride: ownerOverride } : {}),
        },
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
    if (!confirmClear) {
      setConfirmClear(true);
      setStatus('Click Confirm clear chat history. This cannot be undone.');
      return;
    }
    setClearing(true);
    setStatus('');
    try {
      await window.tecapi.messages.clear(agent!.id);
      setConfirmClear(false);
      onSaved();
      onSessionCleared?.(agent!.id);
      onClose();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setClearing(false);
    }
  }

  const routineReady =
    Boolean(encodeSchedule(schedule)) &&
    (rTaskMode === 'workflow' ? Boolean(rWorkflowId) : Boolean(rPrompt.trim()));

  async function saveRoutine() {
    if (!routineReady || creating) return;
    setCreating(true);
    try {
      const payload = {
        name: rName.trim() || 'Routine',
        cron: encodeSchedule(schedule),
        prompt: rPrompt.trim(),
        forceTodos: rTaskMode === 'todos' ? 1 : 0,
        workflowId: rTaskMode === 'workflow' ? rWorkflowId : null,
      };
      if (editingId) {
        await window.tecapi.routines.update(editingId, payload);
      } else {
        await window.tecapi.routines.create({
          agentId: agent!.id,
          ...payload,
        });
      }
      resetRoutineForm();
      await refreshRoutines();
      onSaved();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  async function routineAction(fn: () => Promise<unknown>) {
    setStatus('');
    try {
      await fn();
      await refreshRoutines();
      onSaved();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
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
      await window.tecapi.agents.update(agent!.id, {
        config: { ...(agent!.config || {}), mcpServers: parsed.servers },
      });
      const result = await window.tecapi.agents.registerMcp(agent!.id);
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
            ×
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
            className={tab === 'workflows' ? 'active' : ''}
            onClick={() => setTab('workflows')}
          >
            Workflows
          </button>
          <button
            type="button"
            className={tab === 'mcp' ? 'active' : ''}
            onClick={() => setTab('mcp')}
          >
            MCP
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
                  <label className="toast-toggle" title="Windows toast when a manual chat finishes and this window is in the background. Routines never toast.">
                    <input
                      type="checkbox"
                      checked={toastEnabled}
                      onChange={(e) => setToastEnabled(e.target.checked)}
                    />
                    Desktop toast
                  </label>
                </div>
              </div>
              <div className="field">
                <span>Model, mode and effort</span>
                <div className="wf-overrides wf-overrides-general">
                  <span>Runner</span>
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
                  <select value={modelMode} onChange={(e) => setModelMode(e.target.value as ModelMode)}>
                    <option value="usual">Usual</option>
                    <option value="fast">Fast</option>
                  </select>
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

                  <span>
                    Owner <span className="muted">(optional)</span>
                  </span>
                  <select
                    value={ownerModel}
                    onChange={(e) => setOwnerModel(e.target.value)}
                  >
                    {dropdownModels(models).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.displayName || m.id}
                      </option>
                    ))}
                    {ownerModel && !dropdownModels(models).some((m) => m.id === ownerModel) ? (
                      <option value={ownerModel}>{ownerModel}</option>
                    ) : null}
                  </select>
                  <select
                    value={ownerMode}
                    onChange={(e) => setOwnerMode(e.target.value as ModelMode)}
                  >
                    <option value="usual">Usual</option>
                    <option value="fast">Fast</option>
                  </select>
                  <select
                    value={ownerEffort}
                    onChange={(e) => setOwnerEffort(e.target.value)}
                  >
                    {ownerEfforts.map((v) => (
                      <option key={v.value} value={v.value}>
                        {v.displayName || v.value}
                      </option>
                    ))}
                    {!ownerEfforts.some((v) => v.value === ownerEffort) ? (
                      <option value={ownerEffort}>{ownerEffort}</option>
                    ) : null}
                  </select>
                </div>
                <span className="hint">
                  The Runner is this agent: it chats and runs workflows. The Owner is a separate agent that never runs
                  workflows, it only reviews and fixes this agent&apos;s workflow steps, with the settings in its row.
                  Changing Runner does not change Owner. Fast, high, and max cost more.
                </span>
              </div>
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
                  Visible chat messages included in every independent run for short-term context.
                  The default is 5. Use Memory and Soul for durable context.
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
                <span className="hint">Only this agent. Included in every independent run. App-wide prompt is in Local user settings.</span>
              </label>
              <div className="session-panel">
                <p className="hint">
                  Clear this agent&apos;s visible chat history. Soul, MCP, routines, workspace files,
                  and Memory are unchanged.
                </p>
                <button
                  type="button"
                  className="primary danger-btn"
                  disabled={clearing}
                  onClick={() => void clearSession()}
                >
                  {clearing ? 'Clearing...' : confirmClear ? 'Confirm clear chat history' : 'Clear chat history'}
                </button>
              </div>
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
                  <TaskModeFields
                    mode={rTaskMode}
                    workflowId={rWorkflowId}
                    workflows={allWorkflows}
                    onMode={setRTaskMode}
                    onWorkflow={setRWorkflowId}
                  />
                  <label className="field">
                    <span>{rTaskMode === 'workflow' ? 'Run input (optional)' : 'Prompt'}</span>
                    <textarea
                      value={rPrompt}
                      onChange={(e) => setRPrompt(e.target.value)}
                      rows={10}
                      placeholder={
                        rTaskMode === 'workflow'
                          ? 'Extra context passed to every run of the workflow.'
                          : 'What should this agent do when the routine fires?'
                      }
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
                      disabled={!routineReady || creating}
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
                          {r.workflowId ? (
                            <span className="routine-paused-tag">
                              Workflow: {allWorkflows.find((w) => w.id === r.workflowId)?.name || 'missing'}
                            </span>
                          ) : null}
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
                            void routineAction(() => window.tecapi.routines.update(r.id, { enabled: r.enabled ? 0 : 1 }))
                          }
                        >
                          {r.enabled ? 'Pause' : 'Resume'}
                        </button>
                        <button
                          type="button"
                          className="text-btn"
                          onClick={() =>
                            void routineAction(async () => {
                              const res = (await window.tecapi.routines.runNow(r.id)) as { ok?: boolean; note?: string } | undefined;
                              if (res && res.ok === false) throw new Error(res.note || 'Routine could not start');
                              setStatus(res?.note || 'Started.');
                            })
                          }
                        >
                          Run
                        </button>
                        <button
                          type="button"
                          className="text-btn danger-text"
                          onClick={() => void routineAction(() => window.tecapi.routines.delete(r.id))}
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
              {status ? <p className="status">{status}</p> : null}
            </div>
          )}

          {tab === 'workflows' && <WorkflowsPanel agent={agent} models={models} onSaved={onSaved} />}

          {tab === 'mcp' && (
            <div className="mcp-panel">
              <div className="hint" style={{ marginTop: 0 }}>
                Extra MCP for this agent only. Connected apps and Settings → MCP already attach for
                every agent. Same name wins here. Empty {'{}'} is fine.
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
        </div>
      </div>
    </ModalBackdrop>
  );
}
