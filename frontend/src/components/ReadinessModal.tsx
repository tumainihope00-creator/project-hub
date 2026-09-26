import { useState } from 'react';
import { Modal, Spinner } from './ui';
import { ReadinessChecklist, ReadinessSummary } from './ReadinessChecklist';
import type { GenOptions, ReadinessReport } from '../lib/readiness';
import { STATUS_COLOR, isBlocking, stageLabel } from '../lib/readiness';
import { ApiError } from '../api/client';

export interface ReadinessFailure {
  title: string;
  reason: string;
  context: string;
  possibleAction: string;
}

/**
 * "V1 Prompt Readiness Check"
 *
 * Opens when the user presses Generate. It never generates anything itself — it
 * shows what Project Hub expected, what exists, what is missing, why the missing
 * information matters, and the two ways forward: fill it in, or proceed anyway.
 */
export function ReadinessModal({
  report,
  loading,
  failure,
  busy,
  onClose,
  onFill,
  onProceed,
  onGenerate,
  onRetry
}: {
  report: ReadinessReport | null;
  loading: boolean;
  failure: ReadinessFailure | null;
  busy: boolean;
  onClose: () => void;
  onFill: () => void;
  onProceed: () => void;
  onGenerate: () => void;
  onRetry: () => void;
}) {
  const [showOptional, setShowOptional] = useState(false);

  if (failure) {
    return (
      <Modal title="PROMPT GENERATION FAILED" onClose={onClose} wide>
        <div className="pf">
          <div className="pf-kind" style={{ color: 'var(--red)' }}>
            {failure.title}
          </div>
          <dl className="kv pf-kv">
            <dt>Reason</dt>
            <dd>{failure.reason}</dd>
            <dt>Context</dt>
            <dd className="mono">{failure.context}</dd>
            <dt>Possible action</dt>
            <dd>{failure.possibleAction}</dd>
          </dl>
          <div className="dim tiny" style={{ marginTop: 10 }}>
            This is a technical problem, not missing project information. Nothing about your project data has
            changed.
          </div>
        </div>
        <div className="modal-inline-foot">
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" onClick={onRetry}>
            Retry the readiness check
          </button>
        </div>
      </Modal>
    );
  }

  if (loading || !report) {
    return (
      <Modal title="V1 Prompt Readiness Check" onClose={onClose}>
        <div className="loading-row">
          <Spinner /> Checking project information…
        </div>
      </Modal>
    );
  }

  const missing = report.missingRequired;
  const partial = report.partialRecommended;
  const optionalMissing = report.missingOptional;
  const routed = report.checks.filter(c => c.status !== 'COMPLETE' && c.input?.kind === 'count');
  const errors = report.failures;

  return (
    <Modal
      title="V1 Prompt Readiness Check"
      onClose={onClose}
      wide
      footer={
        <>
          {report.ready ? (
            <>
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button className="btn primary" onClick={onGenerate} disabled={busy}>
                {busy ? 'Generating…' : 'Generate Prompt'}
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={onProceed} disabled={busy}>
                {busy ? 'Generating…' : 'Proceed Anyway'}
              </button>
              <button className="btn primary" onClick={onFill} disabled={busy || report.wizardSteps.length === 0}>
                Fill Missing Info
              </button>
            </>
          )}
        </>
      }
    >
      <div className="rc-head">
        <div className="rc-head-title">{report.ready ? '✓ V1 PROMPT READY' : 'V1 PROMPT NEEDS MORE INFORMATION'}</div>
        <div className="rc-head-sub">
          Project Hub is checking whether this project contains enough information to create a clear V1 build
          prompt.
        </div>
        <div className="rc-head-meta">
          <span>
            <span className="dim">Project</span> <strong>{report.project.name}</strong>
          </span>
          <span>
            <span className="dim">Stage</span> <strong>{stageLabel(report.stage)}</strong>
          </span>
          <span>
            <span className="dim">Readiness</span>{' '}
            <strong className="mono">{report.summary.required.available}/{report.summary.required.total} required</strong>
          </span>
        </div>
      </div>

      {errors.length > 0 ? (
        <div className="rc-error-box" role="alert">
          <div className="rc-error-head">! Some project data could not be read</div>
          {errors.map(c => (
            <div key={c.key} className="rc-error-row">
              <span style={{ color: STATUS_COLOR.ERROR }}>!</span>
              <span>
                <strong>{c.label}</strong> — {c.detail}
                {c.error ? (
                  <span className="dim mono"> ({c.error.operation}: {c.error.reason})</span>
                ) : null}
              </span>
            </div>
          ))}
          <div className="dim tiny" style={{ marginTop: 6 }}>
            This is a system problem, not missing information. Generation continues from the data that could be
            read.
          </div>
        </div>
      ) : null}

      <ReadinessChecklist report={report} />

      <ReadinessSummary report={report} />

      {report.ready ? (
        <div className="rc-next">
          All required project information is available. Recommended and optional gaps will be noted in the prompt
          as things to confirm — they do not block generation.
        </div>
      ) : (
        <>
          <div className="rc-block">
            <div className="rc-block-head">
              Missing ({missing.length}) <span className="dim">— required before generating a strong prompt</span>
            </div>
            {missing.map(c => (
              <div key={c.key} className="rc-miss">
                <div className="rc-miss-head">
                  <span style={{ color: STATUS_COLOR[c.status] }}>{c.status === 'ERROR' ? '!' : '✗'}</span>
                  <strong>{c.label}</strong>
                  <span className="dim">{c.detail}</span>
                </div>
                <div className="rc-miss-why">
                  <span className="rc-miss-tag">Why it matters</span>
                  {c.reason}
                </div>
                <div className="rc-miss-why">
                  <span className="rc-miss-tag">Recommended action</span>
                  {c.action}
                </div>
              </div>
            ))}
          </div>

          {partial.length > 0 ? (
            <div className="rc-block">
              <div className="rc-block-head">
                Recommended ({partial.length}) <span className="dim">— usable, but the prompt will be sharper with these</span>
              </div>
              {partial.map(c => (
                <div key={c.key} className="rc-miss">
                  <div className="rc-miss-head">
                    <span style={{ color: STATUS_COLOR.PARTIAL }}>⚠</span>
                    <strong>{c.label}</strong>
                    <span className="dim">{c.detail}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {routed.length > 0 ? (
            <div className="rc-block">
              <div className="rc-block-head">
                Add on their own page <span className="dim">— these are lists, not single fields</span>
              </div>
              {routed.map(c => (
                <div key={c.key} className="rc-miss">
                  <div className="rc-miss-head">
                    <span style={{ color: STATUS_COLOR[c.status] }}>○</span>
                    <strong>{c.label}</strong>
                    <span className="dim">{c.detail}</span>
                  </div>
                  <div className="rc-miss-why">
                    <span className="rc-miss-tag">How</span>
                    {c.input?.kind === 'count' ? c.input.hint : c.action}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}

      {optionalMissing.length > 0 ? (
        <div className="rc-optional">
          <button className="rc-optional-toggle" onClick={() => setShowOptional(v => !v)}>
            {showOptional ? '▾' : '▸'} Optional ({optionalMissing.filter(c => c.status !== 'COMPLETE').length} not
            recorded) — never blocks generation
          </button>
          {showOptional ? (
            <div className="rc-optional-list">
              {optionalMissing.map(c => (
                <div key={c.key} className="rc-miss">
                  <div className="rc-miss-head">
                    <span style={{ color: STATUS_COLOR[c.status] }}>○</span>
                    <strong>{c.label}</strong>
                    <span className="dim">{c.detail}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {!report.ready ? (
        <div className="rc-next">
          You can either complete the missing information, or generate the prompt using the data that does exist.
          “Proceed Anyway” never invents requirements — each gap is written into the prompt as something the AI
          agent must confirm with you.
        </div>
      ) : null}
    </Modal>
  );
}

/** Turns an ApiError into the specific, non-generic explanation the modal shows. */
export function describeFailure(err: unknown, action: string): ReadinessFailure {
  if (err instanceof ApiError) {
    const details = err.details as { category?: string; operation?: string; possibleAction?: string } | undefined;
    const category = details?.category;
    const title =
      category === 'NOT_FOUND'
        ? 'PROJECT NOT FOUND'
        : category === 'VALIDATION_FAILED'
          ? 'REQUEST REJECTED'
          : category === 'DATA_MISSING'
            ? 'NOT ENOUGH INFORMATION'
            : category === 'GENERATION_ERROR'
              ? 'GENERATION ERROR'
              : 'SYSTEM ERROR';
    return {
      title,
      reason: err.message,
      context: details?.operation ?? action,
      possibleAction: details?.possibleAction ?? 'Retry. If it keeps failing, check the backend logs.'
    };
  }
  return {
    title: 'SYSTEM ERROR',
    reason: err instanceof Error ? err.message : String(err),
    context: action,
    possibleAction: 'Retry. If it keeps failing, check the backend logs.'
  };
}

export type { GenOptions };
export { isBlocking };
