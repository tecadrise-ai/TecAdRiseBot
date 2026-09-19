import { useEffect, type MouseEvent, type ReactNode } from 'react';

const closeStack: Array<() => void> = [];

function closeIfBackdrop(e: MouseEvent<HTMLDivElement>, onClose: () => void) {
  if (e.target === e.currentTarget) onClose();
}

export function ModalBackdrop({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    closeStack.push(onClose);
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (closeStack[closeStack.length - 1] !== onClose) return;
      e.preventDefault();
      onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const i = closeStack.lastIndexOf(onClose);
      if (i >= 0) closeStack.splice(i, 1);
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => closeIfBackdrop(e, onClose)}>
      {children}
    </div>
  );
}
