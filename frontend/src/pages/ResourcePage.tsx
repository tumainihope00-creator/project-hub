import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, formatDate, formatDateTime, qs } from '../api/client';
import { useApi, useDebounced } from '../lib/useApi';
import { useProject } from '../context/ProjectContext';
import { useApp } from '../context/AppContext';
import { RESOURCES, humanize, type ColumnDef, type ResourceConfig } from '../resources';
import { Badge, ConfirmButton, EmptyState, ErrorBox, Loading, Modal } from '../components/ui';
import { ResourceForm, type FormValues } from '../components/ResourceForm';
import type { ResourceRow } from '../api/types';

type Row = ResourceRow & { tags?: string[]; [key: string]: unknown };

export function ResourcePage({
  configKey,
  presetFilters,
  title,
  intro,
  renderDetailExtra
}: {
  configKey: string;
  presetFilters?: Record<string, string>;
  title?: string;
  intro?: string;
  renderDetailExtra?: (row: Row) => ReactNode;
}) {
  const config: ResourceConfig = RESOURCES[configKey];
  const { project, reload: reloadProject } = useProject();
  const { tags: globalTags, toast, reloadTags } = useApp();

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 300);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [viewing, setViewing] = useState<Row | null>(null);

  const query = qs({
    q: debouncedSearch || undefined,
    ...presetFilters,
    ...filters,
    page,
    pageSize: 50
  });
  const path = `/projects/${project.id}/${config.path}${query}`;
  const { data, loading, error, reload } = useApi<Row[]>(path);
  const rows = data ?? [];
  const total = rows.length;

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, JSON.stringify(filters)]);

  useEffect(() => {
    const handler = () => reload();
    window.addEventListener('data-changed', handler);
    return () => window.removeEventListener('data-changed', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const tagSuggestions = useMemo(() => globalTags.map(t => t.name), [globalTags]);

  const afterWrite = () => {
    reload();
    reloadProject();
    reloadTags();
  };

  const create = async (values: FormValues, tags: string[]) => {
    await api.post(`/projects/${project.id}/${config.path}`, { ...values, tags });
    toast(`${config.singular} created`);
    setCreating(false);
    afterWrite();
  };

  const update = async (id: number, values: FormValues, tags: string[]) => {
    await api.put(`/projects/${project.id}/${config.path}/${id}`, { ...values, tags });
    toast(`${config.singular} updated`);
    setEditing(null);
    setViewing(null);
    afterWrite();
  };

  const remove = async (id: number) => {
    await api.del(`/projects/${project.id}/${config.path}/${id}`);
    toast(`${config.singular} deleted`);
    setViewing(null);
    afterWrite();
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{title ?? config.label}</h1>
          <div className="sub">{intro ?? `${total} ${total === 1 ? config.singular.toLowerCase() : config.label.toLowerCase()}`}</div>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => setCreating(true)}>
            + New {config.singular}
          </button>
        </div>
      </div>

      <div className="toolbar">
        <input type="text" placeholder={`Search ${config.label.toLowerCase()}…`} value={search} onChange={e => setSearch(e.target.value)} style={{ minWidth: 240 }} />
        {(config.filters ?? []).map(f => (
          <select key={f.name} value={filters[f.name] ?? ''} onChange={e => setFilters(prev => ({ ...prev, [f.name]: e.target.value }))}>
            <option value="">All {f.label.toLowerCase()}</option>
            {(f.options ?? []).map(o => (
              <option key={o} value={o}>
                {humanize(o)}
              </option>
            ))}
          </select>
        ))}
        <div className="spacer" />
        {(Object.values(filters).some(Boolean) || search) && (
          <button
            className="btn sm"
            onClick={() => {
              setFilters({});
              setSearch('');
            }}
          >
            Clear
          </button>
        )}
      </div>

      {error ? <ErrorBox message={error} /> : null}

      <div className="table-wrap">
        {loading && rows.length === 0 ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState title={`No ${config.label.toLowerCase()} yet`} hint={`Click “+ New ${config.singular}” to add the first one.`} />
        ) : (
          <table className="data">
            <thead>
              <tr>
                {config.columns.map(c => (
                  <th key={c.key} style={{ width: c.width }}>
                    {c.label}
                  </th>
                ))}
                <th className="right">Tags</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => setViewing(row)}>
                  {config.columns.map((c, idx) => (
                    <td key={c.key}>
                      {idx === 0 ? (
                        <span style={{ fontWeight: 500 }}>{renderCell(row, c)}</span>
                      ) : (
                        renderCell(row, c)
                      )}
                    </td>
                  ))}
                  <td className="right">
                    {(row.tags ?? []).map(t => (
                      <span className="tag-chip tag" key={t} style={{ marginLeft: 4 }}>
                        {t}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating ? (
        <Modal title={`New ${config.singular}`} onClose={() => setCreating(false)} wide>
          <ResourceForm config={config} projectId={project.id} tagSuggestions={tagSuggestions} submitLabel="Create" onCancel={() => setCreating(false)} onSubmit={create} />
        </Modal>
      ) : null}

      {editing ? (
        <Modal title={`Edit ${config.singular}`} onClose={() => setEditing(null)} wide>
          <ResourceForm
            config={config}
            projectId={project.id}
            initial={editing}
            tagSuggestions={tagSuggestions}
            submitLabel="Save changes"
            onCancel={() => setEditing(null)}
            onSubmit={(values, tags) => update(editing.id, values, tags)}
          />
        </Modal>
      ) : null}

      {viewing ? (
        <Modal
          title={`${config.singular} details`}
          onClose={() => setViewing(null)}
          wide
          footer={
            <>
              <ConfirmButton
                className="btn danger"
                label="Delete"
                confirmLabel="Confirm delete"
                question={`Delete this ${config.singular.toLowerCase()}?`}
                onConfirm={() => remove(viewing.id)}
              />
              <div className="spacer" />
              <button className="btn" onClick={() => setEditing(viewing)}>
                Edit
              </button>
              <button className="btn" onClick={() => setViewing(null)}>
                Close
              </button>
            </>
          }
        >
          <DetailView row={viewing} config={config} extra={renderDetailExtra?.(viewing)} />
        </Modal>
      ) : null}
    </div>
  );
}

export function renderCell(row: Row, c: ColumnDef) {
  const value = row[c.key];
  if (value === null || value === undefined || value === '') return <span className="dim">—</span>;
  switch (c.kind) {
    case 'badge':
      return <Badge value={String(value)} />;
    case 'date':
      return <span className="nowrap">{formatDate(String(value))}</span>;
    case 'datetime':
      return <span className="nowrap">{formatDateTime(String(value))}</span>;
    case 'mono':
      return <span className="mono">{String(value)}</span>;
    case 'number':
      return String(value);
    case 'bool':
      return value ? 'Yes' : 'No';
    case 'percent':
      return `${value}%`;
    default: {
      const s = String(value);
      return s.length > 120 ? s.slice(0, 120) + '…' : s;
    }
  }
}

function DetailView({ row, config, extra }: { row: Row; config: ResourceConfig; extra?: ReactNode }) {
  const fields = config.fields.filter(f => f.type !== 'tags');
  return (
    <div>
      <dl className="kv">
        {fields.map(f => {
          const value = row[f.name];
          if (value === null || value === undefined || value === '') return null;
          const isLong = f.type === 'textarea' || (typeof value === 'string' && value.length > 80);
          return (
            <div key={f.name} style={{ display: 'contents' }}>
              <dt>{f.label}</dt>
              <dd>
                {f.type === 'select' ? (
                  <Badge value={String(value)} />
                ) : isLong ? (
                  <pre className="content-block">{typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}</pre>
                ) : (
                  String(value)
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {row.tags && row.tags.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          {(row.tags as string[]).map(t => (
            <span className="tag-chip tag" key={t} style={{ marginRight: 6 }}>
              {t}
            </span>
          ))}
        </div>
      ) : null}
      {extra}
      <div className="dim tiny" style={{ marginTop: 14 }}>
        Created {formatDateTime(String(row.createdAt))} · Updated {formatDateTime(String(row.updatedAt))}
      </div>
    </div>
  );
}