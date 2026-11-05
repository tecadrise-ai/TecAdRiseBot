import { useCallback, useEffect, useRef, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { SettingsModal } from './components/SettingsModal';
import { AgentSettingsModal } from './components/AgentSettingsModal';
import type { Agent, AppSettings, ChatMessage, WorkflowRunView } from './types';
import type { TodoItem } from './lib/todos';
import { emptyLayout, normalizeLayout, type SidebarLayout } from './lib/sidebarSections';
import './styles/app.css';

function mergeMeta(meta: string | null, patch: Record<string, unknown>): string {
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
  return JSON.stringify({ ...cur, ...patch });
}

function sameIdSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function ownerAgentIdOf(agent: Agent | null | undefined): string {
  const id = agent?.config?.workflowOwnerAgentId;
  return typeof id === 'string' ? id : '';
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [runningIds, setRunningIds] = useState<Set<string>>(() => new Set());
  const [scheduledIds, setScheduledIds] = useState<Set<string>>(() => new Set());
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [sidebarLayout, setSidebarLayout] = useState<SidebarLayout>(() => emptyLayout());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'general' | 'connectors'>('general');
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false);
  const [liveTodos, setLiveTodos] = useState<TodoItem[]>([]);
  const [liveTodoMessageId, setLiveTodoMessageId] = useState<string | null>(null);
  const [wfRuns, setWfRuns] = useState<Record<string, WorkflowRunView>>({});
  const wfRequested = useRef(new Set<string>());
  const liveRuns = useRef(new Set<string>());
  const selectedIdRef = useRef<string | null>(null);
  const messagesCache = useRef(new Map<string, ChatMessage[]>());
  const loadGen = useRef(0);
  selectedIdRef.current = selectedId;

  // Background refreshes run from timers and events; a failed IPC call must not surface as an unhandled rejection.
  const refreshSettings = useCallback(async () => {
    try {
      const s = await window.tecapi.settings.get();
      setSettings(s);
    } catch (e) {
      console.error('refreshSettings', e);
    }
  }, []);

  const refreshLeds = useCallback(async () => {
    try {
      const [busy, routines] = await Promise.all([
        window.tecapi.agents.busy(),
        window.tecapi.routines.list(),
      ]);
      const busySet = new Set(busy);
      for (const id of [...liveRuns.current]) {
        if (!busySet.has(id)) liveRuns.current.delete(id);
      }
      setRunningIds((prev) => (sameIdSet(prev, busySet) ? prev : busySet));
      const scheduled = new Set(routines.filter((r) => Number(r.enabled) !== 0).map((r) => r.agentId));
      setScheduledIds((prev) => (sameIdSet(prev, scheduled) ? prev : scheduled));
    } catch (e) {
      console.error('refreshLeds', e);
    }
  }, []);

  const refreshAgents = useCallback(async () => {
    try {
      const [list, raw] = await Promise.all([window.tecapi.agents.list(), window.tecapi.sidebar.get()]);
      setAgents(list);
      try {
        setSidebarLayout(normalizeLayout(JSON.parse(raw), list.map((a) => a.id)));
      } catch {
        setSidebarLayout(emptyLayout());
      }
      setSelectedId((cur) => cur ?? list[0]?.id ?? null);
    } catch (e) {
      console.error('refreshAgents', e);
    }
    void refreshLeds();
  }, [refreshLeds]);

  const loadMessages = useCallback(async (agentId: string) => {
    const gen = ++loadGen.current;
    try {
      const list = await window.tecapi.messages.list(agentId);
      if (gen !== loadGen.current || selectedIdRef.current !== agentId) return;
      messagesCache.current.set(agentId, list);
      setMessages(list);
    } catch (e) {
      console.error('loadMessages', e);
    }
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
    if (!selectedId) {
      setMessages([]);
      setStreamingId(null);
      setLiveTodos([]);
      setLiveTodoMessageId(null);
      return;
    }
    setMessages(messagesCache.current.get(selectedId) ?? []);
    setLiveTodos([]);
    setLiveTodoMessageId(null);
    void loadMessages(selectedId);
  }, [selectedId, loadMessages]);

  useEffect(() => {
    if (!selectedId) return;
    if (!runningIds.has(selectedId)) {
      setStreamingId(null);
      return;
    }
    setStreamingId((cur) => {
      if (cur && messages.some((m) => m.id === cur && m.agentId === selectedId)) return cur;
      const lastAsst = [...messages].filter((m) => m.role === 'assistant' && m.agentId === selectedId).pop();
      return lastAsst?.id ?? `__run__${selectedId}`;
    });
  }, [selectedId, runningIds, messages]);

  useEffect(() => {
    const offs = [
      window.tecapi.on('chat:message', (payload) => {
        const p = payload as { agentId: string; message: ChatMessage };
        if (p.agentId === selectedIdRef.current && p.message) {
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
        const p = payload as { agentId: string; messageId: string; meta?: string | null };
        liveRuns.current.add(p.agentId);
        setRunningIds((prev) => new Set(prev).add(p.agentId));
        if (p.agentId !== selectedIdRef.current) return;
        setLiveTodos([]);
        setLiveTodoMessageId(p.messageId);
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
                  meta: p.meta ?? null,
                  createdAt: Date.now(),
                },
              ]
        );
      }),
      window.tecapi.on('chat:stream-delta', (payload) => {
        const p = payload as { agentId: string; messageId: string; content: string };
        if (p.agentId !== selectedIdRef.current) return;
        setMessages((prev) =>
          prev.map((m) => (m.id === p.messageId ? { ...m, content: p.content } : m))
        );
      }),
      window.tecapi.on('chat:todos', (payload) => {
        const p = payload as { agentId: string; messageId: string; todos: TodoItem[] };
        if (p.agentId !== selectedIdRef.current) return;
        setLiveTodoMessageId(p.messageId);
        setLiveTodos(Array.isArray(p.todos) ? p.todos : []);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === p.messageId
              ? { ...m, meta: mergeMeta(m.meta, { todos: p.todos }) }
              : m
          )
        );
      }),
      window.tecapi.on('chat:stream-done', (payload) => {
        const p = payload as {
          agentId: string;
          messageId: string;
          content: string;
          usage?: unknown;
          todos?: TodoItem[];
          finishedAt?: number;
        };
        if (p.agentId === selectedIdRef.current) {
          const extra: Record<string, unknown> = {};
          if (p.usage) extra.usage = p.usage;
          if (p.finishedAt) extra.finishedAt = p.finishedAt;
          if (p.todos && p.todos.length) extra.todos = p.todos;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === p.messageId
                ? {
                    ...m,
                    content: p.content,
                    meta: Object.keys(extra).length ? mergeMeta(m.meta, extra) : m.meta,
                  }
                : m
            )
          );
          if (p.todos && p.todos.length) setLiveTodos(p.todos);
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
        const id = selectedIdRef.current;
        if (id && !liveRuns.current.has(id)) void loadMessages(id);
      }),
      window.tecapi.on('workflow:run', (payload) => {
        const run = payload as WorkflowRunView;
        if (run?.id) setWfRuns((prev) => ({ ...prev, [run.id]: run }));
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [refreshAgents, loadMessages]);

  const selected = agents.find((a) => a.id === selectedId) ?? null;

  async function createAgent() {
    const name = `Agent ${agents.length + 1}`;
    const model = settings?.selectedModel;
    try {
      const a = await window.tecapi.agents.create(name, model);
      // Apply default model onto agent row
      if (model) await window.tecapi.agents.update(a.id, { model });
      await refreshAgents();
      setSelectedId(a.id);
    } catch (e) {
      window.alert(`Could not create agent: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const send = useCallback(async (
    text: string,
    attachments: Array<{ name: string; mimeType: string; dataBase64: string }> = [],
    role: 'runner' | 'owner' = 'runner'
  ) => {
    if (!selectedId) return;
    const files = attachments.map(({ name, mimeType, dataBase64 }) => ({ name, mimeType, dataBase64 }));
    if (role === 'owner') {
      const runner = agents.find((a) => a.id === selectedId);
      const ownerId = ownerAgentIdOf(runner);
      if (!runner) return;
      if (!ownerId) {
        await window.tecapi.chat.send(runner.id, text, files, { ownerOfRunnerId: runner.id });
        return;
      }
      await window.tecapi.chat.send(
        ownerId,
        `[Message from the chat of runner agent ${runner.name}]\n\n${text}`,
        files,
        { ownerOfRunnerId: runner.id }
      );
      return;
    }
    await window.tecapi.chat.send(selectedId, text, files);
  }, [selectedId, agents]);

  const renameSelected = useCallback(async (name: string) => {
    if (!selectedId) return;
    await window.tecapi.agents.update(selectedId, { name });
    await refreshAgents();
  }, [selectedId, refreshAgents]);

  const stop = useCallback(async () => {
    if (!selectedId) return;
    liveRuns.current.delete(selectedId);
    setRunningIds((prev) => {
      if (!prev.has(selectedId)) return prev;
      const next = new Set(prev);
      next.delete(selectedId);
      return next;
    });
    setStreamingId(null);
    await window.tecapi.chat.stop(selectedId);
  }, [selectedId]);

  const [agentSettingsTab, setAgentSettingsTab] = useState<'general' | 'routines' | 'workflows' | 'mcp'>('general');
  const openAgentSettings = useCallback((tab: 'general' | 'routines' | 'workflows' | 'mcp' = 'general') => {
    setAgentSettingsTab(tab);
    setAgentSettingsOpen(true);
  }, []);

  const needWorkflowRun = useCallback((runId: string) => {
    if (wfRequested.current.has(runId)) return;
    wfRequested.current.add(runId);
    void window.tecapi.workflows
      .getRun(runId)
      .then((run) => {
        if (run) setWfRuns((prev) => (prev[run.id] ? prev : { ...prev, [run.id]: run }));
      })
      .catch(() => wfRequested.current.delete(runId));
  }, []);

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
        onOpenSettings={() => {
          setSettingsTab('general');
          setSettingsOpen(true);
        }}
        onOpenConnectors={() => {
          setSettingsTab('connectors');
          setSettingsOpen(true);
        }}
        onOpenAgentSettings={(id) => {
          setSelectedId(id);
          setAgentSettingsOpen(true);
        }}
        layout={sidebarLayout}
        onRenameAgent={(id, name) => {
          void (async () => {
            await window.tecapi.agents.update(id, { name });
            await refreshAgents();
          })();
        }}
        onLayout={(next) => {
          setSidebarLayout(next);
          void window.tecapi.sidebar.save(JSON.stringify(next)).catch(() => {
            void refreshAgents();
          });
        }}
        onDeleteAgent={(id) => {
          void (async () => {
            const target = agents.find((a) => a.id === id);
            const ok = window.confirm(`Delete ${target?.name || 'this agent'}? This cannot be undone.`);
            if (!ok) return;
            try {
              await window.tecapi.agents.delete(id);
            } catch (e) {
              window.alert(`Could not delete agent: ${e instanceof Error ? e.message : String(e)}`);
              return;
            }
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
        key={selected?.id ?? 'none'}
        agent={selected}
        messages={messages}
        streamingId={streamingId}
        liveTodos={liveTodos}
        liveTodoMessageId={liveTodoMessageId}
        agentRunning={Boolean(selectedId && runningIds.has(selectedId))}
        workflowRuns={wfRuns}
        onNeedWorkflowRun={needWorkflowRun}
        onSend={send}
        onStop={stop}
        onOpenAgentSettings={openAgentSettings}
        onRename={renameSelected}
        ownerAgent={agents.find((a) => a.id === ownerAgentIdOf(selected)) ?? null}
        userDataPath={settings?.userDataPath}
      />
      <AgentSettingsModal
        open={agentSettingsOpen}
        agent={selected}
        initialTab={agentSettingsTab}
        onClose={() => {
          setAgentSettingsOpen(false);
          setAgentSettingsTab('general');
        }}
        onSaved={() => {
          void refreshAgents();
          void refreshLeds();
          if (selectedId) void loadMessages(selectedId);
        }}
        onSessionCleared={(agentId) => {
          messagesCache.current.delete(agentId);
          liveRuns.current.delete(agentId);
          setRunningIds((prev) => {
            if (!prev.has(agentId)) return prev;
            const next = new Set(prev);
            next.delete(agentId);
            return next;
          });
          if (selectedIdRef.current === agentId) setStreamingId(null);
        }}
      />
      <SettingsModal
        open={settingsOpen}
        initialTab={settingsTab}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onRefresh={refreshSettings}
      />
    </div>
  );
}
