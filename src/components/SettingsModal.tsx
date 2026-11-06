import { useEffect, useRef, useState } from 'react';
import type { AppSettings } from '../types';
import { ModalBackdrop } from './ModalBackdrop';
import { ArchitectureDiagram } from './ArchitectureDiagram';
import { MarkdownBody } from './MarkdownBody';
import workflowsSvg from '../assets/workflows.svg?raw';
import todosSvg from '../assets/todos.svg?raw';
import { EMPTY_MCP_JSON } from '../lib/mcpConfig';
import { fmtTok } from '../lib/usage';
import {
  GITHUB_REPO_URL,
  PRODUCT_PAGE_URL,
  githubTreeUrl,
  statusFor,
  type LatestRelease,
  type UpdateStatus,
} from '../lib/appUpdate';
import { BYOK_PRESETS, HF_BYOK_NAME, HF_BYOK_URL } from '../lib/byok';

type Tab =
  | 'general'
  | 'keys'
  | 'byok'
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
  hasToken?: boolean;
  org?: string;
};

function ConnectorsBody({ highlightId }: { highlightId?: string | null }) {
  const [rows, setRows] = useState<ConnectorRow[]>([]);
  const [busy, setBusy] = useState('');
  const connectSeq = useRef(0);
  const [status, setStatus] = useState('');
  const [zohoDc, setZohoDc] = useState('eu');
  const [zohoClientId, setZohoClientId] = useState('');
  const [zohoSecret, setZohoSecret] = useState('');
  const [zohoGrant, setZohoGrant] = useState('');
  const [showId, setShowId] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [showGrant, setShowGrant] = useState(false);
  const [tregToken, setTregToken] = useState('');
  const [tregOrg, setTregOrg] = useState('tecadrisebot');
  const [showTreg, setShowTreg] = useState(false);
  const [mailKey, setMailKey] = useState('');
  const [showMail, setShowMail] = useState(false);
  const [ctxKey, setCtxKey] = useState('');
  const [showCtx, setShowCtx] = useState(false);
  const [ghClientId, setGhClientId] = useState('');
  const [ghSecret, setGhSecret] = useState('');
  const [showGhId, setShowGhId] = useState(false);
  const [showGhSecret, setShowGhSecret] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});

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

  useEffect(() => {
    if (!highlightId) return;
    setOpen((cur) => ({ ...cur, [highlightId]: true }));
    const el = document.getElementById(`connector-${highlightId}`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlightId, rows.length]);

  const zohoRow = rows.find((r) => r.id === 'zoho');
  const tregRow = rows.find((r) => r.id === 'treg');
  const mailRow = rows.find((r) => r.id === 'agentmail');
  const ctxRow = rows.find((r) => r.id === 'context');
  const ghRow = rows.find((r) => r.id === 'github');
  const extra = (id: string) =>
    id === 'zoho' || id === 'treg' || id === 'agentmail' || id === 'context' || id === 'github';
  useEffect(() => {
    if (zohoRow?.dc) setZohoDc(zohoRow.dc);
  }, [zohoRow?.dc]);
  useEffect(() => {
    if (tregRow?.org) setTregOrg(tregRow.org);
  }, [tregRow?.org]);

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
    const seq = ++connectSeq.current;
    setBusy(id);
    setStatus(
      id === 'zoho'
        ? zohoGrant.trim()
          ? 'Exchanging Zoho grant token…'
          : 'Browser opened. Approve Zoho, then this page will update.'
        : id === 'treg'
          ? 'Saving Treg token…'
          : id === 'agentmail'
            ? 'Saving AgentMail key…'
            : id === 'context'
              ? 'Saving Context.dev key…'
              : id === 'github'
                ? 'Browser opened. Approve GitHub, then this page will update.'
                : id === 'elevenlabs'
                  ? 'Browser opened. Approve ElevenLabs, then this page will update.'
                  : 'Browser opened. Approve Canva, then this page will update.'
    );
    try {
      const res = await window.tecapi.connectors.connect(
        id,
        id === 'zoho'
          ? { dc: zohoDc, clientId: zohoClientId, clientSecret: zohoSecret, grantCode: zohoGrant }
          : id === 'treg'
            ? { token: tregToken, org: tregOrg }
            : id === 'agentmail'
              ? { apiKey: mailKey }
              : id === 'context'
                ? { apiKey: ctxKey }
                : id === 'github'
                  ? { clientId: ghClientId, clientSecret: ghSecret }
                  : undefined
      );
      const ok =
        id === 'zoho'
          ? 'Zoho Mail connected. All agents get mail tools on the next turn.'
          : id === 'treg'
            ? 'Treg connected. All agents get catalog tools on the next turn.'
            : id === 'agentmail'
              ? 'AgentMail connected. All agents get mail tools on the next turn.'
              : id === 'context'
                ? 'Context.dev connected. All agents get scrape and search tools on the next turn.'
                : id === 'github'
                  ? 'GitHub connected. All agents get repo tools on the next turn.'
                  : id === 'elevenlabs'
                    ? 'ElevenLabs connected. All agents get voice tools on the next turn.'
                    : 'Canva connected. All agents get it on the next turn.';
      setStatus(res.ok ? ok : res.error || 'Connect failed');
      if (res.ok && id === 'zoho') {
        setZohoClientId('');
        setZohoSecret('');
        setZohoGrant('');
        setShowId(false);
        setShowSecret(false);
      }
      if (res.ok && id === 'treg') {
        setTregToken('');
        setShowTreg(false);
      }
      if (res.ok && id === 'agentmail') {
        setMailKey('');
        setShowMail(false);
      }
      if (res.ok && id === 'context') {
        setCtxKey('');
        setShowCtx(false);
      }
      if (res.ok && id === 'github') {
        setGhClientId('');
        setGhSecret('');
        setShowGhId(false);
        setShowGhSecret(false);
      }
      await refresh();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      if (connectSeq.current === seq) setBusy('');
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
        Global for every agent. Canva, Zoho, GitHub and ElevenLabs open the vendor site in your browser.
        Treg, AgentMail and Context.dev use a saved token. Tokens stay in secrets.bin, not in MCP JSON.
        Agents call show_connector; this pane opens when an app is off.
      </p>
      {rows.map((r) => (
        <div
          key={r.id}
          id={`connector-${r.id}`}
          className={`connector-block${highlightId === r.id ? ' flash' : ''}`}
        >
          <div className="connector-row">
            <div>
              <div className="connector-name">{r.name}</div>
              <div className={`connector-state ${r.connected ? 'on' : 'off'}`}>
                {r.connected ? 'Connected' : 'Not connected'}
              </div>
            </div>
            <div className="connector-actions">
              {extra(r.id) ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setOpen((cur) => ({ ...cur, [r.id]: !cur[r.id] }))}
                >
                  {open[r.id] ? 'Collapse' : 'Expand'}
                </button>
              ) : null}
              {r.connected ? (
                <button type="button" className="secondary" disabled={busy === r.id} onClick={() => void disconnect(r.id)}>
                  Disconnect
                </button>
              ) : (
                <button
                  type="button"
                  className="primary"
                  disabled={Boolean(busy) && busy !== r.id}
                  onClick={() => {
                    if (extra(r.id)) setOpen((cur) => ({ ...cur, [r.id]: true }));
                    void connect(r.id);
                  }}
                >
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
                    if (r.id === 'treg') {
                      setTregToken('');
                      setShowTreg(false);
                    }
                    if (r.id === 'agentmail') {
                      setMailKey('');
                      setShowMail(false);
                    }
                    if (r.id === 'context') {
                      setCtxKey('');
                      setShowCtx(false);
                    }
                    if (r.id === 'github') {
                      setGhClientId('');
                      setGhSecret('');
                      setShowGhId(false);
                      setShowGhSecret(false);
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
          {r.id === 'zoho' && open.zoho ? (
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
          {r.id === 'treg' && open.treg ? (
            <div className="connector-fields">
              <p className="hint">
                Team token from treg.to, org slug for X-Treg-Org (tecadrisebot). A treg block in Common MCP
                is moved here on launch so the token is not left in JSON.
              </p>
              <table className="keys-table">
                <tbody>
                  <tr>
                    <td className="keys-name">Org</td>
                    <td>
                      <input
                        type="text"
                        value={tregOrg}
                        onChange={(e) => setTregOrg(e.target.value)}
                        autoComplete="off"
                        placeholder="tecadrisebot"
                        spellCheck={false}
                      />
                    </td>
                    <td />
                    <td>
                      <button
                        type="button"
                        className="primary"
                        disabled={!tregOrg.trim()}
                        onClick={() =>
                          void (async () => {
                            const res = await window.tecapi.connectors.saveField('treg', 'org', tregOrg);
                            setStatus(res.ok ? 'Saved.' : res.error || 'Save failed');
                            await refresh();
                          })()
                        }
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
                            await window.tecapi.connectors.clearField('treg', 'org');
                            setTregOrg('tecadrisebot');
                            await refresh();
                          })()
                        }
                      >
                        Clear
                      </button>
                    </td>
                  </tr>
                  <tr>
                    <td className="keys-name">Token</td>
                    <td>
                      <input
                        type={showTreg ? 'text' : 'password'}
                        value={tregToken}
                        onChange={(e) => {
                          setTregToken(e.target.value);
                          setShowTreg(true);
                        }}
                        autoComplete="off"
                        placeholder={tregRow?.hasToken ? SECRET_MASK : 'Paste team token'}
                        spellCheck={false}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="secondary"
                        disabled={!tregRow?.hasToken && !tregToken}
                        onClick={() =>
                          void (async () => {
                            if (showTreg) {
                              setShowTreg(false);
                              setTregToken('');
                              return;
                            }
                            const v = await window.tecapi.connectors.reveal('treg', 'token');
                            if (!v.trim()) {
                              setStatus('Nothing stored. Paste a new token.');
                              return;
                            }
                            setTregToken(v);
                            setShowTreg(true);
                          })()
                        }
                      >
                        {showTreg ? 'Hide' : 'Show'}
                      </button>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="primary"
                        disabled={!tregToken.trim()}
                        onClick={() =>
                          void (async () => {
                            await window.tecapi.connectors.saveField('treg', 'org', tregOrg);
                            const res = await window.tecapi.connectors.saveField('treg', 'token', tregToken);
                            setStatus(res.ok ? 'Saved.' : res.error || 'Save failed');
                            if (!res.ok) return;
                            setTregToken('');
                            setShowTreg(false);
                            await refresh();
                          })()
                        }
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
                            await window.tecapi.connectors.clearField('treg', 'token');
                            setTregToken('');
                            setShowTreg(false);
                            await refresh();
                          })()
                        }
                      >
                        Clear
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : null}
          {r.id === 'github' && open.github ? (
            <div className="connector-fields">
              <p className="hint">
                Register a GitHub OAuth App at github.com/settings/developers, name it TecAdRiseBot.
                Callback: http://127.0.0.1:18768/callback. Save Client ID and Client secret here, then
                Connect. GitHub opens in the browser to approve TecAdRiseBot. MCP name is github.
              </p>
              <table className="keys-table">
                <tbody>
                  <tr>
                    <td className="keys-name">Client ID</td>
                    <td>
                      <input
                        type={showGhId ? 'text' : 'password'}
                        value={ghClientId}
                        onChange={(e) => {
                          setGhClientId(e.target.value);
                          setShowGhId(true);
                        }}
                        autoComplete="off"
                        placeholder={ghRow?.hasClientId ? SECRET_MASK : 'OAuth App client ID'}
                        spellCheck={false}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="secondary"
                        disabled={!ghRow?.hasClientId && !ghClientId}
                        onClick={() =>
                          void (async () => {
                            if (showGhId) {
                              setShowGhId(false);
                              setGhClientId('');
                              return;
                            }
                            const v = await window.tecapi.connectors.reveal('github', 'clientId');
                            setGhClientId(v);
                            setShowGhId(true);
                          })()
                        }
                      >
                        {showGhId ? 'Hide' : 'Show'}
                      </button>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="primary"
                        disabled={!ghClientId.trim()}
                        onClick={() =>
                          void (async () => {
                            const res = await window.tecapi.connectors.saveField('github', 'clientId', ghClientId);
                            setStatus(res.ok ? 'Saved.' : res.error || 'Save failed');
                            if (!res.ok) return;
                            setGhClientId('');
                            setShowGhId(false);
                            await refresh();
                          })()
                        }
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
                            await window.tecapi.connectors.clearField('github', 'clientId');
                            setGhClientId('');
                            setShowGhId(false);
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
                        type={showGhSecret ? 'text' : 'password'}
                        value={ghSecret}
                        onChange={(e) => {
                          setGhSecret(e.target.value);
                          setShowGhSecret(true);
                        }}
                        autoComplete="off"
                        placeholder={ghRow?.hasClientSecret ? SECRET_MASK : 'OAuth App client secret'}
                        spellCheck={false}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="secondary"
                        disabled={!ghRow?.hasClientSecret && !ghSecret}
                        onClick={() =>
                          void (async () => {
                            if (showGhSecret) {
                              setShowGhSecret(false);
                              setGhSecret('');
                              return;
                            }
                            const v = await window.tecapi.connectors.reveal('github', 'clientSecret');
                            setGhSecret(v);
                            setShowGhSecret(true);
                          })()
                        }
                      >
                        {showGhSecret ? 'Hide' : 'Show'}
                      </button>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="primary"
                        disabled={!ghSecret.trim()}
                        onClick={() =>
                          void (async () => {
                            const res = await window.tecapi.connectors.saveField(
                              'github',
                              'clientSecret',
                              ghSecret
                            );
                            setStatus(res.ok ? 'Saved.' : res.error || 'Save failed');
                            if (!res.ok) return;
                            setGhSecret('');
                            setShowGhSecret(false);
                            await refresh();
                          })()
                        }
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
                            await window.tecapi.connectors.clearField('github', 'clientSecret');
                            setGhSecret('');
                            setShowGhSecret(false);
                            await refresh();
                          })()
                        }
                      >
                        Clear
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : null}
          {r.id === 'context' && open.context ? (
            <div className="connector-fields">
              <p className="hint">
                API key from context.dev, sent as Bearer to mcp.context.dev. Keep it here, not in API Keys
                or MCP JSON.
              </p>
              <table className="keys-table">
                <tbody>
                  <tr>
                    <td className="keys-name">API key</td>
                    <td>
                      <input
                        type={showCtx ? 'text' : 'password'}
                        value={ctxKey}
                        onChange={(e) => {
                          setCtxKey(e.target.value);
                          setShowCtx(true);
                        }}
                        autoComplete="off"
                        placeholder={ctxRow?.hasToken ? SECRET_MASK : 'Paste API key'}
                        spellCheck={false}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="secondary"
                        disabled={!ctxRow?.hasToken && !ctxKey}
                        onClick={() =>
                          void (async () => {
                            if (showCtx) {
                              setShowCtx(false);
                              setCtxKey('');
                              return;
                            }
                            const v = await window.tecapi.connectors.reveal('context', 'apiKey');
                            if (!v.trim()) {
                              setStatus('Nothing stored. Paste a new key.');
                              return;
                            }
                            setCtxKey(v);
                            setShowCtx(true);
                          })()
                        }
                      >
                        {showCtx ? 'Hide' : 'Show'}
                      </button>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="primary"
                        disabled={!ctxKey.trim()}
                        onClick={() =>
                          void (async () => {
                            const res = await window.tecapi.connectors.saveField('context', 'apiKey', ctxKey);
                            setStatus(res.ok ? 'Saved.' : res.error || 'Save failed');
                            if (!res.ok) return;
                            setCtxKey('');
                            setShowCtx(false);
                            await refresh();
                          })()
                        }
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
                            await window.tecapi.connectors.clearField('context', 'apiKey');
                            setCtxKey('');
                            setShowCtx(false);
                            await refresh();
                          })()
                        }
                      >
                        Clear
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : null}
          {r.id === 'agentmail' && open.agentmail ? (
            <div className="connector-fields">
              <p className="hint">
                API key from console.agentmail.to, sent as x-api-key. Keep it here, not in API Keys or MCP JSON.
              </p>
              <table className="keys-table">
                <tbody>
                  <tr>
                    <td className="keys-name">API key</td>
                    <td>
                      <input
                        type={showMail ? 'text' : 'password'}
                        value={mailKey}
                        onChange={(e) => {
                          setMailKey(e.target.value);
                          setShowMail(true);
                        }}
                        autoComplete="off"
                        placeholder={mailRow?.hasToken ? SECRET_MASK : 'Paste API key'}
                        spellCheck={false}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="secondary"
                        disabled={!mailRow?.hasToken && !mailKey}
                        onClick={() =>
                          void (async () => {
                            if (showMail) {
                              setShowMail(false);
                              setMailKey('');
                              return;
                            }
                            const v = await window.tecapi.connectors.reveal('agentmail', 'apiKey');
                            if (!v.trim()) {
                              setStatus('Nothing stored. Paste a new key.');
                              return;
                            }
                            setMailKey(v);
                            setShowMail(true);
                          })()
                        }
                      >
                        {showMail ? 'Hide' : 'Show'}
                      </button>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="primary"
                        disabled={!mailKey.trim()}
                        onClick={() =>
                          void (async () => {
                            const res = await window.tecapi.connectors.saveField('agentmail', 'apiKey', mailKey);
                            setStatus(res.ok ? 'Saved.' : res.error || 'Save failed');
                            if (!res.ok) return;
                            setMailKey('');
                            setShowMail(false);
                            await refresh();
                          })()
                        }
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
                            await window.tecapi.connectors.clearField('agentmail', 'apiKey');
                            setMailKey('');
                            setShowMail(false);
                            await refresh();
                          })()
                        }
                      >
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

