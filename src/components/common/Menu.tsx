import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { create } from 'zustand';

export interface MenuAction {
  label: string;
  icon?: LucideIcon;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

export type MenuItem = MenuAction | 'separator' | { heading: string };

interface MenuPopupProps {
  items: MenuItem[];
  x: number;
  y: number;
  onClose: () => void;
  /** Element that opened the menu; clicks on it do not count as "outside". */
  anchor?: HTMLElement | null;
  onNavigate?: (direction: 1 | -1) => void;
  label?: string;
}

export function MenuPopup({ items, x, y, onClose, anchor, onNavigate, label }: MenuPopupProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - rect.width - 6)),
      y: Math.max(4, Math.min(y, window.innerHeight - rect.height - 6)),
    });
    const first = el.querySelector<HTMLButtonElement>('button:not(:disabled)');
    first?.focus();
  }, [x, y, items]);

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onBlur = () => onClose();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
  }, [onClose, anchor]);

  const move = (delta: number) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(index + delta + buttons.length) % buttons.length].focus();
  };

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      aria-label={label}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') move(1);
        else if (event.key === 'ArrowUp') move(-1);
        else if (event.key === 'Escape') {
          onClose();
          anchor?.focus();
        } else if (event.key === 'ArrowRight' && onNavigate) onNavigate(1);
        else if (event.key === 'ArrowLeft' && onNavigate) onNavigate(-1);
        else if (event.key === 'Tab') onClose();
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) => {
        if (item === 'separator') return <div key={index} className="menu-sep" role="separator" />;
        if ('heading' in item) return <div key={index} className="menu-heading">{item.heading}</div>;
        const Icon = item.icon;
        return (
          <button
            key={index}
            type="button"
            role="menuitem"
            className={`menu-item ${item.danger ? 'danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {Icon ? <Icon /> : <span style={{ width: 14 }} />}
            <span className="menu-label">{item.label}</span>
            {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ---- global context menu ----

interface ContextMenuState {
  menu: { x: number; y: number; items: MenuItem[] } | null;
}

const useContextMenuStore = create<ContextMenuState>(() => ({ menu: null }));

export function openContextMenu(event: { clientX: number; clientY: number; preventDefault: () => void }, items: MenuItem[]) {
  event.preventDefault();
  useContextMenuStore.setState({ menu: { x: event.clientX, y: event.clientY, items } });
}

export function ContextMenuHost() {
  const menu = useContextMenuStore((s) => s.menu);
  if (!menu) return null;
  return <MenuPopup items={menu.items} x={menu.x} y={menu.y} onClose={() => useContextMenuStore.setState({ menu: null })} label="Context menu" />;
}
