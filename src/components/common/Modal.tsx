import { useEffect, useRef, type ReactNode } from 'react';

interface ModalProps {
  title: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  /** Element to focus first (selector inside the modal). */
  initialFocus?: string;
}

/** Accessible modal dialog: traps focus, closes on Escape and backdrop click. */
export function Modal({ title, icon, children, footer, onClose, wide, initialFocus }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previous.current = document.activeElement as HTMLElement;
    const el = ref.current;
    const target =
      (initialFocus && el?.querySelector<HTMLElement>(initialFocus)) ||
      el?.querySelector<HTMLElement>('[data-autofocus]') ||
      el?.querySelector<HTMLElement>('input, textarea, select, button.btn-primary, button');
    target?.focus();
    return () => previous.current?.focus?.();
  }, [initialFocus]);

  return (
    <div
      className="modal-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
          if (event.key === 'Tab') {
            const focusable = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, [tabindex="0"]') ?? [])];
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              last.focus();
              event.preventDefault();
            } else if (!event.shiftKey && document.activeElement === last) {
              first.focus();
              event.preventDefault();
            }
          }
        }}
      >
        <div className="modal-head">
          {icon}
          <h2>{title}</h2>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
