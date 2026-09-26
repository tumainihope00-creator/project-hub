import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api/client';
import type {
  AnalyzeResult,
  CreateResponse,
  CreateResult,
  DraftField,
  DraftRecord,
  ImportCapabilities,
  ImportDraft
} from '../api/importTypes';
import { Loading, Modal } from './ui';

/**
 * Import a document as a new project.
 *
 * The flow is deliberately three steps so the user always sees what was read
 * before anything is written:
 *
 *   1. choose   - pick a file, nothing has been sent yet
 *   2. review   - the document was parsed and mapped; every value can be
 *                 corrected, switched off or deleted here. No database write has
 *                 happened, and cancelling here leaves nothing behind.
 *   3. create   - one transaction creates the new project and its records.
 *
 * There is no path in this component that edits an existing project.
 */

type Step = 'choose' | 'review' | 'creating' | 'done';

const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  problem: 'Problem',
  motivation: 'Motivation',
  targetUsers: 'Target users',
  expectedValue: 'Expected value',
  assumptions: 'Assumptions',
  initialQuestions: 'Initial questions',
  inspiration: 'Inspiration',
  v1Scope: 'V1 scope',
  stage: 'Stage',
  repositoryUrl: 'Repository URL'
};

const ENTITY_LABELS: Record<string, string> = {
  research: 'Research',
  'research-questions': 'Research questions',
  requirements: 'Requirements',
  features: 'Features',
  'tech-stack': 'Tech stack',
  decisions: 'Decisions',
  'database-tables': 'Database tables',
  'api-endpoints': 'API endpoints',
  milestones: 'Milestones',
  tasks: 'Tasks',
  issues: 'Issues',
  notes: 'Notes'
};

const HORIZON_LABELS: Record<string, string> = {
  v1: 'V1',
  future: 'Future',
  unscoped: 'Unscoped'
};

function label(field: string): string {
  return FIELD_LABELS[field] ?? field.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
}

function entityLabel(path: string): string {
  return ENTITY_LABELS[path] ?? path.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
  onClose: () => void;
  onCreated: (result: CreateResult) => void;
}

