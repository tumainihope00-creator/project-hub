import { useState, type ReactNode } from 'react';

export function SubTabs({ tabs }: { tabs: { key: string; label: string; render: () => ReactNode }[] }) {
  const [active, setActive] = useState(tabs[0]?.key);
  const current = tabs.find(t => t.key === active) ?? tabs[0];
  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        {tabs.map(t => (
          <button key={t.key} className={'tab' + (t.key === current.key ? ' active' : '')} style={{ border: 'none', background: 'none' }} onClick={() => setActive(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {current?.render()}
    </div>
  );
}