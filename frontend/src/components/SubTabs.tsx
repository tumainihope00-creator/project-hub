import { type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Inline tab switcher for pages with two or three sub-views (e.g. Research →
 * Questions / Sessions). The active tab is mirrored to `?view=<key>` so a
 * refresh or a shared URL keeps the same view open. The first tab is the
 * default and is represented by *no* query string.
 */
export function SubTabs({ tabs }: { tabs: { key: string; label: string; render: () => ReactNode }[] }) {
  const [params, setParams] = useSearchParams();
  const view = params.get('view');
  const active = tabs.some(t => t.key === view) ? (view as string) : tabs[0]?.key;
  const current = tabs.find(t => t.key === active) ?? tabs[0];

  const select = (key: string) => {
    const next = new URLSearchParams(params);
    if (key === tabs[0]?.key) next.delete('view');
    else next.set('view', key);
    setParams(next, { replace: true });
  };

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        {tabs.map(t => (
          <button key={t.key} className={'tab' + (t.key === current.key ? ' active' : '')} style={{ border: 'none', background: 'none' }} onClick={() => select(t.key)} aria-pressed={t.key === current.key}>
            {t.label}
          </button>
        ))}
      </div>
      {current?.render()}
    </div>
  );
}