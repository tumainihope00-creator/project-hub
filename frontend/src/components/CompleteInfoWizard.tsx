import { useEffect, useMemo, useState } from 'react';
import { Modal } from './ui';
import { StatusPill } from './ReadinessChecklist';
import type { GenOptions, ReadinessReport, WizardStep } from '../lib/readiness';
import { STATUS_COLOR, isBlocking } from '../lib/readiness';

export interface WizardSaveResult {
  readiness: ReadinessReport;
  saved: string[];
  rejected: Record<string, string>;
}

export type WizardSaveFn = (values: Record<string, string>, index: number) => Promise<WizardSaveResult>;

/**
 * "Complete Project Information"
 *
 * Walks the user through the missing items one at a time, inside this modal —
 * they never have to close it and navigate away. Each "Save & Next" writes
 * straight to the existing project columns, so the answers are there the next
 * time the generator runs.
 */
export function CompleteInfoWizard({
  steps,
  options,
  projectName,
  saving,
  error,
  onOptionsChange,
  onSave,
  onBackToChecklist,
  onFinish,
  onClose
}: {
  steps: WizardStep[];
  options: GenOptions;
  projectName: string;
  saving: boolean;
  error: string | null;
  onOptionsChange: (next: GenOptions) => void;
  onSave: WizardSaveFn;
  onBackToChecklist: () => void;
  onFinish: () => void;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState<Record<string, string>>({});

  // Drafts are keyed by step so going Back never loses what was already typed.
  useEffect(() => {
    setDraft(prev => {
      if (Object.prototype.hasOwnProperty.call(prev, steps[index]?.key ?? '')) return prev;
      return { ...prev, [steps[index]?.key ?? '']: steps[index]?.value ?? '' };
    });
  }, [index, steps]);

  const step = steps[index];
  const isLast = index === steps.length - 1;
  const value = step ? (draft[step.key] ?? step.value) : '';
  const remaining = useMemo(() => steps.filter((_, i) => i > index).length, [steps, index]);

  if (!step) {
    return (
      <Modal title="Complete Project Information" onClose={onClose} wide>
        <div className="rc-next">
          There is nothing left to fill in from this list.
        </div>
        <div className="modal-inline-foot">
          <button className="btn primary" onClick={onBackToChecklist}>
            Back to the readiness check
          </button>
        </div>
      </Modal>
    );
  }

  const setValue = (v: string) => setDraft(d => ({ ...d, [step.key]: v }));

  const saveAndAdvance = async () => {
    const res = await onSave(buildPayload(step, value, options, onOptionsChange), index);
    if (isLast) onFinish();
    else setIndex(i => i + 1);
    return res;
  };

  const canAdvance = value.trim().length > 0;

  return (
    <Modal
      title="Complete Project Information"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn ghost" onClick={onBackToChecklist}>
            ← Back to checklist
          </button>
          <div className="wz-foot-spacer" />
          <button className="btn" onClick={() => setIndex(i => Math.max(0, i - 1))} disabled={index === 0 || saving}>
            Back
          </button>
          <button className="btn primary" onClick={saveAndAdvance} disabled={saving || !canAdvance}>
            {saving ? 'Saving…' : isLast ? 'Save & Finish' : 'Save & Next'}
          </button>
        </>
      }
    >
      <div className="wz-progress" aria-hidden="true">
        <div className="wz-dots">
          {steps.map((s, i) => (
            <span
              key={s.key}
              className={'wz-dot' + (i < index ? ' done' : i === index ? ' current' : '')}
              style={i <= index ? { background: STATUS_COLOR[i === index ? s.status : 'COMPLETE'] } : undefined}
            />
          ))}
        </div>
        <div className="wz-count mono">
          Step {index + 1} of {steps.length} · {index + 1}/{steps.length}
        </div>
      </div>

      <div className="wz-head">
        <div className="wz-title">
          {step.label}
          <StatusPill status={step.status} />
        </div>
        <div className="wz-prompt">{step.prompt}</div>
        <div className="wz-hint">{step.hint}</div>
      </div>

      {error ? (
        <div className="wz-error" role="alert">
          {error}
        </div>
      ) : null}

      <StepField step={step} value={value} onChange={setValue} />

      <div className="wz-foot-note">
        {isLast
          ? 'This is the last item. Finishing returns you to the readiness check.'
          : `${remaining} item${remaining === 1 ? '' : 's'} left after this one.`}
        {' '}Answers are saved to <strong>{projectName}</strong> as you go.
      </div>
    </Modal>
  );
}

/**
 * Collects the answer for a step. Project fields and generator options are
 * handled differently: project fields are written to the project by the API,
 * options are applied to the generator configuration in place.
 */
