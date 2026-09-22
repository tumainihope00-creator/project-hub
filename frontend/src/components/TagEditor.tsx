import { useState } from 'react';

export function TagEditor({
  tags,
  onChange,
  suggestions = []
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
}) {
  const [input, setInput] = useState('');
  const [focused, setFocused] = useState(false);

  const add = (raw: string) => {
    const value = raw.trim().toLowerCase();
    if (!value) return;
    if (!tags.includes(value)) onChange([...tags, value]);
    setInput('');
  };

  const remove = (tag: string) => onChange(tags.filter(t => t !== tag));

  const filtered = suggestions
    .filter(s => !tags.includes(s) && s.includes(input.trim().toLowerCase()))
    .slice(0, 8);

  return (
    <div className="tag-editor">
      {tags.map(t => (
        <span className="tag-chip tag" key={t}>
          {t}
          <button type="button" onClick={() => remove(t)} aria-label={`Remove ${t}`}>
            ×
          </button>
        </span>
      ))}
      <span style={{ position: 'relative' }}>
        <input
          className="tag-input"
          value={input}
          placeholder="add tag…"
          onChange={e => setInput(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add(input);
            } else if (e.key === 'Backspace' && !input && tags.length) {
              remove(tags[tags.length - 1]);
            }
          }}
        />
        {focused && filtered.length > 0 ? (
          <div
            style={{
              position: 'absolute',
              top: '110%',
              left: 0,
              zIndex: 20,
              background: 'var(--bg-elev-2)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              minWidth: '160px',
              boxShadow: '0 8px 24px rgba(0,0,0,.5)'
            }}
          >
            {filtered.map(s => (
              <div
                key={s}
                style={{ padding: '4px 10px', cursor: 'pointer' }}
                onMouseDown={e => {
                  e.preventDefault();
                  add(s);
                }}
              >
                {s}
              </div>
            ))}
          </div>
        ) : null}
      </span>
    </div>
  );
}