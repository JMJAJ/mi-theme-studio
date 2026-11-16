import { useRef, useState } from 'react';

interface SplitterProps {
  orientation: 'vertical' | 'horizontal';
  value: number;
  min: number;
  max: number;
  /** +1 when dragging right/down grows the panel, -1 when it shrinks it. */
  direction?: 1 | -1;
  onChange: (value: number) => void;
  label: string;
}

/** Accessible resize handle (pointer drag + arrow keys). */
export function Splitter({ orientation, value, min, max, direction = 1, onChange, label }: SplitterProps) {
  const start = useRef<{ pos: number; value: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)));
  const vertical = orientation === 'vertical';

  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className={`splitter ${vertical ? 'splitter-v' : 'splitter-h'} ${dragging ? 'is-dragging' : ''}`}
      onPointerDown={(event) => {
        event.preventDefault();
        (event.target as HTMLElement).setPointerCapture(event.pointerId);
        start.current = { pos: vertical ? event.clientX : event.clientY, value };
        setDragging(true);
        document.body.style.cursor = vertical ? 'col-resize' : 'row-resize';
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        const delta = (vertical ? event.clientX : event.clientY) - start.current.pos;
        onChange(clamp(start.current.value + delta * direction));
      }}
      onPointerUp={() => {
        start.current = null;
        setDragging(false);
        document.body.style.cursor = '';
      }}
      onDoubleClick={() => onChange(clamp((min + max) / 2))}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 48 : 16;
        const grow = vertical ? 'ArrowRight' : 'ArrowDown';
        const shrink = vertical ? 'ArrowLeft' : 'ArrowUp';
        if (event.key === grow) onChange(clamp(value + step * direction));
        else if (event.key === shrink) onChange(clamp(value - step * direction));
        else return;
        event.preventDefault();
      }}
    />
  );
}
