import { useEffect, useMemo, useState } from 'react';
import type { Agent, AppSettings } from '../types';

type Props = {
  agents: Agent[];
  selectedId: string | null;
  runningIds: Set<string>;
  scheduledIds: Set<string>;
  settings: AppSettings | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onOpenSettings: () => void;
  onOpenAgentSettings: (id: string) => void;
  onDeleteAgent: (id: string) => void;
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase() || 'A';
}

export function Sidebar({
  agents,
  selectedId,
  runningIds,
  scheduledIds,
  settings,
  onSelect,
  onCreate,
  onOpenSettings,
  onOpenAgentSettings,
  onDeleteAgent,
}: Props) {
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.lastSnippet ?? '').toLowerCase().includes(q)
    );
  }, [agents, query]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="search-wrap">
          <svg className="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
            <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input
            className="search-input"
            placeholder="Search agents"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button className="icon-btn" title="New agent" onClick={onCreate} type="button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="agent-list">
        {filtered.map((a) => {
          const running = runningIds.has(a.id);
          const scheduled = scheduledIds.has(a.id);
          const led = running ? 'running' : scheduled ? 'scheduled' : 'idle';
          const ledTitle = running
            ? 'Running'
            : scheduled
              ? 'Scheduled (routine on)'
              : 'Idle';
          return (
          <button
            key={a.id}
            type="button"
            className={`agent-row ${selectedId === a.id ? 'active' : ''}`}
            onClick={() => onSelect(a.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ id: a.id, x: e.clientX, y: e.clientY });
            }}
          >
            <div className="avatar" style={{ background: a.color }}>
              {initials(a.name)}
            </div>
            <div className="agent-meta">
              <div className="agent-name">{a.name}</div>
              <div className="agent-snippet">{a.lastSnippet || 'No messages yet'}</div>
            </div>
            <span className={`agent-led ${led}`} title={ledTitle} />
          </button>
          );
        })}
        {filtered.length === 0 && <div className="empty-hint">No agents match</div>}
      </div>
      {menu ? (
        <div
          className="agent-ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              onOpenAgentSettings(menu.id);
              setMenu(null);
            }}
          >
            Settings
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              onDeleteAgent(menu.id);
              setMenu(null);
            }}
          >
            Delete
          </button>
        </div>
      ) : null}

      <div className="sidebar-footer">
        <div className="marketplace-stub">Marketplace</div>
        <button type="button" className="account-row" onClick={onOpenSettings}>
          <div className="avatar small" style={{ background: '#4C78FF' }}>
            {(settings?.accountName || 'U').slice(0, 1).toUpperCase()}
          </div>
          <div className="account-meta">
            <div className="account-name">{settings?.accountName || 'Local user'}</div>
            <div className="account-sub">
              {settings?.hasApiKey ? 'API key saved' : 'Set API key'}
            </div>
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="gear">
            <path
              d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <path
              d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.3.6.9 1 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"
              stroke="currentColor"
              strokeWidth="1.5"
            />
          </svg>
        </button>
      </div>
    </aside>
  );
}
