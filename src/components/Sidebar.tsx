import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, AppSettings } from '../types';
import {
  HIDDEN_SECTION_ID,
  createSection,
  deleteSection,
  groupedAgents,
  insertLane,
  moveAgentToSection,
  renameSection,
  sectionOf,
  toggleCollapsed,
  visualOrder,
  type SidebarLayout,
} from '../lib/sidebarSections';

type Props = {
  agents: Agent[];
  selectedId: string | null;
  runningIds: Set<string>;
  scheduledIds: Set<string>;
  settings: AppSettings | null;
  layout: SidebarLayout;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onOpenSettings: () => void;
  onOpenConnectors: () => void;
  onOpenAgentSettings: (id: string) => void;
  onDeleteAgent: (id: string) => void;
  onRenameAgent: (id: string, name: string) => void;
  onReorder: (ids: string[]) => void;
  onLayout: (next: SidebarLayout) => void;
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase() || 'A';
}

type Menu =
  | { kind: 'agent'; id: string; x: number; y: number }
  | { kind: 'section'; id: string; x: number; y: number };

export function Sidebar({
  agents,
  selectedId,
  runningIds,
  scheduledIds,
  settings,
  layout,
  onSelect,
  onCreate,
  onOpenSettings,
  onOpenConnectors,
  onOpenAgentSettings,
  onDeleteAgent,
  onRenameAgent,
  onReorder,
  onLayout,
}: Props) {
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<Menu | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [dragging, setDragging] = useState<{ kind: 'agent' | 'section'; id: string } | null>(null);
  const [over, setOver] = useState<{ kind: 'agent' | 'section'; id: string } | null>(null);
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [editingAgent, setEditingAgent] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const skipClick = useRef(false);
  const press = useRef<{ x: number; y: number } | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.lastSnippet ?? '').toLowerCase().includes(q)
    );
  }, [agents, query]);

  const groups = useMemo(() => groupedAgents(filtered, layout), [filtered, layout]);
  const canDrag = query.trim().length === 0;
  const searching = query.trim().length > 0;
  const collapsed = useMemo(() => new Set(layout.collapsed), [layout.collapsed]);

  function bumpClickGuard() {
    skipClick.current = true;
    setTimeout(() => {
      skipClick.current = false;
    }, 250);
  }

  function commit(nextLayout: SidebarLayout, nextAgents = agents) {
    onLayout(nextLayout);
    onReorder(visualOrder(nextAgents, nextLayout));
  }

  const agentIds = () => agents.map((a) => a.id);

  function moveAgent(fromId: string, toAgentId: string | null, toSectionId: string | null) {
    if (!canDrag) return;
    let nextLayout = moveAgentToSection(layout, fromId, toSectionId, agentIds());
    if (!toSectionId) {
      nextLayout = insertLane(nextLayout, fromId, toAgentId);
    }
    const order = visualOrder(agents, nextLayout);
    const from = order.indexOf(fromId);
    if (from >= 0) {
      order.splice(from, 1);
      if (toAgentId) {
        const to = order.indexOf(toAgentId);
        order.splice(to < 0 ? order.length : to, 0, fromId);
      } else {
        const idsInSection = agents
          .filter((a) => a.id !== fromId && sectionOf(nextLayout, a.id) === toSectionId)
          .map((a) => a.id);
        const last = idsInSection[idsInSection.length - 1];
        const at = last ? order.indexOf(last) + 1 : order.length;
        order.splice(at, 0, fromId);
      }
    }
    bumpClickGuard();
    onLayout(nextLayout);
    onReorder(order);
  }

  function dropOnAgent(fromKind: string, fromId: string, toAgent: Agent) {
    if (fromKind === 'section') {
      if (fromId === HIDDEN_SECTION_ID) return;
      const dest = sectionOf(layout, toAgent.id);
      const before = !dest ? toAgent.id : dest === HIDDEN_SECTION_ID ? null : dest;
      bumpClickGuard();
      commit(insertLane(layout, fromId, before));
      return;
    }
    const dest = sectionOf(layout, toAgent.id);
    moveAgent(fromId, toAgent.id, dest);
  }

  function dropOnSection(fromKind: string, fromId: string, sectionId: string | null, beforeId?: string | null) {
    if (fromKind === 'section') {
      if (fromId === HIDDEN_SECTION_ID || sectionId === HIDDEN_SECTION_ID) return;
      bumpClickGuard();
      commit(insertLane(layout, fromId, sectionId ?? beforeId ?? null));
      return;
    }
    moveAgent(fromId, null, sectionId);
  }

  function parseDrag(e: React.DragEvent): { kind: 'agent' | 'section'; id: string } | null {
    const raw = e.dataTransfer.getData('text/plain') || (dragging ? `${dragging.kind}:${dragging.id}` : '');
    const m = /^(agent|section):(.+)$/.exec(raw);
    if (!m) return dragging;
    return { kind: m[1] as 'agent' | 'section', id: m[2] };
  }

  function finishSectionEdit() {
    if (!editingSection) return;
    const name = editValue.trim();
    if (name) onLayout(renameSection(layout, editingSection, name));
    setEditingSection(null);
  }

  function finishAgentEdit() {
    if (!editingAgent) return;
    const name = editValue.trim();
    if (name) onRenameAgent(editingAgent, name);
    setEditingAgent(null);
  }

  useEffect(() => {
    if (!menu) return;
    const close = () => {
      setMenu(null);
      setMoveOpen(false);
    };
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

  const agentMenu = menu?.kind === 'agent' ? agents.find((a) => a.id === menu.id) : null;
  const agentSection = agentMenu ? sectionOf(layout, agentMenu.id) : null;

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
        {groups.map((g) => {
          const isCollapsed = Boolean(g.id && collapsed.has(g.id) && !searching);
          return (
          <div
            key={g.key}
            className="sidebar-section"
            onDragOver={(e) => {
              if (!canDrag) return;
              e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              const from = parseDrag(e);
              if (from) dropOnSection(from.kind, from.id, g.id, g.agents[0]?.id ?? null);
              setDragging(null);
              setOver(null);
            }}
          >
            {g.name ? (
              <div
                className={`section-head${isCollapsed ? ' collapsed' : ''}${g.hidden ? ' locked' : ''}${dragging?.kind === 'section' && dragging.id === g.id ? ' dragging' : ''}${over?.kind === 'section' && over.id === (g.id ?? 'unassigned') && dragging?.id !== g.id ? ' drag-over' : ''}`}
                draggable={canDrag && !g.hidden && Boolean(g.id) && editingSection !== g.id}
                onMouseDown={(e) => {
                  press.current = { x: e.clientX, y: e.clientY };
                }}
                onClick={(e) => {
                  if (!g.id || editingSection === g.id) return;
                  const p = press.current;
                  press.current = null;
                  if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) return;
                  if (skipClick.current) return;
                  if ((e.target as HTMLElement).closest('.section-rename')) return;
                  onLayout(toggleCollapsed(layout, g.id));
                }}
                onDragStart={(e) => {
                  if (!g.id || g.hidden || !canDrag) {
                    e.preventDefault();
                    return;
                  }
                  e.dataTransfer.setData('text/plain', `section:${g.id}`);
                  e.dataTransfer.effectAllowed = 'move';
                  bumpClickGuard();
                  setDragging({ kind: 'section', id: g.id });
                }}
                onDragOver={(e) => {
                  if (!canDrag) return;
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = 'move';
                  const oid = g.id ?? 'unassigned';
                  if (over?.kind !== 'section' || over.id !== oid) setOver({ kind: 'section', id: oid });
                }}
                onDragLeave={() => {
                  const oid = g.id ?? 'unassigned';
                  if (over?.kind === 'section' && over.id === oid) setOver(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const from = parseDrag(e);
                  if (from) dropOnSection(from.kind, from.id, g.id, g.agents[0]?.id ?? null);
                  setDragging(null);
                  setOver(null);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                onContextMenu={(e) => {
                  if (!g.id || g.hidden) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setMoveOpen(false);
                  setMenu({ kind: 'section', id: g.id, x: e.clientX, y: e.clientY });
                }}
              >
                {editingSection === g.id ? (
                  <input
                    className="section-rename"
                    value={editValue}
                    autoFocus
                    draggable={false}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={finishSectionEdit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') finishSectionEdit();
                      if (e.key === 'Escape') setEditingSection(null);
                    }}
                  />
                ) : (
                  <span className="section-head-name">{g.name}</span>
                )}
                {isCollapsed ? (
                  <span className="section-head-leds">
                    {g.agents.map((a) => {
                      const running = runningIds.has(a.id);
                      const scheduled = scheduledIds.has(a.id);
                      const led = running ? 'running' : scheduled ? 'scheduled' : 'idle';
                      const ledTitle = running ? 'Running' : scheduled ? 'Scheduled (routine on)' : 'Idle';
                      return <span key={a.id} className={`agent-led ${led}`} title={ledTitle} />;
                    })}
                  </span>
                ) : null}
                <span
                  className="section-chevron"
                  title={isCollapsed ? 'Expand' : 'Collapse'}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (g.id) onLayout(toggleCollapsed(layout, g.id));
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              </div>
            ) : null}
            {isCollapsed
              ? null
              : g.agents.map((a) => {
              const running = runningIds.has(a.id);
              const scheduled = scheduledIds.has(a.id);
              const led = running ? 'running' : scheduled ? 'scheduled' : 'idle';
              const ledTitle = running ? 'Running' : scheduled ? 'Scheduled (routine on)' : 'Idle';
              return (
                <button
                  key={a.id}
                  type="button"
                  className={`agent-row ${selectedId === a.id ? 'active' : ''}${dragging?.kind === 'agent' && dragging.id === a.id ? ' dragging' : ''}${over?.kind === 'agent' && over.id === a.id && dragging?.id !== a.id ? ' drag-over' : ''}`}
                  draggable={canDrag && editingAgent !== a.id}
                  onClick={() => {
                    if (skipClick.current) {
                      skipClick.current = false;
                      return;
                    }
                    onSelect(a.id);
                  }}
                  onDragStart={(e) => {
                    if (!canDrag) {
                      e.preventDefault();
                      return;
                    }
                    e.dataTransfer.setData('text/plain', `agent:${a.id}`);
                    e.dataTransfer.effectAllowed = 'move';
                    setDragging({ kind: 'agent', id: a.id });
                  }}
                  onDragOver={(e) => {
                    if (!canDrag) return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = 'move';
                    if (over?.kind !== 'agent' || over.id !== a.id) setOver({ kind: 'agent', id: a.id });
                  }}
                  onDragLeave={() => {
                    if (over?.kind === 'agent' && over.id === a.id) setOver(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const from = parseDrag(e);
                    if (from) dropOnAgent(from.kind, from.id, a);
                    setDragging(null);
                    setOver(null);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMoveOpen(false);
                    setMenu({ kind: 'agent', id: a.id, x: e.clientX, y: e.clientY });
                  }}
                >
                  <div className="avatar" style={{ background: a.color }}>
                    {initials(a.name)}
                  </div>
                  <div className="agent-meta">
                    {editingAgent === a.id ? (
                      <input
                        className="agent-rename"
                        value={editValue}
                        autoFocus
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={finishAgentEdit}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') finishAgentEdit();
                          if (e.key === 'Escape') setEditingAgent(null);
                        }}
                      />
                    ) : (
                      <div className="agent-name">{a.name}</div>
                    )}
                    <div className="agent-snippet">{a.lastSnippet || 'No messages yet'}</div>
                  </div>
                  <span className={`agent-led ${led}`} title={ledTitle} />
                </button>
              );
            })}
          </div>
          );
        })}
        {filtered.length === 0 && <div className="empty-hint">No agents match</div>}
      </div>
      {menu && agentMenu ? (
        <div
          className="agent-ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="has-sub"
              onMouseEnter={() => setMoveOpen(true)}
              onClick={() => setMoveOpen(true)}
            >
              Move to
              <svg className="sub-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {moveOpen ? (
              <div className="agent-ctx-submenu" onMouseEnter={() => setMoveOpen(true)}>
                <button
                  type="button"
                  onClick={() => {
                    commit(moveAgentToSection(layout, agentMenu.id, null, agentIds()));
                    setMenu(null);
                  }}
                >
                    {agentSection == null ? '· ' : ''}Unassigned
                </button>
                {layout.sections.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      commit(moveAgentToSection(layout, agentMenu.id, s.id, agentIds()));
                      setMenu(null);
                    }}
                  >
                    {agentSection === s.id ? '· ' : ''}{s.name}
                  </button>
                ))}
                <div className="agent-ctx-sep" />
                <button
                  type="button"
                  onClick={() => {
                    const id = crypto.randomUUID();
                    commit(createSection(layout, 'New section', id, agentMenu.id));
                    setMenu(null);
                    setMoveOpen(false);
                    setEditValue('New section');
                    setEditingSection(id);
                  }}
                >
                  Create section
                </button>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => {
              setEditValue(agentMenu.name);
              setEditingAgent(agentMenu.id);
              setMenu(null);
            }}
          >
            Rename
          </button>
          <button
            type="button"
            onClick={() => {
              onOpenAgentSettings(agentMenu.id);
              setMenu(null);
            }}
          >
            Settings
          </button>
          <button
            type="button"
            onClick={() => {
              commit(
                moveAgentToSection(
                  layout,
                  agentMenu.id,
                  agentSection === HIDDEN_SECTION_ID ? null : HIDDEN_SECTION_ID,
                  agentIds()
                )
              );
              setMenu(null);
            }}
          >
            {agentSection === HIDDEN_SECTION_ID ? 'Unhide' : 'Hide from sidebar'}
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              onDeleteAgent(agentMenu.id);
              setMenu(null);
            }}
          >
            Delete
          </button>
        </div>
      ) : null}
      {menu?.kind === 'section' ? (
        <div
          className="agent-ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              const cur = layout.sections.find((s) => s.id === menu.id);
              setEditValue(cur?.name || '');
              setEditingSection(menu.id);
              setMenu(null);
            }}
          >
            Rename section
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              commit(deleteSection(layout, menu.id, agentIds()));
              setMenu(null);
            }}
          >
            Delete section
          </button>
        </div>
      ) : null}

      <div className="sidebar-footer">
        <div className="account-row">
          <button type="button" className="account-identity" onClick={onOpenSettings}>
            <div className="avatar small" style={{ background: '#4C78FF' }}>
              {(settings?.accountName || 'U').slice(0, 1).toUpperCase()}
            </div>
            <div className="account-meta">
              <div className="account-name">{settings?.accountName || 'Local user'}</div>
              <div className="account-sub">
                {settings?.hasApiKey ? 'API key saved' : 'Set API key'}
              </div>
            </div>
          </button>
          <button
            type="button"
            className="account-icon-btn"
            title="Connectors"
            aria-label="Connectors"
            onClick={onOpenConnectors}
          >
            <svg width="17" height="17" viewBox="5 2 14 20" fill="none" className="account-plug">
              <path
                d="M9 7V3M15 7V3"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <path
                d="M7 7h10v4a5 5 0 0 1-5 5h0a5 5 0 0 1-5-5V7z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
              <path d="M12 16v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className="account-icon-btn"
            title="Settings"
            aria-label="Settings"
            onClick={onOpenSettings}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="gear">
              <path
                d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
                stroke="currentColor"
                strokeWidth="1.8"
              />
              <path
                d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1-.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.3.6.9 1 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          </button>
        </div>
      </div>
    </aside>
  );
}