function ByokBody() {
  type Row = { id: string; name: string; baseUrl: string; hasKey: boolean; masked: string; models: string };
  const [rows, setRows] = useState<Row[]>([]);
  const [name, setName] = useState<string>(HF_BYOK_NAME);
  const [baseUrl, setBaseUrl] = useState<string>(HF_BYOK_URL);
  const [apiKey, setApiKey] = useState('');
  const [modelsText, setModelsText] = useState('');
  const [editId, setEditId] = useState('');
  const [show, setShow] = useState(false);
  const [status, setStatus] = useState('');

  async function refresh() {
    try {
      const list = await window.tecapi.secrets.byokList();
      setRows(list);
      setEditId((cur) => cur || list[0]?.id || '');
    } catch {
      setRows([]);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  function targetId(): string {
    if (editId) return editId;
    const hit = rows.find((r) => r.name === name && r.baseUrl.replace(/\/+$/, '') === baseUrl.replace(/\/+$/, ''));
    return hit?.id || rows[0]?.id || '';
  }

  async function toggleShow() {
    if (show) {
      setShow(false);
      setApiKey('');
      return;
    }
    const id = targetId();
    if (!id) {
      setShow(true);
      return;
    }
    const v = await window.tecapi.secrets.byokReveal(id);
    setEditId(id);
    setApiKey(v);
    setShow(true);
  }

  async function save() {
    const res = await window.tecapi.secrets.byokUpsert({
      id: editId || undefined,
      name,
      baseUrl,
      apiKey,
      models: modelsText,
    });
    setStatus(res.ok ? 'Saved in secrets.bin only.' : res.error || 'Save failed');
    if (res.ok) {
      setApiKey('');
      setShow(false);
      setEditId(res.id || '');
      await refresh();
    }
  }

  return (
    <section>
      <h2>BYOK</h2>
      <p className="hint">
        OpenAI-compatible providers. The token is encrypted in this install&apos;s secrets.bin. It is never written to
        Soul, Memory, git, or environment variables. Use a preset to fill Provider and Base URL, then paste the key.
      </p>
      <label className="field">
        <span>Provider</span>
        <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </label>
      <label className="field">
        <span>Base URL</span>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      <label className="field">
        <span>API key</span>
        <div className="row">
          <input
            type={show ? 'text' : 'password'}
            placeholder={editId && rows.find((r) => r.id === editId)?.hasKey ? SECRET_MASK : 'Paste token'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" className="secondary" onClick={() => void toggleShow()}>
            {show ? 'Hide' : 'Show'}
          </button>
          <button type="button" className="primary" onClick={() => void save()}>
            Save
          </button>
        </div>
      </label>
      <label className="field">
        <span>Models</span>
        <input
          value={modelsText}
          onChange={(e) => setModelsText(e.target.value)}
          placeholder="z-ai/glm-5.3-flash, moonshotai/kimi-k3.1-pro"
          autoComplete="off"
          spellCheck={false}
        />
        <span className="hint">Comma-separated model ids. These fill the agent Model dropdown for this provider.</span>
      </label>
      <div className="row byok-preset-row">
        {BYOK_PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            className="secondary"
            onClick={() => {
              setName(p.name);
              setBaseUrl(p.baseUrl);
              setEditId('');
              setApiKey('');
              setModelsText('');
              setShow(false);
            }}
          >
            {p.name}
          </button>
        ))}
      </div>
      {rows.length ? (
        <table className="keys-table byok-providers-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>URL</th>
              <th>Key</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="keys-name">{r.name}</td>
                <td>{r.baseUrl}</td>
                <td>{r.hasKey ? r.masked : '—'}</td>
                <td>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setEditId(r.id);
                      setName(r.name);
                      setBaseUrl(r.baseUrl);
                      setApiKey('');
                      setModelsText(r.models || '');
                      setShow(false);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      void (async () => {
                        await window.tecapi.secrets.byokDelete(r.id);
                        if (editId === r.id) setEditId('');
                        await refresh();
                      })()
                    }
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="hint">No BYOK providers yet.</p>
      )}
      {status ? <p className={`status${status.toLowerCase().includes('fail') ? ' error' : ''}`}>{status}</p> : null}
    </section>
  );
}

