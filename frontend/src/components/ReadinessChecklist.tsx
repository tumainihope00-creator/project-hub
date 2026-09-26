import { useState } from 'react';
import type { ReadinessCheck, ReadinessReport, ReadinessStatus } from '../lib/readiness';
import {
  GROUP_LABEL,
  GROUP_ORDER,
  LEVEL_LABEL,
  STATUS_COLOR,
  STATUS_GLYPH,
  STATUS_LABEL
} from '../lib/readiness';
import { stageLabel } from '../lib/readiness';

/**
 * The readiness checklist. Every expected item is listed with its own verdict,
 * what the project actually holds, and — when it is not usable — why it matters
 * and what to do about it. Clicking an item expands the detail.
 */
export function ReadinessChecklist({ report }: { report: ReadinessReport }) {
  const [open, setOpen] = useState<string | null>(null);

  const groups = GROUP_ORDER.map(g => ({
    group: g,
    checks: report.checks.filter(c => c.group === g)
  })).filter(s => s.checks.length > 0);

  return (
    <div className="rc-list">
      {groups.map(({ group, checks }) => (
        <section key={group} className="rc-group">
      <div className="rc-group-head">
        <span>{GROUP_LABEL[group]}</span>
        <span className="rc-group-count">
          {checks.filter(c => c.status === 'COMPLETE').length}/{checks.length} complete
        </span>
      </div>
      {checks.map(check => (
        <ChecklistItem
          key={check.key}
          check={check}
          stage={report.stage}
          open={open === check.key}
          onToggle={() => setOpen(open === check.key ? null : check.key)}
        />
      ))}
        </section>
      ))}
    </div>
  );
}

function ChecklistItem({
  check,
  stage,
  open,
  onToggle
}: {
  check: ReadinessCheck;
  stage: string;
  open: boolean;
  onToggle: () => void;
}) {
  const color = STATUS_COLOR[check.status];
  const needsDetail = check.status !== 'COMPLETE' && check.status !== 'OPTIONAL';

  return (
    <div className={'rc-item' + (open ? ' open' : '')} style={{ borderLeftColor: color }}>
      <button
        type="button"
        className="rc-item-head"
        onClick={onToggle}
        aria-expanded={open}
        title={needsDetail ? 'Show why' : check.detail}
      >
        <span className="rc-glyph" style={{ color }} aria-hidden="true">
          {STATUS_GLYPH[check.status]}
        </span>
        <span className="rc-item-main">
          <span className="rc-item-label">
            {check.label}
            {check.emphasised ? (
              <span className="rc-flag" title={`Especially relevant at the ${stageLabel(stage)} stage`}>
                stage focus
              </span>
            ) : null}
          </span>
          <span className="rc-item-detail">{check.detail}</span>
        </span>
        <span className="rc-item-meta">
          <span className="rc-level" data-level={check.level}>
            {LEVEL_LABEL[check.level]}
          </span>
          <span className="rc-status" style={{ color }}>
            {STATUS_LABEL[check.status]}
          </span>
        </span>
      </button>

      {open ? (
        <div className="rc-item-body">
          <div className="rc-kv-row">
            <span className="rc-kv-key">Why it matters</span>
            <span className="rc-kv-val">{check.reason}</span>
          </div>
          <div className="rc-kv-row">
            <span className="rc-kv-key">What to do</span>
            <span className="rc-kv-val">{check.action}</span>
          </div>
          {check.status === 'ERROR' && check.error ? (
            <>
              <div className="rc-kv-row">
                <span className="rc-kv-key">Operation that failed</span>
                <span className="rc-kv-val mono">{check.error.operation}</span>
              </div>
              <div className="rc-kv-row">
                <span className="rc-kv-key">Reason</span>
                <span className="rc-kv-val">{check.error.reason}</span>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Compact one-line state used in the wizard header. */
export function StatusPill({ status }: { status: ReadinessStatus }) {
  return (
    <span className="rc-pill" style={{ color: STATUS_COLOR[status], borderColor: STATUS_COLOR[status] + '55' }}>
      <span aria-hidden="true">{STATUS_GLYPH[status]}</span>
      {STATUS_LABEL[status]}
    </span>
  );
}

/** The readiness summary block shown at the bottom of the modal. */
export function ReadinessSummary({ report }: { report: ReadinessReport }) {
  const line = (label: string, t: { complete: number; available: number; total: number }) => (
    <div className="rc-sum-row" key={label}>
      <span className="rc-sum-key">{label}</span>
      <span className="rc-sum-val mono">
        {t.available} / {t.total} {label === 'Required' ? 'complete' : 'available'}
      </span>
    </div>
  );

  return (
    <div className="rc-summary">
      <div className="rc-summary-head">Readiness summary</div>
      {line('Required', report.summary.required)}
      {line('Recommended', report.summary.recommended)}
      {line('Optional', report.summary.optional)}
      <div className="rc-sum-status" data-verdict={report.verdict}>
        {report.ready
          ? '✓ Ready to generate — all required information is available.'
          : `⚠ ${report.missingRequired.length} required item${
              report.missingRequired.length === 1 ? '' : 's'
            } need attention before the prompt can be generated.`}
      </div>
    </div>
  );
}
