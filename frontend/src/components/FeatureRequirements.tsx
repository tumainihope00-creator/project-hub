import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useApi } from '../lib/useApi';
import { useApp } from '../context/AppContext';
import { Badge, ErrorBox, Spinner } from './ui';
import type { ResourceRow } from '../api/types';

type Requirement = ResourceRow & { id: number; code?: string; title?: string; status?: string };

export function FeatureRequirements({ projectId, featureId }: { projectId: number; featureId: number }) {
  const { toast } = useApp();
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);

  const linkedPath = `/projects/${projectId}/features/${featureId}/requirements`;
  const { data: linked, loading, error, reload } = useApi<Requirement[]>(linkedPath);
  const { data: all } = useApi<Requirement[]>(`/projects/${projectId}/requirements?pageSize=500`);

  useEffect(() => {
    const handler = () => reload();
    window.addEventListener('data-changed', handler);
    return () => window.removeEventListener('data-changed', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedPath]);

  const linkedIds = useMemo(() => new Set((linked ?? []).map(r => r.id)), [linked]);
  const options = useMemo(() => (all ?? []).filter(r => !linkedIds.has(r.id)), [all, linkedIds]);

  const add = async () => {
    const requirementId = Number(selected);
    if (!requirementId) return;
    setBusy(true);
    try {
      await api.post(linkedPath, { requirementId });
      setSelected('');
      toast('Requirement linked');
      reload();
      window.dispatchEvent(new Event('data-changed'));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (requirementId: number) => {
    setBusy(true);
    try {
      await api.del(`${linkedPath}/${requirementId}`);
      toast('Requirement unlinked');
      reload();
      window.dispatchEvent(new Event('data-changed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 16 }}>
      <div className="section-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        Linked requirements
        {loading ? <Spinner /> : <span className="dim tiny">{(linked ?? []).length}</span>}
      </div>
      {error ? <ErrorBox message={error} /> : null}

      {(linked ?? []).length === 0 && !loading ? (
        <div className="dim tiny" style={{ margin: '6px 0' }}>
          No requirements linked yet.
        </div>
      ) : (
        <div style={{ margin: '6px 0', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {(linked ?? []).map(r => (
            <span key={r.id} className="tag-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {r.code ? <span className="mono">{r.code}</span> : null}
              <span>{r.title ?? `Requirement #${r.id}`}</span>
              {r.status ? <Badge value={String(r.status)} /> : null}
              <button className="btn xs ghost" disabled={busy} title="Unlink" onClick={() => unlink(r.id)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <select value={selected} onChange={e => setSelected(e.target.value)} style={{ flex: 1 }}>
          <option value="">Link a requirement…</option>
          {options.map(r => (
            <option key={r.id} value={r.id}>
              {r.code ? `${r.code} — ` : ''}
              {r.title ?? `Requirement #${r.id}`}
            </option>
          ))}
        </select>
        <button className="btn" disabled={!selected || busy} onClick={add}>
          Link
        </button>
      </div>
    </div>
  );
}
