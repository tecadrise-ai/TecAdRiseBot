import { memo, useEffect, useRef, useState } from 'react';
import type { Agent, ChatMessage, WorkflowRunView } from '../types';
import { WorkflowCard } from './WorkflowCard';
import { MarkdownBody } from './MarkdownBody';
import { fmtTs, fmtUsage, parseMessageUsage } from '../lib/usage';
import { formatModelLabel } from '../lib/modelOptions';
import { unpackAssistantBody } from '../lib/assistantBody';
import { parseMessageTodos, type TodoItem, type TodoStatus } from '../lib/todos';

export type PendingAttachment = {
  id: string;
  name: string;
  mimeType: string;
  dataBase64: string;
  previewUrl?: string;
};

type Props = {
  agent: Agent | null;
  messages: ChatMessage[];
  streamingId: string | null;
  liveTodos?: TodoItem[];
  liveTodoMessageId?: string | null;
  agentRunning?: boolean;
  workflowRuns?: Record<string, WorkflowRunView>;
  onNeedWorkflowRun?: (runId: string) => void;
  onSend: (text: string, attachments: PendingAttachment[], targetAgentId?: string) => Promise<void>;
  onStop: () => void | Promise<void>;
  onOpenAgentSettings: () => void;
  onRename?: (name: string) => Promise<void>;
};

const TODO_MARK: Record<TodoStatus, string> = {
  pending: '[ ]',
  inProgress: '[~]',
  completed: '[x]',
  cancelled: '[-]',
};

