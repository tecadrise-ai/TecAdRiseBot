import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import architectureSvg from '../assets/architecture.svg?raw';

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 6;

type View = { x: number; y: number; scale: number };
type Tip = { text: string; x: number; y: number } | null;

type Props = {
  svg?: string;
  width?: number;
  height?: number;
  label?: string;
  /** Called with the file name of an item marked data-doc when it is clicked (not dragged). */
  onOpenDoc?: (name: string) => void;
};

/** Ctrl + wheel zooms at the cursor, left drag pans, double click fits, hover shows item details. */
export function ArchitectureDiagram({
  svg = architectureSvg,
  width: W = 1200,
  height: H = 640,
  label = 'How agents work: Cursor SDK or BYOK, HTTP connectors, secrets stay in the host, the agent works in its workspace',
  onOpenDoc,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const [tip, setTip] = useState<Tip>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const fit = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const scale = Math.min(el.clientWidth / W, el.clientHeight / H);
    setView({ scale, x: (el.clientWidth - W * scale) / 2, y: (el.clientHeight - H * scale) / 2 });
  }, [W, H]);

  useEffect(() => {
    fit();
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      setView((v) => {
        const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.scale * Math.exp(-e.deltaY * 0.0015)));
        const k = scale / v.scale;
        return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener('wheel', onWheel);
    };
  }, [fit]);

  function hover(e: PointerEvent<HTMLDivElement>) {
    const box = boxRef.current;
    const item = (e.target as Element | null)?.closest?.('[data-tip]');
    if (!box || !item || drag.current) {
      setTip(null);
      return;
    }
    const r = box.getBoundingClientRect();
    setTip({ text: item.getAttribute('data-tip') || '', x: e.clientX - r.left, y: e.clientY - r.top });
  }

  return (
    <div
      ref={boxRef}
      className={`arch-canvas ${dragging ? 'dragging' : ''}`}
      style={{ aspectRatio: `${W} / ${H}` }}
      onDoubleClick={fit}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
        setDragging(true);
        setTip(null);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) {
          hover(e);
          return;
        }
        setView((v) => ({ ...v, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py }));
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        setDragging(false);
        if (!d || !onOpenDoc || Math.hypot(e.clientX - d.px, e.clientY - d.py) > 4) return;
        const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-doc]');
        const name = hit?.getAttribute('data-doc');
        if (name) onOpenDoc(name);
      }}
      onPointerLeave={() => setTip(null)}
    >
      <div
        className="arch-svg"
        role="img"
        aria-label={label}
        style={{ left: view.x, top: view.y, width: W * view.scale, height: H * view.scale }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {tip ? (
        <div
          className={`arch-tip ${tip.x > (boxRef.current?.clientWidth ?? 0) / 2 ? 'left' : ''} ${tip.y > (boxRef.current?.clientHeight ?? 0) * 0.55 ? 'up' : ''}`}
          style={{ left: tip.x, top: tip.y }}
        >
          {tip.text}
        </div>
      ) : null}
      <div className="arch-help">Ctrl + wheel to zoom, drag to move, double click to fit</div>
    </div>
  );
}