function UpdatesBody({ localVersion }: { localVersion: string }) {
  const [latest, setLatest] = useState<LatestRelease | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<UpdateStatus>('loading');

  function applyCheck(r: { ok: boolean; latest: LatestRelease | null; error?: string }) {
    setLatest(r.latest);
    setError(r.ok ? '' : r.error || 'Could not reach tecadrise.ai');
    setStatus(statusFor(localVersion, r.latest, !r.ok));
  }

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    void window.tecapi.updates
      .check()
      .then((r) => {
        if (!cancelled) applyCheck(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setLatest(null);
          setError(e instanceof Error ? e.message : 'Could not reach tecadrise.ai');
          setStatus('error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [localVersion]);

  const headline =
    status === 'loading'
      ? 'Checking tecadrise.ai for the latest installer…'
      : status === 'available'
        ? `Version ${latest?.version} is available.`
        : status === 'current'
          ? 'You are on the latest published installer.'
          : status === 'ahead'
            ? 'This build is newer than the installer on tecadrise.ai.'
            : 'Could not check for updates.';

  return (
    <section>
      <h2>Updates</h2>
      <p className="lede">TecAdRiseBot {localVersion || 'unknown'}</p>
      <div className={`update-card update-${status}`}>
        <p className="update-headline">{headline}</p>
        {latest ? (
          <>
            <p className="hint">
              Published {latest.version}
              {latest.gitTag ? ` (${latest.gitTag})` : ''}
              {latest.releasedAt ? ` · ${latest.releasedAt.slice(0, 10)}` : ''}
            </p>
            {latest.sha256 ? <p className="sha-line">SHA-256 {latest.sha256}</p> : null}
          </>
        ) : null}
        {error ? <p className="status error">{error}</p> : null}
        <div className="update-actions">
          {latest?.setupUrl ? (
            <button
              type="button"
              className="primary"
              onClick={() => void window.tecapi.app.openExternal(latest.setupUrl)}
            >
              Download installer
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void window.tecapi.app.openExternal(latest ? githubTreeUrl(latest) : GITHUB_REPO_URL)}
          >
            GitHub at this version
          </button>
          <button type="button" onClick={() => void window.tecapi.app.openExternal(PRODUCT_PAGE_URL)}>
            Product page
          </button>
          <button
            type="button"
            onClick={() => {
              setStatus('loading');
              void window.tecapi.updates.check().then(applyCheck);
            }}
          >
            Check again
          </button>
        </div>
      </div>
      <p className="hint">
        Auto-install inside the app is not wired. Download the Setup exe from tecadrise.ai. The file on the site and
        the git tag on GitHub are published together.
      </p>
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
  );
}

type Props = {
  open: boolean;
  initialTab?: Tab;
  highlightConnector?: string | null;
  onClose: () => void;
  settings: AppSettings | null;
  onRefresh: () => Promise<void>;
};

export function SettingsModal({ open, initialTab, highlightConnector, onClose, settings, onRefresh }: Props) {
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

  useEffect(() => {
    if (!open) return;
    setTab(initialTab || 'general');
  }, [open, initialTab]);

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
      setStatus('MEMORY.md saved. Next agent turn inlines this file.');
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
                ['byok', 'BYOK'],
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
            {tab === 'byok' && <ByokBody />}

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
                  One file for all agents: MEMORY.md in the app root. Inlined every turn. This is
                  how agents use shared vs private memory. The store is the Memory directory under
                  Computer (App data\memory); the prompt also has that path.
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

            {tab === 'connectors' && <ConnectorsBody highlightId={highlightConnector} />}

            {tab === 'mcp' && (
              <section>
                <h2>Common MCP</h2>
                <p className="hint">
                  Catalog for every agent. Connected apps and these servers attach for every agent.
                  Agent MCP JSON is extra for that agent. Same name: agent JSON wins.
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
                  <span className="hint">Shared by all agents. Path is in the prompt. How to use it is MEMORY.md.</span>
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

            {tab === 'updates' && <UpdatesBody localVersion={settings?.version ?? ''} />}
          </div>
        </div>
      </div>
    </ModalBackdrop>
  );
}