function ThinkingSection({
  text,
  streaming,
  collapse,
}: {
  text: string;
  streaming: boolean;
  collapse: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (streaming) {
    return <div className="md-thinking md-thinking-raw">{text}</div>;
  }
  if (!collapse) {
    return <MarkdownBody className="md-thinking" text={text} />;
  }
  return (
    <div className="think-fold">
      <button
        type="button"
        className="think-fold-btn"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="think-fold-chevron" aria-hidden="true" />
        Thinking
      </button>
      {open ? <MarkdownBody className="md-thinking" text={text} /> : null}
    </div>
  );
}

function workflowRunIdOf(meta: string | null): string | null {
  if (!meta || !meta.includes('"workflow"')) return null;
  try {
    const runId = (JSON.parse(meta) as { workflow?: { runId?: unknown } }).workflow?.runId;
    return typeof runId === 'string' && runId ? runId : null;
  } catch {
    return null;
  }
}

function TodoList({ todos }: { todos: TodoItem[] }) {
  if (!todos.length) return null;
  return (
    <div className="todo-box">
      <div className="todo-head">Task list</div>
      <div className="todo-list">
        {todos.map((t, i) => {
          const st =
            t.status === 'completed'
              ? 'done'
              : t.status === 'inProgress'
                ? 'doing'
                : t.status === 'cancelled'
                  ? 'cancelled'
                  : 'todo';
          return (
            <div key={`${t.id}:${i}`} className={`todo-row ${st}`}>
              <span className="tk">{TODO_MARK[t.status] || '[ ]'}</span>
              <span className="tx">{t.content}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function assistantMetaLine(m: ChatMessage): string {
  const bits: string[] = [];
  if (m.createdAt) bits.push(fmtTs(m.createdAt));
  const u = fmtUsage(parseMessageUsage(m.meta));
  if (u) bits.push(u);
  return bits.join(' · ');
}

function fileToPending(file: File): Promise<PendingAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const dataBase64 = result.includes(',') ? result.split(',')[1]! : result;
      const mimeType = file.type || 'application/octet-stream';
      resolve({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name || 'paste.bin',
        mimeType,
        dataBase64,
        previewUrl: mimeType.startsWith('image/') ? result : undefined,
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function fitComposer(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  const cs = getComputedStyle(el);
  const lh = Number.parseFloat(cs.lineHeight) || 20;
  const pad =
    (Number.parseFloat(cs.paddingTop) || 0) + (Number.parseFloat(cs.paddingBottom) || 0);
  const max = lh * 6 + pad;
  const next = Math.min(el.scrollHeight, max);
  el.style.height = `${next}px`;
}

type ComposerProps = {
  agentId: string;
  agentName: string;
  busy: boolean;
  onSend: (text: string, attachments: PendingAttachment[], targetAgentId?: string) => Promise<void>;
  onStop: () => void | Promise<void>;
};

function EditableName({ name, onRename }: { name: string; onRename?: (name: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);

  async function commit() {
    const next = value.trim();
    if (!next || next === name || !onRename) {
      setValue(name);
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onRename(next);
      setEditing(false);
    } catch (e) {
      window.alert(`Could not rename: ${e instanceof Error ? e.message : String(e)}`);
      setValue(name);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="title-name title-name-btn"
        title="Click to rename"
        onClick={() => {
          setValue(name);
          setEditing(true);
        }}
      >
        {name}
      </button>
    );
  }
  return (
    <input
      className="title-name title-name-input"
      value={value}
      autoFocus
      disabled={saving}
      maxLength={60}
      aria-label="Agent name"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void commit();
        } else if (e.key === 'Escape') {
          setValue(name);
          setEditing(false);
        }
      }}
    />
  );
}

type OwnerTarget = { id: string; name: string };

const SELF_OWNER = 'self';
const SELF_OWNER_PREFIX =
  '[Workflow owner role] Act as the workflow owner: use your workflow tools to create, edit, review or fix workflows.';

/** Owner agents of the workflows this agent runs (routines in Step workflow mode and recent runs). */
async function loadOwnerTargets(agentId: string): Promise<OwnerTarget[]> {
  const [routines, workflows, runs, agents] = await Promise.all([
    window.tecapi.routines.list(),
    window.tecapi.workflows.list(),
    window.tecapi.workflows.runs({ agentId, limit: 20 }),
    window.tecapi.agents.list(),
  ]);
  const ids = new Set<string>();
  for (const r of routines) {
    if (r.agentId !== agentId || !r.workflowId) continue;
    const wf = workflows.find((w) => w.id === r.workflowId);
    if (wf) ids.add(wf.ownerAgentId);
  }
  for (const run of runs) if (run.runnerAgentId === agentId) ids.add(run.ownerAgentId);
  ids.delete(agentId);
  return agents.filter((a) => ids.has(a.id)).map((a) => ({ id: a.id, name: a.name }));
}

const Composer = memo(function Composer({ agentId, agentName, busy, onSend, onStop }: ComposerProps) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [sendError, setSendError] = useState('');
  const [sendNote, setSendNote] = useState('');
  const [owners, setOwners] = useState<OwnerTarget[]>([]);
  /** Empty means the runner, this agent. */
  const [target, setTarget] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    setOwners([]);
    setTarget('');
    loadOwnerTargets(agentId)
      .then((list) => {
        if (alive) setOwners(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [agentId]);

  const targetOwner = owners.find((o) => o.id === target) ?? null;
  /** No other owner: the Owner role is this agent itself, working with its workflow tools. */
  const selfOwner = target === SELF_OWNER;

  useEffect(() => {
    setDraft('');
    setPending([]);
    setSendError('');
    setSendNote('');
    const el = taRef.current;
    if (el) {
      el.style.height = 'auto';
    }
  }, [agentId]);

  useEffect(() => {
    if (busy) return;
    taRef.current?.focus();
  }, [busy, agentId]);

  async function addFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    try {
      const next = await Promise.all(list.map(fileToPending));
      setPending((prev) => [...prev, ...next]);
      setSendError('');
    } catch (e) {
      setSendError(`Could not read file: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const hasDraft = draft.trim().length > 0 || pending.length > 0;
  const canSend = hasDraft && !sending;
  const showStop = busy && !hasDraft;

  async function submit() {
    const text = draft.trim();
    if ((!text && pending.length === 0) || sending) return;
    const attachments = pending;
    const owner = targetOwner;
    const mustStop = busy && !owner;
    setDraft('');
    setPending([]);
    const el = taRef.current;
    if (el) el.style.height = 'auto';
    setSending(true);
    setSendError('');
    setSendNote('');
    const restore = (e: unknown) => {
      setSendError(`Message not sent: ${e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': /, '') : String(e)}`);
      setDraft((cur) => cur || text);
      setPending((cur) => (cur.length ? cur : attachments));
    };
    try {
      if (mustStop) await onStop();
      if (owner) {
        setSendNote(`Sent to owner ${owner.name}. The reply appears in its chat.`);
        onSend(`[Message from the chat of runner agent ${agentName}]\n\n${text}`, attachments, owner.id).catch(restore);
      } else if (selfOwner) {
        onSend(`${SELF_OWNER_PREFIX}\n\n${text}`, attachments).catch(restore);
      } else {
        onSend(text, attachments).catch(restore);
      }
    } catch (e) {
      restore(e);
    } finally {
      setSending(false);
      taRef.current?.focus();
    }
  }

  return (
    <div className="composer-wrap">
      {sendError ? <div className="composer-error">{sendError}</div> : null}
      {!sendError && sendNote ? <div className="composer-note">{sendNote}</div> : null}
      {pending.length > 0 && (
        <div className="attach-chips" aria-label="Pending attachments">
          {pending.map((p) => (
            <div key={p.id} className="attach-chip">
              {p.previewUrl ? (
                <img src={p.previewUrl} alt={p.name} className="attach-thumb" />
              ) : (
                <span className="attach-file-icon">F</span>
              )}
              <span className="attach-name" title={p.name}>
                {p.name}
              </span>
              <button
                type="button"
                className="attach-remove"
                title="Remove"
                aria-label={`Remove ${p.name}`}
                onClick={() => setPending((prev) => prev.filter((x) => x.id !== p.id))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer">
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="composer-icon"
          title="Attach file"
          aria-label="Attach file"
          disabled={busy && !targetOwner}
          onClick={() => fileRef.current?.click()}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
          <div className="composer-target" role="radiogroup" aria-label="Send to">
            <button
              type="button"
              role="radio"
              aria-checked={!targetOwner && !selfOwner}
              className={!targetOwner && !selfOwner ? 'active' : ''}
              title={`Send to runner ${agentName}`}
              onClick={() => setTarget('')}
            >
              Runner
            </button>
            {owners.map((o) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={target === o.id}
                className={target === o.id ? 'active' : ''}
                title={`Send to workflow owner ${o.name}`}
                onClick={() => setTarget(o.id)}
              >
                {owners.length > 1 ? o.name : 'Owner'}
              </button>
            ))}
            {owners.length === 0 ? (
              <button
                type="button"
                role="radio"
                aria-checked={selfOwner}
                className={selfOwner ? 'active' : ''}
                title={`${agentName} as workflow owner: create, edit, review or fix workflows`}
                onClick={() => setTarget(SELF_OWNER)}
              >
                Owner
              </button>
            ) : null}
          </div>
        <textarea
          ref={taRef}
          className="composer-input"
          placeholder={
            targetOwner
              ? `Message owner ${targetOwner.name}`
              : selfOwner
                ? `Message ${agentName} as workflow owner`
                : `Message ${agentName}`
          }
          value={draft}
          rows={1}
          onChange={(e) => {
            setDraft(e.target.value);
            fitComposer(e.target);
          }}
          onPaste={(e) => {
            const items = e.clipboardData?.items;
            if (!items?.length) return;
            const files: File[] = [];
            for (const item of Array.from(items)) {
              if (item.kind === 'file') {
                const f = item.getAsFile();
                if (f) files.push(f);
              }
            }
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (hasDraft && !sending) void submit();
            }
          }}
        />
        <button type="button" className="composer-icon" title="Voice (stub)" disabled>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.8" />
            <path
              d="M5 11a7 7 0 0 0 14 0M12 18v3"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <button
          type="button"
          className={`send-btn${showStop ? ' stop' : ''}${!showStop && !canSend ? ' idle' : ''}`}
          aria-disabled={!showStop && !canSend}
          onClick={() => {
            if (showStop) void onStop();
            else if (canSend) void submit();
          }}
        >
          {showStop ? 'Stop' : 'Send'}
        </button>
      </div>
    </div>
  );
});

export function ChatView({
  agent,
  messages,
  streamingId,
  liveTodos = [],
  liveTodoMessageId = null,
  agentRunning = false,
  workflowRuns = {},
  onNeedWorkflowRun,
  onSend,
  onStop,
  onOpenAgentSettings,
  onRename,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  /** Follow new output only while the user is at the bottom, so reading older messages is not interrupted. */
  const stickToBottom = useRef(true);
  const lastMessageId = messages[messages.length - 1]?.id;
  const lastRole = messages[messages.length - 1]?.role;

  useEffect(() => {
    if (lastRole === 'user') stickToBottom.current = true;
  }, [lastMessageId, lastRole]);

  useEffect(() => {
    if (stickToBottom.current) bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages, streamingId]);

  const wfRunIdOf = new Map<string, string>();
  const wfLastMsg = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const runId = workflowRunIdOf(m.meta);
    if (!runId) continue;
    wfRunIdOf.set(m.id, runId);
    wfLastMsg.set(runId, m.id);
  }

  useEffect(() => {
    if (!onNeedWorkflowRun) return;
    for (const runId of new Set(wfRunIdOf.values())) {
      if (!workflowRuns[runId]) onNeedWorkflowRun(runId);
    }
  });

  if (!agent) {
    return (
      <main className="chat">
        <div className="chat-empty">Select or create an agent to start chatting.</div>
      </main>
    );
  }

  const busy = !!streamingId || agentRunning;

  return (
    <main className="chat">
      <header className="chat-header">
        <div className="chat-title">
          <div className="avatar sm" style={{ background: agent.color }}>
            {agent.name.slice(0, 2).toUpperCase()}
          </div>
          <div>
            <EditableName key={agent.id} name={agent.name} onRename={onRename} />
            <div className="title-sub">{formatModelLabel(agent.model, agent.config)}</div>
          </div>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="icon-btn"
            onClick={() => void window.tecapi.agents.openWorkspace(agent.id)}
            title="Open agent workspace"
            aria-label="Open agent workspace"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M3 7.5A2.5 2.5 0 0 1 5.5 5h4.2c.4 0 .8.2 1.1.5l1.2 1.2c.3.3.7.5 1.1.5H18.5A2.5 2.5 0 0 1 21 9.7v6.8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={onOpenAgentSettings}
            title="Agent settings"
            aria-label="Agent settings"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
                stroke="currentColor"
                strokeWidth="1.8"
              />
              <path
                d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.3.6.9 1 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </header>

      <div
        className="transcript"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {messages.length === 0 && (
          <div className="welcome">
            <h2>Chat with {agent.name}</h2>
            <p>
              Messages run locally via the Cursor SDK against this agent&apos;s workspace. App-wide
              API key lives under Local user; use the gear for this agent&apos;s name and model.
            </p>
          </div>
        )}
        {messages.filter((m) => !m.agentId || m.agentId === agent.id).map((m) => {
          const todos =
            m.id === liveTodoMessageId && liveTodos.length ? liveTodos : parseMessageTodos(m.meta);
          const wfRunId = wfRunIdOf.get(m.id);
          const wfRun = wfRunId ? workflowRuns[wfRunId] : undefined;
          if (!m.content && !todos.length && !wfRun) return null;
          const metaLine = m.role === 'assistant' ? assistantMetaLine(m) : '';
          const parts = m.role === 'assistant' ? unpackAssistantBody(m.content || '') : null;
          return (
            <div key={m.id} className={`bubble-row ${m.role}`}>
              <div className={`bubble ${m.role} ${streamingId === m.id ? 'streaming' : ''}`}>
                {m.role === 'interbot' && <div className="badge">Inter-bot</div>}
                {m.role === 'assistant' ? (
                  <>
                    {parts?.thinking ? (
                      <ThinkingSection
                        text={parts.thinking}
                        streaming={streamingId === m.id}
                        collapse={streamingId !== m.id && !!parts.answer}
                      />
                    ) : null}
                    {wfRun ? <WorkflowCard run={wfRun} compact={wfLastMsg.get(wfRun.id) !== m.id} /> : null}
                    <TodoList todos={todos} />
                    {parts?.answer ? <MarkdownBody text={parts.answer} /> : null}
                    {metaLine ? (
                      <div className="msg-time" title={metaLine}>
                        {metaLine}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <MarkdownBody className="md-user" text={m.content} />
                )}
              </div>
            </div>
          );
        })}
        {streamingId &&
        !messages.some(
          (m) =>
            m.id === streamingId &&
            (m.content ||
              (m.id === liveTodoMessageId && liveTodos.length) ||
              parseMessageTodos(m.meta).length)
        ) ? (
          <div className="bubble-row assistant thinking-row" aria-live="polite">
            <div className="bubble assistant streaming">
              <div className="bubble-text">
                <span className="thinking-label">Thinking</span>
                <span className="thinking" aria-label="Thinking">
                  <span className="thinking-dot" />
                  <span className="thinking-dot" />
                  <span className="thinking-dot" />
                </span>
              </div>
            </div>
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>

      <Composer agentId={agent.id} agentName={agent.name} busy={busy} onSend={onSend} onStop={onStop} />
    </main>
  );
}
