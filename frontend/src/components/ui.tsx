import React, { useEffect, useId, useRef } from 'react';
import { humanize } from '../resources';
import { statusColor, statusSoft } from '../lib/status';

export function StageBadge({ stage }: { stage: string | null | undefined }) {
  const color = statusColor(stage);
  return (
    <span
      className="badge"
      style={{ color, background: statusSoft(stage), borderColor: 'color-mix(in srgb, currentColor 30%, transparent)' }}
    >
      <span className="bdot" />
      {humanize(stage)}
    </span>
  );
}

export function Badge({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="dim">—</span>;
  const color = statusColor(value);
  return (
    <span
      className="badge"
      style={{ color, background: statusSoft(value), borderColor: 'color-mix(in srgb, currentColor 30%, transparent)' }}
    >
      {humanize(value)}
    </span>
  );
}

export function Spinner() {
  return <span className="spinner" />;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading-row">
      <Spinner /> {label}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty-state">
      <div className="big">{title}</div>
      {hint ? <div>{hint}</div> : null}
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="error-box" role="alert">
      {message}
    </div>
  );
}

export function ProgressBar({ value, color }: { value: number; color?: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="progress">
      <div style={{ width: `${v}%`, background: color ?? 'var(--accent)' }} />
    </div>
  );
}

/**
 * Accessible dialog: focus moves in on open, cycles inside (Tab / Shift+Tab),
 * Escape closes, and focus returns to whatever opened it on unmount.
 * `onClose` is read through a ref so parent re-renders never restart the trap
 * (typing inside a modal must not steal focus).
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = dialogRef.current;
    const focusables = () =>
      Array.from(
        node?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      ).filter(el => el.offsetParent !== null || el === document.activeElement);

    const initial = focusables()[0];
    (initial ?? node)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const els = focusables();
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, []);

  return (
    <div className="modal-overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div
        className={wide ? 'modal wide' : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h3 id={titleId}>{title}</h3>
          <button className="x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmButton({
  label,
  confirmLabel = 'Confirm',
  question,
  onConfirm,
  className = 'btn sm'
}: {
  label: React.ReactNode;
  confirmLabel?: string;
  question: string;
  onConfirm: () => void;
  className?: string;
}) {
  const [armed, setArmed] = React.useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  if (!armed) {
    return (
      <button className={className} onClick={() => setArmed(true)} title={question}>
        {label}
      </button>
    );
  }
  return (
    <button
      className={className + ' danger'}
      onClick={() => {
        setArmed(false);
        onConfirm();
      }}
    >
      {confirmLabel}
    </button>
  );
}

export function TimeAgo({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="dim">—</span>;
  const rel = relative(value);
  return <span title={value}>{rel}</span>;
}

function relative(value: string): string {
  const diff = Date.now() - new Date(value).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
