import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { statusColor } from '../lib/status';
import { QuickAdd } from './QuickAdd';

export function Layout() {
  const { projects, tags, reloadProjects, reloadTags } = useApp();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const active = projects.filter(p => !p.isArchived);
  const archived = projects.filter(p => p.isArchived);

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`);
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="brand">
            <span className="dot" />
            Project Hub
            <small>2.0</small>
          </div>
        </div>
        <div className="sidebar-scroll">
          <div style={{ padding: '12px 16px 4px' }}>
            <button className="quickadd-btn" style={{ width: '100%', justifyContent: 'center' }} onClick={() => window.dispatchEvent(new CustomEvent('open-quickadd'))}>
              + Quick Add
              <span className="kbd" style={{ marginLeft: 4 }}>Q</span>
            </button>
          </div>

          <NavLink to="/" end className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
            <span className="ico">▦</span> Dashboard
          </NavLink>
          <NavLink to="/projects" end className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
            <span className="ico">◫</span> Projects
            <span className="count">{active.length}</span>
          </NavLink>
          <NavLink to="/tags" className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
            <span className="ico">#</span> Tags
            <span className="count">{tags.length}</span>
          </NavLink>

          <div className="nav-section">
            <span>Projects</span>
          </div>
          {active.length === 0 ? (
            <div className="nav-item dim" style={{ cursor: 'default' }}>No active projects</div>
          ) : (
            active.map(p => (
              <NavLink key={p.id} to={`/projects/${p.slug}`} className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
                <span className="stage-dot" style={{ background: statusColor(p.stage) }} />
                <span className="name">{p.name}</span>
              </NavLink>
            ))
          )}

          <div className="nav-section">
            <span>Archived</span>
            <button onClick={() => setShowArchived(v => !v)} title={showArchived ? 'Hide' : 'Show'}>
              {showArchived ? '▾' : '▸'}
            </button>
          </div>
          {showArchived &&
            (archived.length === 0 ? (
              <div className="nav-item dim" style={{ cursor: 'default' }}>None</div>
            ) : (
              archived.map(p => (
                <NavLink key={p.id} to={`/projects/${p.slug}`} className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
                  <span className="stage-dot" style={{ background: statusColor(p.stage) }} />
                  <span className="name">{p.name}</span>
                </NavLink>
              ))
            ))}

          <div className="nav-section">Tags</div>
          <div style={{ padding: '2px 16px 8px' }}>
            {tags.length === 0 ? (
              <span className="dim tiny">No tags yet</span>
            ) : (
              <div className="tag-cloud">
                {tags.slice(0, 18).map(t => (
                  <a key={t.id} className="tag" href={`/tags?tag=${encodeURIComponent(t.name)}`}>
                    {t.name}
                    <span className="n">{t.count}</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <form className="search" onSubmit={submitSearch}>
            <span className="icon">⌕</span>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search projects, tasks, prompts, research, issues…" />
          </form>
          <div className="spacer" />
          <button className="btn sm" onClick={() => navigate('/projects?new=1')}>
            + Project
          </button>
        </div>
        <div className="content">
          <Outlet />
        </div>
      </div>

      <QuickAdd onCreated={() => { reloadProjects(); reloadTags(); }} />
    </div>
  );
}