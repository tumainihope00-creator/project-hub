import React, { useEffect } from 'react';
import { humanize } from '../resources';
import { statusColor } from '../lib/status';

export function StageBadge({ stage }: { stage: string | null | undefined }) {
  const color = statusColor(stage);
  return (
    <span className="badge" style={{ color, borderColor: color + '66', background: color + '1a' }}>
      <span className="bdot" />
      {humanize(stage)}
    </span>
  );
}

export function Badge({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="dim">—</span>;
  const color = statusColor(value);
  return (
    <span className="badge" style={{ color, borderColor: color + '66', background: color + '1a' }}>
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
    <div className="toast" role="alert">
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={wide ? 'modal wide' : 'modal'}>
        <div className="modal-head">
          <h3>{title}</h3>
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