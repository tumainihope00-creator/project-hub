import { useEffect, useMemo, useState } from 'react';
import type { FieldDef, ResourceConfig } from '../resources';
import { api } from '../api/client';
import { TagEditor } from './TagEditor';

export type FormValues = Record<string, unknown>;

function initialValue(field: FieldDef, initial?: FormValues): unknown {
  const raw = initial?.[field.name];
  if (raw === undefined || raw === null) return '';
  if (field.type === 'date') {
    const s = String(raw);
    return s.length >= 10 ? s.slice(0, 10) : s;
  }
  if (field.type === 'relation') {
    return String(raw);
  }
  if (field.type === 'textarea' && typeof raw === 'object') {
    return JSON.stringify(raw, null, 2);
  }
  return raw as unknown;
}

export function ResourceForm({
  config,
  projectId,
  initial,
  onSubmit,
  onCancel,
  submitLabel = 'Save',
  tagSuggestions = []
}: {
  config: ResourceConfig;
  projectId: number;
  initial?: FormValues;
  onSubmit: (values: FormValues, tags: string[]) => Promise<void> | void;
  onCancel: () => void;
  submitLabel?: string;
  tagSuggestions?: string[];
}) {
  const [values, setValues] = useState<FormValues>(() => {
    const v: FormValues = {};
    for (const f of config.fields) {
      if (f.type === 'tags') continue;
      v[f.name] = initialValue(f, initial);
    }
    return v;
  });
  const [tags, setTags] = useState<string[]>(Array.isArray(initial?.tags) ? (initial!.tags as string[]) : []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<Record<string, { id: number; label: string }[]>>({});

  const relationFields = useMemo(() => config.fields.filter(f => f.type === 'relation'), [config]);

  useEffect(() => {
    let cancelled = false;
    for (const f of relationFields) {
      const rel = f.relation!;
      api
        .get<Record<string, unknown>[]>(`/projects/${projectId}/${rel.resource}?pageSize=200`)
        .then(res => {
          if (cancelled) return;
          const rows = Array.isArray(res.data) ? res.data : [];
          setOptions(prev => ({
            ...prev,
            [f.name]: rows
              .filter(r => r.id !== initial?.id)
              .map(r => ({
                id: Number(r[rel.valueKey ?? 'id']),
                label: rel.resource === 'development-sessions' ? `#${r[rel.labelKey] ?? r.id}` : String(r[rel.labelKey] ?? `#${r.id}`)
              }))
          }));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, config.path]);

  const set = (name: string, value: unknown) => setValues(prev => ({ ...prev, [name]: value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    for (const f of config.fields) {
      if (f.required && (values[f.name] === '' || values[f.name] === undefined || values[f.name] === null)) {
        setError(`${f.label} is required`);
        return;
      }
    }
    const payload: FormValues = {};
    for (const f of config.fields) {
      if (f.type === 'tags') continue;
      let v = values[f.name];
      if (v === '' || v === undefined) {
        if (!(initial && f.name === 'code')) continue;
        if (v === '') continue;
      }
      if (f.type === 'number' && v !== '' && v !== undefined) v = Number(v);
      if (f.type === 'relation') v = v === '' ? null : Number(v);
      payload[f.name] = v;
    }
    try {
      setSaving(true);
      await onSubmit(payload, tags);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        {config.fields.map(f => {
          if (f.type === 'tags') {
            return (
              <div className="field full" key={f.name}>
                <label>{f.label}</label>
                <TagEditor tags={tags} onChange={setTags} suggestions={tagSuggestions} />
              </div>
            );
          }
          const common = {
            id: `field-${f.name}`,
            value: (values[f.name] as string | number) ?? '',
            required: f.required,
            placeholder: f.placeholder
          };
          return (
            <div className={'field' + (f.type === 'textarea' ? ' full' : '')} key={f.name}>
              <label htmlFor={`field-${f.name}`}>
                {f.label}
                {f.required ? <span style={{ color: 'var(--red)' }}> *</span> : null}
              </label>
              {f.type === 'textarea' ? (
                <textarea {...common} rows={f.rows ?? 3} value={String(values[f.name] ?? '')} onChange={e => set(f.name, e.target.value)} />
              ) : f.type === 'select' ? (
                <select value={String(values[f.name] ?? '')} onChange={e => set(f.name, e.target.value)}>
                  <option value="">—</option>
                  {(f.options ?? []).map(o => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : f.type === 'relation' ? (
                <select value={String(values[f.name] ?? '')} onChange={e => set(f.name, e.target.value)}>
                  <option value="">—</option>
                  {(options[f.name] ?? []).map(o => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  {...common}
                  type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'url' ? 'url' : 'text'}
                  onChange={e => set(f.name, e.target.value)}
                />
              )}
              {f.help ? <span className="hint">{f.help}</span> : null}
            </div>
          );
        })}
      </div>
      {error ? <div style={{ color: 'var(--red)', marginTop: 12 }}>{error}</div> : null}
      <div className="modal-foot" style={{ paddingRight: 0, paddingBottom: 0, border: 'none', marginTop: 16 }}>
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={saving}>
          {saving ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}