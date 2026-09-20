import { useEffect, useState } from 'react';
import type { AppSettings } from '../types';
import { ModalBackdrop } from './ModalBackdrop';
import { EMPTY_MCP_JSON } from '../lib/mcpConfig';
import { fmtTok } from '../lib/usage';

type Tab = 'general' | 'system' | 'memory' | 'mcp' | 'computer' | 'usage' | 'updates';

type AgentUsageRow = {
  agentId: string;
  name: string;
  color: string;
  replies: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
};

function UsageBillingBody() {
  const [rows, setRows] = useState<AgentUsageRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (typeof window.tecapi.usage?.byAgent !== 'function') {
      setLoaded(true);
      return;
    }
    void window.tecapi.usage
      .byAgent()
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoaded(true));
  }, []);

  const totals = rows.reduce(
    (acc, r) => {
      acc.replies += r.replies;
      acc.inputTokens += r.inputTokens;
      acc.outputTokens += r.outputTokens;
      acc.cacheReadTokens += r.cacheReadTokens;
      acc.totalTokens += r.totalTokens;
      return acc;
    },
    { replies: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 }
  );

  return (
    <section>
      <h2>Usage &amp; Billing</h2>
      <p className="lede">
        Token counts below are from this app&apos;s saved replies (SDK usage on each assistant
        message). Cursor still bills the account on your API key. This table is local, not an
        invoice.
      </p>
      {!loaded ? (
        <p className="hint">Loading usage…</p>
      ) : rows.length === 0 ? (
        <p className="hint">No agents yet.</p>
      ) : (
        <div className="usage-table-wrap">
          <table className="usage-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Replies</th>
                <th>In</th>
                <th>Out</th>
                <th>Cache</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.agentId}>
                  <td>
                    <span className="usage-agent">
                      <span className="avatar sm" style={{ background: r.color }}>
                        {r.name.slice(0, 2).toUpperCase()}
                      </span>
                      {r.name}
                    </span>
                  </td>
                  <td>{r.replies}</td>
                  <td title={String(r.inputTokens)}>{fmtTok(r.inputTokens)}</td>
                  <td title={String(r.outputTokens)}>{fmtTok(r.outputTokens)}</td>
                  <td title={String(r.cacheReadTokens)}>{fmtTok(r.cacheReadTokens)}</td>
                  <td title={String(r.totalTokens)}>{fmtTok(r.totalTokens)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>All agents</td>
                <td>{totals.replies}</td>
                <td>{fmtTok(totals.inputTokens)}</td>
                <td>{fmtTok(totals.outputTokens)}</td>
                <td>{fmtTok(totals.cacheReadTokens)}</td>
                <td>{fmtTok(totals.totalTokens)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

type Props = {
  open: boolean;
  onClose: () => void;
  settings: AppSettings | null;
  onRefresh: () => Promise<void>;
};

export function SettingsModal({ open, onClose, settings, onRefresh }: Props) {
  const [tab, setTab] = useState<Tab>('general');
  const [apiKey, setApiKey] = useState('');
  const [accountName, setAccountName] = useState(settings?.accountName ?? '');
  const [models, setModels] = useState<{ id: string; displayName: string }[]>([]);
  const [model, setModel] = useState(settings?.selectedModel ?? 'composer-2.5');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [systemDirty, setSystemDirty] = useState(false);
  const [systemMemory, setSystemMemory] = useState('');
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [mcpJson, setMcpJson] = useState(EMPTY_MCP_JSON);
  const [mcpBusy, setMcpBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAccountName(settings?.accountName ?? '');
    setModel(settings?.selectedModel ?? 'composer-2.5');
    void window.tecapi.models.list().then(setModels).catch(() => setModels([]));
    const loadPrompt = window.tecapi.settings.getSystemPrompt;
    if (typeof loadPrompt === 'function') {
      void loadPrompt()
        .then((t) => {
          setSystemPrompt(typeof t === 'string' ? t : '');
          setSystemDirty(false);
        })
        .catch(() => {
          setSystemPrompt('');
        });
    }
    const loadMemory = window.tecapi.settings.getSystemMemory;
    if (typeof loadMemory === 'function') {
      void loadMemory()
        .then((t) => {
          setSystemMemory(typeof t === 'string' ? t : '');
          setMemoryDirty(false);
        })
        .catch(() => {
          setSystemMemory('');
        });
    }
    const loadMcp = window.tecapi.settings.getGlobalMcp;
    if (typeof loadMcp === 'function') {
      void loadMcp()
        .then((t) => setMcpJson(typeof t === 'string' && t.trim() ? t : EMPTY_MCP_JSON))
        .catch(() => setMcpJson(EMPTY_MCP_JSON));
    }
  }, [open, settings]);

  if (!open) return null;

  async function saveKey() {
    if (!apiKey.trim()) return;
    setSaving(true);
    setStatus('');
    try {
      const res = await window.tecapi.settings.setApiKey(apiKey.trim());
      if (!res.ok) throw new Error(res.error || 'Failed');
      setApiKey('');
      setStatus('API key saved securely.');
      await onRefresh();
      const list = await window.tecapi.models.list();
      setModels(list);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function saveModel() {
    await window.tecapi.settings.setModel(model);
    setStatus(`Default model set to ${model}`);
    await onRefresh();
  }

  async function saveName() {
    await window.tecapi.settings.setAccountName(accountName.trim() || 'Local user');
    await onRefresh();
    setStatus('Account name updated.');
  }

  async function saveSystem() {
    setSaving(true);
    setStatus('');
    try {
      await window.tecapi.settings.setSystemPrompt(systemPrompt);
      setSystemDirty(false);
      setStatus('SYSTEM.md saved. Next agent turn uses this prompt.');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function saveMemory() {
    setSaving(true);
    setStatus('');
    try {
      await window.tecapi.settings.setSystemMemory(systemMemory);
      setMemoryDirty(false);
      setStatus('MEMORY.md saved. Next agent turn uses this memory block.');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function registerGlobalMcp() {
    if (mcpBusy) return;
    setMcpBusy(true);
    setStatus('');
    try {
      const result = await window.tecapi.settings.registerGlobalMcp(mcpJson);
      setStatus(result.ok ? result.note || 'Registered.' : result.error || 'Register failed');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setMcpBusy(false);
    }
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-layout">
          <nav className="settings-nav">
            <div className="settings-nav-title">Settings</div>
            {(
              [
                ['general', 'General'],
                ['system', 'System prompt'],
                ['memory', 'System memory'],
                ['mcp', 'MCP'],
                ['computer', 'Computer'],
                ['usage', 'Usage & Billing'],
                ['updates', 'Updates'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`settings-nav-item ${tab === id ? 'active' : ''}`}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="settings-body">
            <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
              ×
            </button>

            {tab === 'general' && (
              <section>
                <h2>App settings</h2>
          <p className="hint">Global for this install (API key, default model, account). Per-agent name/model use the gear in the chat header.</p>
                <label className="field">
                  <span>Display name</span>
                  <div className="row">
                    <input value={accountName} onChange={(e) => setAccountName(e.target.value)} />
                    <button type="button" className="primary" onClick={() => void saveName()}>
                      Save
                    </button>
                  </div>
                </label>

                <label className="field">
                  <span>Cursor API key</span>
                  <div className="row">
                    <input
                      type="password"
                      placeholder={settings?.hasApiKey ? '••••••••  (saved)' : 'Paste CURSOR_API_KEY'}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                    />
                    <button
                      type="button"
                      className="primary"
                      disabled={saving || !apiKey.trim()}
                      onClick={() => void saveKey()}
                    >
                      Save
                    </button>
                  </div>
                  <p className="hint">
                    Stored with Electron safeStorage on this PC only. Get a key from Cursor Dashboard →
                    API Keys.
                  </p>
                </label>

                <label className="field">
                  <span>Default model</span>
                  <div className="row">
                    <select value={model} onChange={(e) => setModel(e.target.value)}>
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.displayName}
                        </option>
                      ))}
                      {!models.find((m) => m.id === model) && (
                        <option value={model}>{model}</option>
                      )}
                    </select>
                    <button type="button" className="primary" onClick={() => void saveModel()}>
                      Apply
                    </button>
                  </div>
                </label>

                {settings?.hasApiKey && (
                  <button
                    type="button"
                    className="danger-link"
                    onClick={() =>
                      void window.tecapi.settings.clearApiKey().then(onRefresh)
                    }
                  >
                    Clear saved API key
                  </button>
                )}
                {status && <p className="status">{status}</p>}
              </section>
            )}

            {tab === 'system' && (
              <section className="system-prompt-section">
                <h2>System prompt</h2>
                <p className="hint">
                  One global instruction file for all agents: SYSTEM.md in the app root. Each agent
                  turn picks it up.
                </p>
                <textarea
                  className="system-prompt-editor"
                  spellCheck={false}
                  value={systemPrompt}
                  onChange={(e) => {
                    setSystemPrompt(e.target.value);
                    setSystemDirty(true);
                  }}
                />
                <div className="row system-prompt-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={saving}
                    onClick={() => void saveSystem()}
                  >
                    Save
                  </button>
                  {systemDirty && <span className="hint">Unsaved changes</span>}
                </div>
                {status && <p className="status">{status}</p>}
              </section>
            )}

            {tab === 'memory' && (
              <section className="system-prompt-section">
                <h2>System memory</h2>
                <p className="hint">
                  One file for all agents: MEMORY.md in the app root. Point it at a generic memory
                  skill. The store itself is the Memory directory under Computer (App data\memory).
                  Each agent turn injects both.
                </p>
                <textarea
                  className="system-prompt-editor"
                  spellCheck={false}
                  value={systemMemory}
                  onChange={(e) => {
                    setSystemMemory(e.target.value);
                    setMemoryDirty(true);
                  }}
                />
                <div className="row system-prompt-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={saving}
                    onClick={() => void saveMemory()}
                  >
                    Save
                  </button>
                  {memoryDirty && <span className="hint">Unsaved changes</span>}
                </div>
                {status && <p className="status">{status}</p>}
              </section>
            )}

            {tab === 'mcp' && (
              <section>
                <h2>Common MCP</h2>
                <p className="hint">
                  Shared servers for every agent. Merged with that agent&apos;s MCP JSON on each turn.
                  Same name: agent JSON wins. Empty agent {'{}'} still gets these. Register saves and
                  drops idle sessions so the next message attaches. Does not start MCP for every agent
                  now. Use an agent&apos;s Register only for extra servers on that agent.
                </p>
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
                <div className="row">
                  <button
                    type="button"
                    className="primary"
                    disabled={mcpBusy}
                    onClick={() => void registerGlobalMcp()}
                  >
                    {mcpBusy ? 'Registering...' : 'Register'}
                  </button>
                </div>
                {status ? <p className="status">{status}</p> : null}
              </section>
            )}

            {tab === 'computer' && (
              <section>
                <h2>Computer</h2>
                <p className="lede">
                  TecAdRiseBot is local-only. Agents run on this Windows PC via the Cursor SDK —
                  there is no remote cloud box or remote desktop control in this app.
                </p>
                <div className="info-card">
                  <div>
                    <strong>This computer</strong>
                    <div className="muted">{settings?.platform || 'win32'}</div>
                  </div>
                  <div className="pill">Local</div>
                </div>
                <label className="field">
                  <span>App data</span>
                  <code className="path">{settings?.userDataPath}</code>
                </label>
                <label className="field">
                  <span>Memory directory</span>
                  <code className="path">{settings?.memoryPath || (settings?.userDataPath ? `${settings.userDataPath}\\memory` : '')}</code>
                  <span className="hint">Shared by all agents. MEMORY.md tells them how to use it. Injected every turn.</span>
                </label>
                <label className="field">
                  <span>Skills directory</span>
                  <code className="path">{settings?.skillsPath || (settings?.userDataPath ? `${settings.userDataPath}\\skills` : '')}</code>
                  <span className="hint">
                    Shared by all agents. One subfolder per skill, with SKILL.md inside. Catalog is injected every turn so &quot;use seo skill&quot; maps to that folder.
                  </span>
                </label>
                <div className="row">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      settings?.userDataPath &&
                      void window.tecapi.app.openPath(settings.userDataPath)
                    }
                  >
                    Open data folder
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      const p = settings?.memoryPath;
                      if (p) void window.tecapi.app.openPath(p);
                    }}
                  >
                    Open memory folder
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      const p = settings?.skillsPath;
                      if (p) void window.tecapi.app.openPath(p);
                    }}
                  >
                    Open skills folder
                  </button>
                </div>
              </section>
            )}

            {tab === 'usage' && <UsageBillingBody />}

            {tab === 'updates' && (
              <section>
                <h2>Updates</h2>
                <p className="lede">Version {settings?.version ?? '0.1.0'} (MVP).</p>
                <p className="hint">Auto-update is not wired yet. Pull the latest project and rebuild.</p>
                <p className="hint powered-by">
                  Powered by:{' '}
                  <a
                    href="https://tecadrise.ai"
                    onClick={(e) => {
                      e.preventDefault();
                      void window.tecapi.app.openExternal('https://tecadrise.ai');
                    }}
                  >
                    https://tecadrise.ai
                  </a>
                </p>
              </section>
            )}
          </div>
        </div>
      </div>
    </ModalBackdrop>
  );
}
