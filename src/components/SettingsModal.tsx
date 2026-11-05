import { useEffect, useRef, useState } from 'react';
import type { AppSettings } from '../types';
import { ModalBackdrop } from './ModalBackdrop';
import { ArchitectureDiagram } from './ArchitectureDiagram';
import { MarkdownBody } from './MarkdownBody';
import workflowsSvg from '../assets/workflows.svg?raw';
import todosSvg from '../assets/todos.svg?raw';
import { EMPTY_MCP_JSON } from '../lib/mcpConfig';
import { fmtTok } from '../lib/usage';

type Tab =
  | 'general'
  | 'keys'
  | 'architecture'
  | 'system'
  | 'memory'
  | 'mcp'
  | 'connectors'
  | 'computer'
  | 'usage'
  | 'updates';

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

const SECRET_MASK = '**************************';

type ConnectorRow = {
  id: string;
  name: string;
  connected: boolean;
  dc?: string;
  hasClientId?: boolean;
  hasClientSecret?: boolean;
  clientIdMask?: string;
  clientSecretMask?: string;
};

function ConnectorsBody() {
  const [rows, setRows] = useState<ConnectorRow[]>([]);
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState('');
  const [zohoDc, setZohoDc] = useState('eu');
  const [zohoClientId, setZohoClientId] = useState('');
  const [zohoSecret, setZohoSecret] = useState('');
  const [zohoGrant, setZohoGrant] = useState('');
  const [showId, setShowId] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [showGrant, setShowGrant] = useState(false);

  async function refresh() {
    try {
      setRows(await window.tecapi.connectors.list());
    } catch {
      setRows([]);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const zohoRow = rows.find((r) => r.id === 'zoho');
  useEffect(() => {
    if (zohoRow?.dc) setZohoDc(zohoRow.dc);
  }, [zohoRow?.dc]);

  async function saveZohoField(field: 'clientId' | 'clientSecret', value: string) {
    const res = await window.tecapi.connectors.saveField('zoho', 'dc', zohoDc);
    if (!res.ok) {
      setStatus(res.error || 'Save failed');
      return;
    }
    const saved = await window.tecapi.connectors.saveField('zoho', field, value);
    setStatus(saved.ok ? 'Saved.' : saved.error || 'Save failed');
    if (!saved.ok) return;
    if (field === 'clientId') {
      setZohoClientId('');
      setShowId(false);
    } else {
      setZohoSecret('');
      setShowSecret(false);
    }
    await refresh();
  }

  async function toggleZohoField(field: 'clientId' | 'clientSecret') {
    const showing = field === 'clientId' ? showId : showSecret;
    const setShowing = field === 'clientId' ? setShowId : setShowSecret;
    const setVal = field === 'clientId' ? setZohoClientId : setZohoSecret;
    if (showing) {
      setShowing(false);
      setVal('');
      return;
    }
    try {
      const v = await window.tecapi.connectors.reveal('zoho', field);
      if (!v.trim() || /^[\s*•]+$/.test(v)) {
        setStatus('Nothing stored. Paste a new value.');
        setVal('');
        setShowing(false);
        return;
      }
      setVal(v);
      setShowing(true);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }

  async function connect(id: string) {
    setBusy(id);
    setStatus(
      id === 'zoho'
        ? zohoGrant.trim()
          ? 'Exchanging Zoho grant token…'
          : 'Browser opened. Approve Zoho, then this page will update.'
        : 'Browser opened. Approve Canva, then this page will update.'
    );
    try {
      const res = await window.tecapi.connectors.connect(
        id,
        id === 'zoho'
          ? { dc: zohoDc, clientId: zohoClientId, clientSecret: zohoSecret, grantCode: zohoGrant }
          : undefined
      );
      const ok =
        id === 'zoho'
          ? 'Zoho Mail connected. All agents get mail tools on the next turn.'
          : 'Canva connected. All agents get it on the next turn.';
      setStatus(res.ok ? ok : res.error || 'Connect failed');
      if (res.ok && id === 'zoho') {
        setZohoClientId('');
        setZohoSecret('');
        setZohoGrant('');
        setShowId(false);
        setShowSecret(false);
      }
      await refresh();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  async function disconnect(id: string) {
    setBusy(id);
    setStatus('');
    try {
      await window.tecapi.connectors.disconnect(id);
      setStatus('Disconnected.');
      await refresh();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  return (
    <section>
      <h2>Connectors</h2>
      <p className="hint">
        Global for every agent. Connect opens the vendor site in your browser. After you approve, tokens
        stay in secrets.bin on this PC and every bot can use that account.
      </p>
      {rows.map((r) => (
        <div key={r.id} className="connector-block">
          <div className="connector-row">
            <div>
              <div className="connector-name">{r.name}</div>
              <div className={`connector-state ${r.connected ? 'on' : 'off'}`}>
                {r.connected ? 'Connected' : 'Not connected'}
              </div>
            </div>
            <div className="connector-actions">
              {r.connected ? (
                <button type="button" className="secondary" disabled={busy === r.id} onClick={() => void disconnect(r.id)}>
                  Disconnect
                </button>
              ) : (
                <button type="button" className="primary" disabled={Boolean(busy)} onClick={() => void connect(r.id)}>
                  {busy === r.id ? 'Waiting…' : 'Connect'}
                </button>
              )}
              <button
                type="button"
                className="secondary"
                disabled={busy === r.id}
                onClick={() =>
                  void (async () => {
                    await window.tecapi.connectors.clearField(r.id, 'all');
                    if (r.connected) await disconnect(r.id);
                    if (r.id === 'zoho') {
                      setZohoClientId('');
                      setZohoSecret('');
                      setZohoGrant('');
                      setShowId(false);
                      setShowSecret(false);
                    }
                    setStatus('Cleared.');
                    await refresh();
                  })()
                }
              >
                Clear
              </button>
            </div>
          </div>
          {r.id === 'zoho' ? (
            <div className="connector-fields">
              <p className="hint">
                Register a client at api-console.zoho.eu (Poland is usually EU). Scopes:
                ZohoMail.accounts.READ, folders.READ, messages.READ, messages.CREATE. Server-based
                client redirect: http://127.0.0.1:18767/callback. Self Client: paste a grant token
                instead of using the browser. About 30 API calls/minute on free. After adding send,
                Disconnect then Connect so Zoho asks again.
              </p>
              <label>
                Data center
                <select value={zohoDc} onChange={(e) => setZohoDc(e.target.value)}>
                  <option value="eu">EU (Poland)</option>
                  <option value="com">US (.com)</option>
                  <option value="in">India</option>
                  <option value="au">Australia</option>
                  <option value="uk">UK</option>
                  <option value="jp">Japan</option>
                  <option value="ca">Canada</option>
                  <option value="sa">Saudi Arabia</option>
                </select>
              </label>
              <table className="keys-table">
                <tbody>
                  <tr>
                    <td className="keys-name">Client ID</td>
                    <td>
                      <input
                        type={showId ? 'text' : 'password'}
                        value={zohoClientId}
                        onChange={(e) => {
                          setZohoClientId(e.target.value);
                          setShowId(true);
                        }}
                        autoComplete="off"
                        placeholder={zohoRow?.hasClientId ? SECRET_MASK : 'Paste client ID'}
                        spellCheck={false}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="secondary"
                        disabled={!zohoRow?.hasClientId && !zohoClientId}
                        onClick={() => void toggleZohoField('clientId')}
                      >
                        {showId ? 'Hide' : 'Show'}
                      </button>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="primary"
                        disabled={!zohoClientId.trim()}
                        onClick={() => void saveZohoField('clientId', zohoClientId)}
                      >
                        Save
                      </button>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                          void (async () => {
                            await window.tecapi.connectors.clearField('zoho', 'clientId');
                            setZohoClientId('');
                            setShowId(false);
                            await refresh();
                          })()
                        }
                      >
                        Clear
                      </button>
                    </td>
                  </tr>
                  <tr>
                    <td className="keys-name">Client secret</td>
                    <td>
                      <input
                        type={showSecret ? 'text' : 'password'}
                        value={zohoSecret}
                        onChange={(e) => {
                          setZohoSecret(e.target.value);
                          setShowSecret(true);
                        }}
                        autoComplete="off"
                        placeholder={zohoRow?.hasClientSecret ? SECRET_MASK : 'Paste client secret'}
                        spellCheck={false}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="secondary"
                        disabled={!zohoRow?.hasClientSecret && !zohoSecret}
                        onClick={() => void toggleZohoField('clientSecret')}
                      >
                        {showSecret ? 'Hide' : 'Show'}
                      </button>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="primary"
                        disabled={!zohoSecret.trim()}
                        onClick={() => void saveZohoField('clientSecret', zohoSecret)}
                      >
                        Save
                      </button>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                          void (async () => {
                            await window.tecapi.connectors.clearField('zoho', 'clientSecret');
                            setZohoSecret('');
                            setShowSecret(false);
                            await refresh();
                          })()
                        }
                      >
                        Clear
                      </button>
                    </td>
                  </tr>
                  <tr>
                    <td className="keys-name">Grant token</td>
                    <td>
                      <input
                        type={showGrant ? 'text' : 'password'}
                        value={zohoGrant}
                        onChange={(e) => setZohoGrant(e.target.value)}
                        autoComplete="off"
                        placeholder="Self Client, optional"
                        spellCheck={false}
                      />
                    </td>
                    <td>
                      <button type="button" className="secondary" onClick={() => setShowGrant((v) => !v)}>
                        {showGrant ? 'Hide' : 'Show'}
                      </button>
                    </td>
                    <td />
                    <td>
                      <button type="button" className="secondary" onClick={() => setZohoGrant('')}>
                        Clear
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ))}
      {status ? <p className={`status${status.toLowerCase().includes('fail') ? ' error' : ''}`}>{status}</p> : null}
    </section>
  );
}

const CURSOR_KEY_NAME = 'CURSOR_SDK_API_KEY';

function ApiKeysBody({
  settings,
  onRefresh,
}: {
  settings: AppSettings | null;
  onRefresh: () => Promise<void>;
}) {
  const [rows, setRows] = useState<Array<{ name: string; masked: string }>>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [status, setStatus] = useState('');

  async function refreshEnv() {
    try {
      setRows(await window.tecapi.secrets.envList());
    } catch {
      setRows([]);
    }
  }

  useEffect(() => {
    void refreshEnv();
  }, []);

  function setDraft(name: string, value: string) {
    setDrafts((cur) => ({ ...cur, [name]: value }));
  }

  async function toggleShow(name: string) {
    if (shown[name]) {
      setShown((cur) => ({ ...cur, [name]: false }));
      setDraft(name, '');
      return;
    }
    const v = await window.tecapi.secrets.reveal(name);
    setDraft(name, v);
    setShown((cur) => ({ ...cur, [name]: true }));
  }

  async function saveRow(name: string, value: string) {
    const v = value.trim();
    if (!v) return;
    if (name === CURSOR_KEY_NAME) {
      const res = await window.tecapi.settings.setApiKey(v);
      setStatus(res.ok ? 'CURSOR_SDK_API_KEY saved.' : res.error || 'Save failed');
      if (res.ok) {
        setDraft(name, '');
        setShown((cur) => ({ ...cur, [name]: false }));
        await onRefresh();
      }
      return;
    }
    const res = await window.tecapi.secrets.envSet(name, v);
    setStatus(res.ok ? `${name} saved.` : res.error || 'Save failed');
    if (res.ok) {
      setDraft(name, '');
      setShown((cur) => ({ ...cur, [name]: false }));
      await refreshEnv();
    }
  }

  const names = [CURSOR_KEY_NAME, ...rows.map((r) => r.name)];

  return (
    <section>
      <h2>API Keys</h2>
      <p className="hint">
        One table. CURSOR_SDK_API_KEY is required. Add any other name for MCP {'${env:NAME}'}.
      </p>
      <table className="keys-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Secret</th>
            <th />
            <th />
            <th />
          </tr>
        </thead>
        <tbody>
          {names.map((name) => {
            const isCursor = name === CURSOR_KEY_NAME;
            const has = isCursor ? Boolean(settings?.hasApiKey) : true;
            const draft = drafts[name] ?? '';
            const open = Boolean(shown[name]);
            return (
              <tr key={name}>
                <td className="keys-name">{name}</td>
                <td>
                  <input
                    type={open ? 'text' : 'password'}
                    placeholder={has ? SECRET_MASK : 'Paste key'}
                    value={draft}
                    onChange={(e) => setDraft(name, e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </td>
                <td>
                  <button type="button" className="secondary" disabled={!has && !draft} onClick={() => void toggleShow(name)}>
                    {open ? 'Hide' : 'Show'}
                  </button>
                </td>
                <td>
                  <button type="button" className="primary" disabled={!draft.trim()} onClick={() => void saveRow(name, draft)}>
                    Save
                  </button>
                </td>
                <td>
                  {isCursor ? (
                    <button
                      type="button"
                      className="secondary"
                      disabled={!settings?.hasApiKey}
                      onClick={() =>
                        void (async () => {
                          await window.tecapi.settings.clearApiKey();
                          setDraft(name, '');
                          setShown((cur) => ({ ...cur, [name]: false }));
                          await onRefresh();
                          setStatus('CURSOR_SDK_API_KEY removed.');
                        })()
                      }
                    >
                      Remove
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        void (async () => {
                          await window.tecapi.secrets.envDelete(name);
                          setDraft(name, '');
                          await refreshEnv();
                        })()
                      }
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          <tr>
            <td>
              <input placeholder="Key name" value={newName} onChange={(e) => setNewName(e.target.value)} autoComplete="off" />
            </td>
            <td>
              <input
                type={showNew ? 'text' : 'password'}
                placeholder="Secret"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </td>
            <td>
              <button type="button" className="secondary" onClick={() => setShowNew((v) => !v)}>
                {showNew ? 'Hide' : 'Show'}
              </button>
            </td>
            <td>
              <button
                type="button"
                className="primary"
                disabled={!newName.trim() || !newValue.trim()}
                onClick={() =>
                  void (async () => {
                    await saveRow(newName.trim(), newValue);
                    setNewName('');
                    setNewValue('');
                    setShowNew(false);
                  })()
                }
              >
                Add
              </button>
            </td>
            <td />
          </tr>
        </tbody>
      </table>
      {status ? <p className={`status${status.toLowerCase().includes('fail') ? ' error' : ''}`}>{status}</p> : null}
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
  const [archDoc, setArchDoc] = useState<{ name: string; text: string } | null>(null);

  function openArchDoc(name: string) {
    const read =
      name === 'SYSTEM.md'
        ? window.tecapi.settings.getSystemPrompt()
        : name === 'MEMORY.md'
          ? window.tecapi.settings.getSystemMemory()
          : window.tecapi.app.readArchitecture();
    read
      .then((t) => setArchDoc({ name, text: t || `${name} is empty.` }))
      .catch((err) => setArchDoc({ name, text: `Could not read ${name}: ${String(err)}` }));
  }
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
  const [missedGrace, setMissedGrace] = useState(String(settings?.missedGraceMinutes ?? 15));

  // Seed form fields once per open. Re-seeding on every settings refresh wiped unsaved edits.
  const seeded = useRef(false);
  useEffect(() => {
    if (!open) {
      seeded.current = false;
      return;
    }
    if (seeded.current || !settings) return;
    seeded.current = true;
    setAccountName(settings.accountName ?? '');
    setModel(settings.selectedModel ?? 'composer-2.5');
    setMissedGrace(String(settings.missedGraceMinutes ?? 15));
  }, [open, settings]);

  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  if (!open) return null;

  async function guarded(fn: () => Promise<void>) {
    setStatus('');
    try {
      await fn();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }

  function saveModel() {
    return guarded(async () => {
      await window.tecapi.settings.setModel(model);
      setStatus(`Default model set to ${model}`);
      await onRefresh();
    });
  }

  function saveMissedGrace() {
    return guarded(async () => {
      const v = await window.tecapi.settings.setMissedGraceMinutes(Number(missedGrace));
      setMissedGrace(String(v));
      await onRefresh();
      setStatus(`Missed routines older than ${v} min are skipped.`);
    });
  }

  function saveName() {
    return guarded(async () => {
      await window.tecapi.settings.setAccountName(accountName.trim() || 'Local user');
      await onRefresh();
      setStatus('Account name updated.');
    });
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
                ['architecture', 'Architecture'],
                ['system', 'System prompt'],
                ['memory', 'System memory'],
                ['mcp', 'MCP'],
                ['keys', 'API Keys'],
                ['connectors', 'Connectors'],
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
          <p className="hint">Global for this install (default model, account). Per-agent name/model use the gear in the chat header. Keys live under API Keys.</p>
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

                <label className="field">
                  <span>Missed routine window (minutes)</span>
                  <div className="row">
                    <input
                      type="number"
                      min={0}
                      max={1440}
                      value={missedGrace}
                      onChange={(e) => setMissedGrace(e.target.value)}
                    />
                    <button type="button" className="primary" onClick={() => void saveMissedGrace()}>
                      Save
                    </button>
                  </div>
                  <p className="hint">
                    All agents. A routine that was due while the app was closed (PC off) still runs on
                    start only if it was due within this many minutes. Older ones are skipped and wait
                    for their next scheduled time.
                  </p>
                </label>

                {status && <p className="status">{status}</p>}
              </section>
            )}

            {tab === 'keys' && <ApiKeysBody settings={settings} onRefresh={onRefresh} />}

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

            {tab === 'connectors' && <ConnectorsBody />}

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

            {tab === 'architecture' && (
              <section>
                <h2>
                  Architecture:{' '}
                  <a
                    href="#"
                    className="arch-title-link"
                    onClick={(e) => {
                      e.preventDefault();
                      if (archDoc !== null) setArchDoc(null);
                      else openArchDoc('ARCHITECTURE.md');
                    }}
                  >
                    {archDoc !== null ? `Back to diagram (${archDoc.name})` : 'See ARCHITECTURE.md'}
                  </a>
                </h2>
                {archDoc !== null ? (
                  <MarkdownBody className="arch-doc" text={archDoc.text} />
                ) : (
                  <>
                    <ArchitectureDiagram onOpenDoc={openArchDoc} />
                    <h3 className="arch-sub">Step Workflows</h3>
                    <ArchitectureDiagram
                      svg={workflowsSvg}
                      width={1200}
                      height={600}
                      label="How step workflows work: runner, app checks, owner review and fix"
                    />
                    <h3 className="arch-sub">updateTodos Workflows</h3>
                    <ArchitectureDiagram
                      svg={todosSvg}
                      width={1200}
                      height={520}
                      label="How updateTodos workflows work: routine Prompt list, agent translates to todos, auto-continue"
                    />
                    <div className="arch-end-space" />
                  </>
                )}
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
                  , we do web development, coding and AI automations, need help? Contact us:{' '}
                  <a
                    href="mailto:info@tecadrise.ai"
                    onClick={(e) => {
                      e.preventDefault();
                      void window.tecapi.app.openExternal('mailto:info@tecadrise.ai');
                    }}
                  >
                    info@tecadrise.ai
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