function buildPayload(
  step: WizardStep,
  value: string,
  options: GenOptions,
  onOptionsChange: (next: GenOptions) => void
): Record<string, string> {
  const input = step.input;
  if (input.kind === 'text') {
    return { [input.field]: value };
  }
  if (input.kind === 'choice') {
    onOptionsChange({ ...options, [input.option]: value } as GenOptions);
    return {};
  }
  if (input.kind === 'choiceText') {
    // The choice "Specify technology" is only a placeholder: the value the user
    // typed becomes the stack itself, so no separate confirmation is needed.
    onOptionsChange({
      ...options,
      [input.option]: value === input.choices[input.choices.length - 1] ? value : 'Specify technology',
      customTech: value
    } as GenOptions);
  }
  return {};
}

function StepField({
  step,
  value,
  onChange
}: {
  step: WizardStep;
  value: string;
  onChange: (v: string) => void;
}) {
  const input = step.input;

  if (input.kind === 'text') {
    const long = ['description', 'problem', 'v1Scope', 'assumptions', 'expectedValue', 'targetUsers'].includes(
      input.field
    );
    return (
      <div className="field wz-field">
        <label htmlFor={`wz-${step.key}`}>{input.label}</label>
        {long ? (
          <textarea
            id={`wz-${step.key}`}
            rows={5}
            value={value}
            placeholder={input.hint}
            onChange={e => onChange(e.target.value)}
            autoFocus
          />
        ) : (
          <input
            id={`wz-${step.key}`}
            type={input.field === 'repositoryUrl' ? 'url' : 'text'}
            value={value}
            placeholder={input.hint}
            onChange={e => onChange(e.target.value)}
            autoFocus
          />
        )}
        <div className="hint">
          Saved to the project field <span className="mono">{input.field}</span>.
        </div>
      </div>
    );
  }

  if (input.kind === 'choice' || input.kind === 'choiceText') {
    return (
      <div className="field wz-field">
        <label>{input.label}</label>
        <div className="wz-choices" role="radiogroup" aria-label={input.label}>
          {input.choices.map(c => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={value === c}
              className={'wz-choice' + (value === c ? ' on' : '')}
              onClick={() => onChange(c)}
            >
              {c}
            </button>
          ))}
        </div>
        {input.kind === 'choiceText' && value === 'Specify technology' ? (
          <>
            <label htmlFor={`wz-${step.key}-text`} style={{ marginTop: 10 }}>
              Which technology stack?
            </label>
            <input
              id={`wz-${step.key}-text`}
              value={value === 'Specify technology' ? '' : value}
              placeholder="e.g. React 18 + TypeScript + Node + PostgreSQL"
              onChange={e => onChange(e.target.value === '' ? 'Specify technology' : e.target.value)}
            />
            <div className="hint">
              Required because you chose “Specify technology”. Choose “Recommend appropriate stack” instead if you
              want the AI agent to pick.
            </div>
          </>
        ) : (
          <div className="hint">Applied to the generator configuration for this and later generations.</div>
        )}
      </div>
    );
  }

  return (
    <div className="field wz-field">
      <div className="hint">
        This item is a list of records. Add it from the {input.label.toLowerCase()} page in Project Hub.
      </div>
    </div>
  );
}

/** Final screen: shown once every required item is complete. */
export function InformationCompleteModal({
  report,
  onGenerate,
  onReview,
  onClose
}: {
  report: ReadinessReport;
  onGenerate: () => void;
  onReview: () => void;
  onClose: () => void;
}) {
  const remainingRecommended = report.partialRecommended.length + report.missingRequired.length;
  return (
    <Modal
      title="✓ PROJECT INFORMATION COMPLETE"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onReview}>
            Review the checklist
          </button>
          <button className="btn primary" onClick={onGenerate}>
            Generate V1 Prompt
          </button>
        </>
      }
    >
      <div className="rc-head">
        <div className="rc-head-title" style={{ color: 'var(--green)' }}>
          ✓ PROJECT INFORMATION COMPLETE
        </div>
        <div className="rc-head-sub">All required information has now been provided.</div>
      </div>
      <div className="rc-complete-grid">
        <div>
          <span className="dim">Required</span>
          <strong className="mono">
            {report.summary.required.available} / {report.summary.required.total} complete
          </strong>
        </div>
        <div>
          <span className="dim">Recommended</span>
          <strong className="mono">
            {report.summary.recommended.available} / {report.summary.recommended.total} available
          </strong>
        </div>
        <div>
          <span className="dim">Optional</span>
          <strong className="mono">
            {report.summary.optional.available} / {report.summary.optional.total} available
          </strong>
        </div>
      </div>
      <div className="rc-next">
        You can now generate the V1 build prompt.
        {remainingRecommended > 0
          ? ` ${remainingRecommended} recommended item${remainingRecommended === 1 ? '' : 's'} still ${
              remainingRecommended === 1 ? 'is' : 'are'
            } incomplete — these will be noted in the prompt rather than blocking it.`
          : ''}
      </div>
    </Modal>
  );
}

export { isBlocking };
