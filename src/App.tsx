import { useCallback, useEffect, useRef, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { SettingsModal } from './components/SettingsModal';
import { AgentSettingsModal } from './components/AgentSettingsModal';
import type { Agent, AppSettings, ChatMessage } from './types';
import './styles/app.css';

function mergeMeta(meta: string | null, usage: unknown): string {
  let cur: Record<string, unknown> = {};
  if (meta) {
    try {
      const parsed = JSON.parse(meta);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        cur = parsed as Record<string, unknown>;
      }
    } catch {
      /* ignore */
    }
  }
  return JSON.stringify({ ...cur, usage });
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [runningIds, setRunningIds] = useState<Set<string>>(() => new Set());
  const [scheduledIds, setScheduledIds] = useState<Set<string>>(() => new Set());
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false);
  const liveRuns = useRef(new Set<string>());

  const refreshSettings = useCallback(async () => {
    const s = await window.tecapi.settings.get();
    setSettings(s);
  }, []);

  const refreshLeds = useCallback(async () => {
    const [busy, routines] = await Promise.all([
      window.tecapi.agents.busy(),
      window.tecapi.routines.list(),
    ]);
    setRunningIds(new Set([...busy, ...liveRuns.current]));
    setScheduledIds(
      new Set(routines.filter((r) => Number(r.enabled) !== 0).map((r) => r.agentId))
    );
  }, []);

  const refreshAgents = useCallback(async () => {
    const list = await window.tecapi.agents.list();
    setAgents(list);
    setSelectedId((cur) => cur ?? list[0]?.id ?? null);
    void refreshLeds();
  }, [refreshLeds]);

  const loadMessages = useCallback(async (agentId: string) => {
    const list = await window.tecapi.messages.list(agentId);
    setMessages(list);
  }, []);

  useEffect(() => {
    void refreshAgents();
    void refreshSettings();
    const tick = window.setInterval(() => {
      void refreshLeds();
    }, 2000);
    return () => window.clearInterval(tick);
  }, [refreshAgents, refreshSettings, refreshLeds]);

  useEffect(() => {
    if (selectedId) void loadMessages(selectedId);
    else setMessages([]);
  }, [selectedId, loadMessages]);

  useEffect(() => {
    const offs = [
      window.tecapi.on('chat:message', (payload) => {
        const p = payload as { agentId: string; message: ChatMessage };
        if (p.agentId === selectedId) {
          setMessages((prev) => {
            if (prev.some((m) => m.id === p.message.id)) return prev;
            const cleaned = prev.filter(
              (m) =>
                !(m.id.startsWith('tmp-') && m.role === p.message.role && m.content === p.message.content)
            );
            return [...cleaned, p.message];
          });
        }
        void refreshAgents();
      }),
      window.tecapi.on('chat:stream-start', (payload) => {
        const p = payload as { agentId: string; messageId: string };
        liveRuns.current.add(p.agentId);
        setRunningIds((prev) => new Set(prev).add(p.agentId));
        if (p.agentId !== selectedId) return;
        setStreamingId(p.messageId);
        setMessages((prev) =>
          prev.some((m) => m.id === p.messageId)
            ? prev
            : [
                ...prev,
                {
                  id: p.messageId,
                  agentId: p.agentId,
                  role: 'assistant',
                  content: '',
                  meta: null,
                  createdAt: Date.now(),
                },
              ]
        );
      }),
      window.tecapi.on('chat:stream-delta', (payload) => {
        const p = payload as { agentId: string; messageId: string; content: string };
        if (p.agentId !== selectedId) return;
        setMessages((prev) =>
          prev.map((m) => (m.id === p.messageId ? { ...m, content: p.content } : m))
        );
      }),
      window.tecapi.on('chat:stream-done', (payload) => {
        const p = payload as {
          agentId: string;
          messageId: string;
          content: string;
          usage?: unknown;
        };
        if (p.agentId === selectedId) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === p.messageId
                ? {
                    ...m,
                    content: p.content,
                    meta: p.usage ? mergeMeta(m.meta, p.usage) : m.meta,
                  }
                : m
            )
          );
          setStreamingId(null);
        }
        liveRuns.current.delete(p.agentId);
        setRunningIds((prev) => {
          const next = new Set(prev);
          next.delete(p.agentId);
          return next;
        });
        void refreshAgents();
      }),
      window.tecapi.on('routines:fired', () => {
        void refreshAgents();
        if (selectedId && !liveRuns.current.has(selectedId)) void loadMessages(selectedId);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [selectedId, refreshAgents, loadMessages]);

  const selected = agents.find((a) => a.id === selectedId) ?? null;

  async function createAgent() {
    const name = `Agent ${agents.length + 1}`;
    const model = settings?.selectedModel;
    const a = await window.tecapi.agents.create(name, model);
    // Apply default model onto agent row
    if (model) await window.tecapi.agents.update(a.id, { model });
    await refreshAgents();
    setSelectedId(a.id);
  }

  async function send(text: string, attachments: Array<{ name: string; mimeType: string; dataBase64: string }> = []) {
    if (!selectedId) return;
    await window.tecapi.chat.send(
      selectedId,
      text,
      attachments.map(({ name, mimeType, dataBase64 }) => ({ name, mimeType, dataBase64 }))
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        agents={agents}
        selectedId={selectedId}
        runningIds={runningIds}
        scheduledIds={scheduledIds}
        settings={settings}
        onSelect={setSelectedId}
        onCreate={() => void createAgent()}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenAgentSettings={(id) => {
          setSelectedId(id);
          setAgentSettingsOpen(true);
        }}
        onDeleteAgent={(id) => {
          void (async () => {
            const target = agents.find((a) => a.id === id);
            const ok = window.confirm(`Delete ${target?.name || 'this agent'}? This cannot be undone.`);
            if (!ok) return;
            await window.tecapi.agents.delete(id);
            const list = await window.tecapi.agents.list();
            setAgents(list);
            setSelectedId((cur) => {
              if (cur !== id) return cur;
              return list[0]?.id ?? null;
            });
            void refreshLeds();
          })();
        }}
        onReorder={(ids) => {
          setAgents((cur) => {
            const byId = new Map(cur.map((a) => [a.id, a]));
            return ids.map((id) => byId.get(id)).filter((a): a is Agent => Boolean(a));
          });
          void window.tecapi.agents.reorder(ids).then((list) => setAgents(list)).catch(() => {
            void refreshAgents();
          });
        }}
      />
      <ChatView
        agent={selected}
        messages={messages}
        streamingId={streamingId}
        onSend={send}
        onStop={() => {
          if (selectedId) void window.tecapi.chat.stop(selectedId);
        }}
        onOpenAgentSettings={() => setAgentSettingsOpen(true)}
      />
      <AgentSettingsModal
        open={agentSettingsOpen}
        agent={selected}
        onClose={() => setAgentSettingsOpen(false)}
        onSaved={() => {
          void refreshAgents();
          void refreshLeds();
          setStreamingId(null);
          if (selectedId) void loadMessages(selectedId);
        }}
      />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onRefresh={refreshSettings}
      />
    </div>
  );
}