export function DocumentImportWizard({ onClose, onCreated }: Props) {
  const [step, setStep] = useState<Step>('choose');
  const [caps, setCaps] = useState<ImportCapabilities | null>(null);
  const [capsError, setCapsError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const [report, setReport] = useState<CreateResponse['meta'] | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [showOnlyIncluded, setShowOnlyIncluded] = useState(false);
  const [tagText, setTagText] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .get<ImportCapabilities>('/import/capabilities')
      .then(res => setCaps(res.data))
      .catch(e => setCapsError(e instanceof Error ? e.message : String(e)));
  }, []);

  const accept = useMemo(() => {
    if (!caps) return '';
    return caps.formats.flatMap(f => f.extensions).join(',');
  }, [caps]);

  const reset = () => {
    setDraft(null);
    setAnalysis(null);
    setReport(null);
    setError(null);
    setStep('choose');
    setFile(null);
    if (fileInput.current) fileInput.current.value = '';
  };

  const analyze = async (chosen: File) => {
    setAnalyzing(true);
    setError(null);
    setFile(chosen);
    try {
      const form = new FormData();
      form.append('document', chosen);
      const res = await api.upload<AnalyzeResult>('/import/analyze', form);
      setAnalysis(res.data);
      setDraft(structuredClone(res.data.draft));
      setTagText(res.data.draft.tags.join(', '));
      setStep('review');
    } catch (e) {
      setError(e as Error);
      setStep('choose');
    } finally {
      setAnalyzing(false);
    }
  };

  const updateField = (index: number, patch: Partial<DraftField>) => {
    setDraft(d => (d ? { ...d, project: d.project.map((f, i) => (i === index ? { ...f, ...patch } : f)) } : d));
  };

  const updateRecord = (index: number, patch: Partial<DraftRecord>) => {
    setDraft(d => (d ? { ...d, records: d.records.map((r, i) => (i === index ? { ...r, ...patch } : r)) } : d));
  };

  const updateRecordValue = (index: number, key: string, value: string) => {
    setDraft(d =>
      d ? { ...d, records: d.records.map((r, i) => (i === index ? { ...r, values: { ...r.values, [key]: value } } : r)) } : d
    );
  };

  // Records keep their position for the whole review, so "remove" excludes
  // rather than deletes. Deleting would renumber everything and quietly point
  // every duplicateOf at the wrong record - and would make a removal
  // irreversible on a screen whose whole job is letting you change your mind.
  const excludeRecord = (index: number) => updateRecord(index, { include: false });

  const create = async () => {
    if (!draft) return;
    setCreating(true);
    setError(null);
    try {
      const payload: ImportDraft = {
        ...draft,
        tags: tagText
          .split(',')
          .map(t => t.trim())
          .filter(Boolean)
      };
      const res = await api.post<CreateResult, CreateResponse['meta']>('/import/create', { draft: payload });
      setReport(res.meta ?? null);
      setStep('done');
      onCreated(res.data);
    } catch (e) {
      setError(e as Error);
    } finally {
      setCreating(false);
    }
  };

  // Grouped by entity, but each row keeps the index it has in the draft, which
  // is what every edit is applied through.
  const byEntity = useMemo(() => {
    const groups = new Map<string, { record: DraftRecord; index: number }[]>();
    (draft?.records ?? []).forEach((record, index) => {
      const list = groups.get(record.entity) ?? [];
      list.push({ record, index });
      groups.set(record.entity, list);
    });
    return [...groups.entries()];
  }, [draft]);

  const includedCount = (draft?.records ?? []).filter(r => r.include && r.duplicateOf === undefined).length;
  const duplicateCount = (draft?.records ?? []).filter(r => r.duplicateOf !== undefined).length;
  const nameValue = draft?.project.find(f => f.field === 'name')?.value.trim() ?? '';

  return (
    <Modal
      title="Import from Document"
      onClose={onClose}
      wide
      footer={
        step === 'review' ? (
          <>
            <button className="btn ghost" onClick={reset} disabled={creating}>
              Back
            </button>
            <button className="btn ghost" onClick={onClose} disabled={creating}>
              Reject import
            </button>
            <button className="btn primary" onClick={create} disabled={creating || !nameValue}>
              {creating ? 'Creating…' : `Create project${includedCount ? ` with ${includedCount} records` : ''}`}
            </button>
          </>
        ) : step === 'done' ? (
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        ) : (
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        )
      }
    >
      {step === 'choose' ? (
        <div className="grid" style={{ gap: 14 }}>
          <div className="dim tiny">
            Reads a document and creates a <strong>new project</strong>. Nothing is saved until you have reviewed
            everything on the next step, and no existing project is ever modified.
          </div>

          {capsError ? <div className="tiny" style={{ color: 'var(--red)' }}>{capsError}</div> : null}

          <div
            className="card"
            style={{
              borderStyle: 'dashed',
              textAlign: 'center',
              padding: '28px 16px',
              background: dragOver ? 'var(--bg-hover)' : undefined
            }}
            onDragOver={e => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => {
              e.preventDefault();
              setDragOver(false);
              const dropped = e.dataTransfer.files?.[0];
              if (dropped) void analyze(dropped);
            }}
          >
            <input
              ref={fileInput}
              type="file"
              accept={accept}
              style={{ display: 'none' }}
              onChange={e => {
                const chosen = e.target.files?.[0];
                if (chosen) void analyze(chosen);
              }}
            />
            {analyzing ? (
              <Loading label="Reading the document. Nothing is being saved." />
            ) : (
              <>
                <button className="btn primary" onClick={() => fileInput.current?.click()}>
                  Choose a document
                </button>
                <div className="dim tiny" style={{ marginTop: 8 }}>
                  or drop a file here
                </div>
              </>
            )}
          </div>

          {file && !analyzing ? (
            <div className="dim tiny">
              Last chosen: <span className="mono">{file.name}</span> ({formatBytes(file.size)})
            </div>
          ) : null}

          {caps ? (
            <div className="grid" style={{ gap: 6 }}>
              <div className="tiny dim">Supported formats</div>
              <div className="tiny dim">
                {caps.formats.map(f => (
                  <span key={f.format} title={f.note} style={{ marginRight: 10 }}>
                    <span className="mono">.{f.extensions.join(' / .')}</span>
                    {f.reliable ? '' : ' (best effort)'}
                  </span>
                ))}
              </div>
              <div className="tiny dim">Maximum {formatBytes(caps.maxBytes)} per file. The file itself is not stored.</div>
            </div>
          ) : null}

          {error ? <ErrorPanel error={error} /> : null}
        </div>
      ) : null}

      {step === 'review' && draft && analysis ? (
        <div className="grid" style={{ gap: 16 }}>
          <div className="card grid" style={{ gap: 8 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <strong>{draft.source.filename}</strong>
              <span className="tiny dim">
                {draft.source.format.toUpperCase()} · {formatBytes(draft.source.sizeBytes)} ·{' '}
                {analysis.stats.characters.toLocaleString()} characters · not stored
              </span>
            </div>
            <div className="tiny dim">
              Read on this device, in Project Hub, with no external service. {analysis.counts.projectFields} project
              fields, {analysis.counts.records} records
              {duplicateCount > 0 ? `, ${duplicateCount} duplicate${duplicateCount === 1 ? '' : 's'} held back` : ''}
              {analysis.counts.inferred > 0 ? `, ${analysis.counts.inferred} inferred` : ''}. Nothing is saved yet.
            </div>
            {analysis.warnings.length ? (
              <div className="tiny" style={{ color: 'var(--yellow)' }}>
                {analysis.warnings.join(' · ')}
              </div>
            ) : null}
            {error ? <ErrorPanel error={error} /> : null}
          </div>

          <section className="grid" style={{ gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Project details</h3>
            <div className="grid c2">
              {draft.project.map((f, i) => (
                <FieldEditor key={f.field} field={f} index={i} onChange={updateField} />
              ))}
            </div>
            {analysis.notFound.length ? (
              <div className="tiny dim">
                Not in the document, left empty: {analysis.notFound.map(label).join(', ')}
              </div>
            ) : null}
            <div className="field">
              <label>Tags</label>
              <input value={tagText} onChange={e => setTagText(e.target.value)} placeholder="comma, separated" />
              <span className="hint">Optional. Applied to the new project and to the records below.</span>
            </div>
          </section>

          <section className="grid" style={{ gap: 8 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>Extracted records</h3>
              <label className="tiny dim" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={showOnlyIncluded}
                  onChange={e => setShowOnlyIncluded(e.target.checked)}
                  style={{ width: 'auto' }}
                />
                Hide excluded and duplicates
              </label>
            </div>

            {byEntity.map(([entity, rows]) => {
              const visible = showOnlyIncluded ? rows.filter(r => r.record.include) : rows;
              if (visible.length === 0) return null;
              const kept = rows.filter(r => r.record.include && r.record.duplicateOf === undefined).length;
              return (
                <div key={entity} className="card grid" style={{ gap: 8 }}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <strong>{entityLabel(entity)}</strong>
                    <span className="tiny dim">
                      {kept} of {rows.length} will be created
                    </span>
                  </div>
                  {visible.map(({ record, index }) => (
                    <RecordEditor
                      key={`${entity}-${index}`}
                      record={record}
                      onToggle={v => updateRecord(index, { include: v })}
                      onValue={(k, v) => updateRecordValue(index, k, v)}
                      onRemove={() => excludeRecord(index)}
                    />
                  ))}
                </div>
              );
            })}
          </section>

          {draft.unsupported.length ? (
            <section className="card grid" style={{ gap: 6 }}>
              <strong>Found in the document, not stored</strong>
              <div className="tiny dim">
                Project Hub has no existing structure for these, so nothing was invented to hold them.
              </div>
              {draft.unsupported.map((u, i) => (
                <div key={i} className="tiny dim">
                  <span className="mono">{u.concept}</span>: {u.reason}
                </div>
              ))}
            </section>
          ) : null}
        </div>
      ) : null}

      {step === 'done' ? (
        <div className="grid" style={{ gap: 10 }}>
          <strong>Project created from the document.</strong>
          <div className="tiny dim">
            It was added as a new project. No existing project was changed.
          </div>
          {report && report.unmapped.length ? (
            <div className="card grid" style={{ gap: 6, borderColor: 'var(--yellow)' }}>
              <strong>Not stored, because Project Hub has nowhere to put it</strong>
              {report.unmapped.map((u, i) => (
                <div key={i} className="tiny dim">
                  <span className="mono">
                    {u.where}.{u.key}
                  </span>{' '}
                  = {u.value.slice(0, 60)} — {u.reason}
                </div>
              ))}
            </div>
          ) : null}
          {report && report.skipped.length ? (
            <div className="tiny dim">
              Skipped: {report.skipped.length} item{report.skipped.length === 1 ? '' : 's'} (excluded or duplicate).
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}

function FieldEditor({
  field,
  index,
  onChange
}: {
  field: DraftField;
  index: number;
  onChange: (i: number, patch: Partial<DraftField>) => void;
}) {
  const long = ['description', 'problem', 'expectedValue', 'v1Scope', 'assumptions', 'initialQuestions'].includes(
    field.field
  );
  return (
    <div className="field">
      <label>
        <input
          type="checkbox"
          checked={field.include}
          onChange={e => onChange(index, { include: e.target.checked })}
          style={{ width: 'auto', marginRight: 6 }}
        />
        {label(field.field)}
        {field.provenance === 'inferred' ? <span className="tiny dim"> · inferred</span> : null}
      </label>
      {long ? (
        <textarea
          rows={3}
          value={field.value}
          disabled={!field.include}
          onChange={e => onChange(index, { value: e.target.value })}
        />
      ) : (
        <input value={field.value} disabled={!field.include} onChange={e => onChange(index, { value: e.target.value })} />
      )}
      {field.evidence ? <span className="hint">From: {field.evidence.slice(0, 120)}</span> : null}
    </div>
  );
}

function RecordEditor({
  record,
  onToggle,
  onValue,
  onRemove
}: {
  record: DraftRecord;
  onToggle: (v: boolean) => void;
  onValue: (key: string, value: string) => void;
  onRemove: () => void;
}) {
  const duplicate = record.duplicateOf !== undefined;
  return (
    <div
      className="card"
      style={{
        padding: '8px 10px',
        opacity: record.include && !duplicate ? 1 : 0.55,
        borderColor: duplicate ? 'var(--border)' : undefined
      }}
    >
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <label className="tiny" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={record.include && !duplicate}
            disabled={duplicate}
            onChange={e => onToggle(e.target.checked)}
            style={{ width: 'auto' }}
          />
          {duplicate ? (
            <span className="dim">Duplicate of an earlier item in the same document</span>
          ) : (
            <span className="dim">
              {record.horizon !== 'unscoped' ? HORIZON_LABELS[record.horizon] : 'Unscoped'}
              {record.provenance === 'inferred' ? ' · inferred' : ''}
            </span>
          )}
        </label>
        {record.include || duplicate ? (
          <button className="btn xs ghost" onClick={onRemove} disabled={duplicate} title="Leave this item out of the import">
            Exclude
          </button>
        ) : (
          <button className="btn xs ghost" onClick={() => onToggle(true)} title="Put this item back into the import">
            Restore
          </button>
        )}
      </div>
      <div className="grid c2" style={{ gap: 6 }}>
        {Object.entries(record.values).map(([key, value]) => (
          <div key={key} className="field">
            <label>{label(key)}</label>
            {value.length > 90 ? (
              <textarea rows={2} value={value} disabled={!record.include || duplicate} onChange={e => onValue(key, e.target.value)} />
            ) : (
              <input value={value} disabled={!record.include || duplicate} onChange={e => onValue(key, e.target.value)} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ErrorPanel({ error }: { error: Error }) {
  const api = error instanceof ApiError ? error : null;
  return (
    <div className="card grid" style={{ gap: 4, borderColor: 'var(--red)' }}>
      <strong style={{ color: 'var(--red)' }}>{error.message}</strong>
      {api?.category ? <div className="tiny dim">Category: {api.category}</div> : null}
      {api?.operation ? <div className="tiny dim">While: {api.operation}</div> : null}
      {api?.possibleAction ? <div className="tiny">{api.possibleAction}</div> : null}
    </div>
  );
}
