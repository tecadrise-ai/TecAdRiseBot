import { useEffect, useRef, useState } from 'react';
import type { Agent, ChatMessage } from '../types';
import { MarkdownBody } from './MarkdownBody';
import { fmtTs, fmtUsage, parseMessageUsage } from '../lib/usage';
import { formatModelLabel } from '../lib/modelOptions';

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
  agentRunning?: boolean;
  onSend: (text: string, attachments: PendingAttachment[]) => Promise<void>;
  onStop: () => void;
  onOpenAgentSettings: () => void;
};

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

export function ChatView({
  agent,
  messages,
  streamingId,
  agentRunning = false,
  onSend,
  onStop,
  onOpenAgentSettings,
}: Props) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingId, pending]);

  async function addFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    const next = await Promise.all(list.map(fileToPending));
    setPending((prev) => [...prev, ...next]);
  }

  async function submit() {
    const text = draft.trim();
    if ((!text && pending.length === 0) || !agent || sending || streamingId) return;
    const attachments = pending;
    setDraft('');
    setPending([]);
    setSending(true);
    try {
      await onSend(text, attachments);
    } finally {
      setSending(false);
      taRef.current?.focus();
    }
  }

  if (!agent) {
    return (
      <main className="chat">
        <div className="chat-empty">Select or create an agent to start chatting.</div>
      </main>
    );
  }

  const busy = !!streamingId || agentRunning;
  const canSend = (draft.trim().length > 0 || pending.length > 0) && !busy && !sending;

  return (
    <main className="chat">
      <header className="chat-header">
        <div className="chat-title">
          <div className="avatar sm" style={{ background: agent.color }}>
            {agent.name.slice(0, 2).toUpperCase()}
          </div>
          <div>
            <div className="title-name">{agent.name}</div>
            <div className="title-sub">{formatModelLabel(agent.model, agent.config)}</div>
          </div>
        </div>
        <button
          type="button"
          className="icon-btn header-gear"
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
      </header>

      <div className="transcript">
        {messages.length === 0 && (
          <div className="welcome">
            <h2>Chat with {agent.name}</h2>
            <p>
              Messages run locally via the Cursor SDK against this agent&apos;s workspace. App-wide
              API key lives under Local user; use the gear for this agent&apos;s name and model.
            </p>
          </div>
        )}
        {messages.map((m) => {
          if (!m.content) return null;
          const metaLine = m.role === 'assistant' ? assistantMetaLine(m) : '';
          return (
            <div key={m.id} className={`bubble-row ${m.role}`}>
              <div className={`bubble ${m.role} ${streamingId === m.id ? 'streaming' : ''}`}>
                {m.role === 'interbot' && <div className="badge">Inter-bot</div>}
                {m.role === 'assistant' ? (
                  <>
                    <MarkdownBody text={m.content} />
                    {metaLine ? (
                      <div className="msg-time" title={metaLine}>
                        {metaLine}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="bubble-text">{m.content}</div>
                )}
              </div>
            </div>
          );
        })}
        {streamingId && !messages.some((m) => m.id === streamingId && m.content) ? (
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

      <div className="composer-wrap">
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
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            +
          </button>
          <textarea
            ref={taRef}
            className="composer-input"
            placeholder={`Message ${agent.name}`}
            value={draft}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
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
                if (!busy) void submit();
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
            className={`send-btn${busy ? ' stop' : ''}${!busy && !canSend ? ' idle' : ''}`}
            aria-disabled={!busy && !canSend}
            onClick={() => {
              if (busy) onStop();
              else if (canSend) void submit();
            }}
          >
            {busy ? 'Stop' : 'Send'}
          </button>
        </div>
      </div>
    </main>
  );
}
