import { useState } from 'react';
import type { Agent } from '../types';
import { ModalBackdrop } from './ModalBackdrop';

type Props = {
  open: boolean;
  agents: Agent[];
  fromId: string | null;
  onClose: () => void;
  onSent: () => void;
};

export function InterbotModal({ open, agents, fromId, onClose, onSent }: Props) {
  const [toId, setToId] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!open) return null;

  const others = agents.filter((a) => a.id !== fromId);

  async function send() {
    if (!fromId || !toId || !text.trim()) return;
    setBusy(true);
    setError('');
    try {
      await window.tecapi.interbot.send(fromId, toId, text.trim());
      setText('');
      onSent();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal small-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Inter-bot message</h2>
        <p className="hint">Send a message from the selected agent to another agent (persisted + run).</p>
        <label className="field">
          <span>To</span>
          <select value={toId} onChange={(e) => setToId(e.target.value)}>
            <option value="">Select agent…</option>
            {others.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Message</span>
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        {error && <p className="status error">{error}</p>}
        <div className="row end">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !toId || !text.trim() || !fromId}
            onClick={() => void send()}
          >
            Send
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
