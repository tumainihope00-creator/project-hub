import React, { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Bell,
  Bug,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Code,
  FileText,
  Folder,
  FolderKanban,
  LayoutDashboard,
  Maximize2,
  Menu,
  Microscope,
  Minimize2,
  Plus,
  Rocket,
  Scale,
  Search,
  Settings,
  Sparkles,
  Star,
  StickyNote,
  SunMoon,
  Tag as TagIcon,
  ListTodo
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { statusColor } from '../lib/status';
import { api } from '../api/client';
import { useApi, useDebounced } from '../lib/useApi';
import { currentTheme, THEMES, applyTheme } from '../lib/theme';
import type { NextAction } from '../api/types';
import { GROUP_LABELS } from '../pages/SearchPage';
import { QuickAdd } from './QuickAdd';

interface SuggestItem {
  id: number;
  type: string;
  title: string;
  subtitle?: string | null;
  project?: { id: number; name: string; slug: string };
  url: string;
  stage?: string;
}

const GROUP_ICON: Record<string, React.ElementType> = {
  projects: FolderKanban,
  requirements: ClipboardList,
  features: Star,
  tasks: ListTodo,
  issues: Bug,
  research: Microscope,
  prompts: Sparkles,
  decisions: Scale,
  developmentSessions: Code,
  documents: FileText,
  notes: StickyNote,
  deployments: Rocket
};

const MAX_SUGGESTIONS = 9;

export function Layout() {
  const { projects, tags, reloadProjects, reloadTags, openQuickAdd } = useApp();
  const navigate = useNavigate();
  const location = useLocation();

  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  // search suggestions
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<{ label: string; key: string; items: SuggestItem[] }[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);

  // topbar popovers: 'bell' | 'theme'
  const [pop, setPop] = useState<'bell' | 'theme' | null>(null);
  const [theme, setThemeState] = useState(currentTheme());
  const [fullscreen, setFullscreen] = useState(false);

  const { data: nextActions, loading: loadingActions } = useApi<NextAction[]>('/dashboard/next-actions');

  const active = projects.filter(p => !p.isArchived);
  const archived = projects.filter(p => p.isArchived);

  /* Derived — real numbers only, summed from loaded project stats. */
  const snapshot = useMemo(() => {
    let openTasks = 0;
    let openBugs = 0;
    let prompts = 0;
    for (const p of projects) {
      openTasks += p.stats?.tasksOpen ?? 0;
      openBugs += p.stats?.issuesOpen ?? 0;
      prompts += p.stats?.prompts ?? 0;
    }
    return { activeProjects: active.length, openTasks, openBugs, prompts };
  }, [projects, active.length]);

  const dateLabel = useMemo(
    () => new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
    []
  );

  /* Suggestions: debounced 250ms, cancelled on rapid retype. */
  const debouncedQ = useDebounced(q, 250);
  useEffect(() => {
    const term = debouncedQ.trim();
    if (!term) {
      setSuggestions([]);
      setActiveIdx(-1);
      return;
    }
    let cancelled = false;
    api
      .get<Record<string, SuggestItem[]>>(`/search?q=${encodeURIComponent(term)}`)
      .then(res => {
        if (cancelled) return;
        const groups: { label: string; key: string; items: SuggestItem[] }[] = [];
        let total = 0;
        for (const [key, items] of Object.entries(res.data ?? {})) {
          if (!items?.length || total >= MAX_SUGGESTIONS) continue;
          const take = items.slice(0, MAX_SUGGESTIONS - total);
          groups.push({ key, label: GROUP_LABELS[key] ?? key, items: take });
          total += take.length;
        }
        setSuggestions(groups);
        setActiveIdx(-1);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQ]);

  const flatSuggestions = useMemo(() => suggestions.flatMap(g => g.items), [suggestions]);
  const term = q.trim();
  const waiting = term !== '' && term !== debouncedQ.trim();
  const showSuggest = suggestOpen && term !== '';

  /* Close transient UI on navigation. */
  useEffect(() => {
    setNavOpen(false);
    setPop(null);
    setSuggestOpen(false);
    setActiveIdx(-1);
  }, [location.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPop(null);
        setSuggestOpen(false);
      }
    };
    const onFsChange = () => setFullscreen(!!document.fullscreenElement);
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFsChange);
    };
  }, []);

  const goSuggest = (item: SuggestItem) => {
    navigate(item.url);
    setQ('');
    setSuggestOpen(false);
    setActiveIdx(-1);
  };

  const submitSearch = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!term) return;
    navigate(`/search?q=${encodeURIComponent(term)}`);
    setQ('');
    setSuggestOpen(false);
    setActiveIdx(-1);
  };

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const count = flatSuggestions.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSuggestOpen(true);
      setActiveIdx(i => (i + 1) % (count + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => (i - 1 + count + 1) % (count + 1));
    } else if (e.key === 'Enter') {
      if (suggestOpen && activeIdx >= 0 && activeIdx < count) {
        e.preventDefault();
        goSuggest(flatSuggestions[activeIdx]);
      } else if (suggestOpen && activeIdx === count) {
        e.preventDefault();
        submitSearch();
      }
      // otherwise: native form submit → submitSearch
    } else if (e.key === 'Escape') {
      setSuggestOpen(false);
      setActiveIdx(-1);
    }
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => undefined);
    else document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  const slugOf = (projectId: number) => projects.find(p => p.id === projectId)?.slug;
  const nextCount = nextActions?.length ?? 0;

  /* Keyboard highlight offsets per group, computed once per render. */
  let flatOffset = 0;
  const groupOffsets = suggestions.map(g => {
    const start = flatOffset;
    flatOffset += g.items.length;
    return start;
  });

  const suggestionBody = waiting ? (
    <div className="pop-empty">Searching…</div>
  ) : flatSuggestions.length === 0 ? (
    <div className="pop-empty">No matches for “{term}”</div>
  ) : (
    <>
      {suggestions.map((g, gi) => {
        const Icon = Folder;
        const start = groupOffsets[gi];
        return (
          <React.Fragment key={g.key}>
            <div className="suggest-group">{g.label}</div>
            {g.items.map((item, ii) => {
              const GIcon = GROUP_ICON[g.key] ?? Icon;
              const idx = start + ii;
              return (
                <div
                  key={`${g.key}-${item.id}`}
                  className={'suggest-item' + (activeIdx === idx ? ' active' : '')}
                  role="option"
                  aria-selected={activeIdx === idx}
                  onMouseDown={e => {
                    e.preventDefault();
                    goSuggest(item);
                  }}
                  onMouseEnter={() => setActiveIdx(idx)}
                >
                  <GIcon />
                  <span className="s-title">{item.title}</span>
                  {item.project && g.key !== 'projects' ? <span className="s-sub">{item.project.name}</span> : null}
                </div>
              );
            })}
          </React.Fragment>
        );
      })}
      <div className={'suggest-item all' + (activeIdx === flatSuggestions.length ? ' active' : '')} onMouseDown={e => { e.preventDefault(); submitSearch(); }} onMouseEnter={() => setActiveIdx(flatSuggestions.length)}>
        <Search />
        See all results for “{term}”
        <span className="s-sub">Enter</span>
      </div>
    </>
  );

  return (
    <div className={'app' + (navOpen ? ' nav-open' : '')}>
      <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} />

      <aside className="sidebar">
        <div className="sidebar-head">
          <Link to="/" className="brand">
            <span className="brand-mark">
              <FolderKanban size={15} />
            </span>
            Project Hub <small>2.0</small>
          </Link>
        </div>
        <div className="sidebar-scroll">
          <div style={{ padding: '12px 16px 4px' }}>
            <button
              className="quickadd-btn"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={() => openQuickAdd()}
            >
              <Plus size={15} />
              Quick Add
              <span className="kbd">Q</span>
            </button>
          </div>

          <NavLink to="/" end className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
            <LayoutDashboard /> Dashboard
          </NavLink>
          <NavLink to="/projects" end className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
            <FolderKanban /> Projects
            <span className="count">{active.length}</span>
          </NavLink>
          <NavLink to="/tags" className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
            <TagIcon /> Tags
            <span className="count">{tags.length}</span>
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
            <Settings /> Settings
          </NavLink>

          <div className="nav-section">
            <span>Projects</span>
          </div>
          {active.length === 0 ? (
            <div className="nav-item dim">No active projects</div>
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
            <button onClick={() => setShowArchived(v => !v)} title={showArchived ? 'Hide' : 'Show'} aria-expanded={showArchived}>
              {showArchived ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </button>
          </div>
          {showArchived &&
            (archived.length === 0 ? (
              <div className="nav-item dim">None</div>
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
                  <Link key={t.id} className="tag" to={`/tags?tag=${encodeURIComponent(t.name)}`}>
                    {t.name}
                    <span className="n">{t.count}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="sidebar-snapshot">
          <div className="snap-title">Workspace snapshot</div>
          <div className="snap-grid">
            <div>
              <div className="snap-v">{snapshot.activeProjects}</div>
              <div className="snap-k">Active projects</div>
            </div>
            <div>
              <div className="snap-v">{snapshot.openTasks}</div>
              <div className="snap-k">Open tasks</div>
            </div>
            <div>
              <div className="snap-v">{snapshot.openBugs}</div>
              <div className="snap-k">Open bugs</div>
            </div>
            <div>
              <div className="snap-v">{snapshot.prompts}</div>
              <div className="snap-k">AI prompts</div>
            </div>
          </div>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <button className="icon-btn hamburger" onClick={() => setNavOpen(v => !v)} aria-label="Toggle navigation">
            <Menu />
          </button>

          <div className="search">
            <div className="search-box">
              <Search />
              <input
                value={q}
                onChange={e => {
                  setQ(e.target.value);
                  setSuggestOpen(true);
                }}
                onFocus={() => setSuggestOpen(true)}
                onKeyDown={onSearchKey}
                placeholder="Search projects, tasks, prompts…"
                aria-label="Search"
                aria-expanded={showSuggest}
                autoComplete="off"
              />
            </div>
            {showSuggest ? <div className="suggest-pop">{suggestionBody}</div> : null}
          </div>

          <div className="spacer" />

          <span className="chip">
            <CalendarDays />
            {dateLabel}
          </span>

          <div className="pop-wrap">
            <button
              className="icon-btn"
              onClick={() => setPop(p => (p === 'bell' ? null : 'bell'))}
              aria-label={`Next actions${nextCount ? ` (${nextCount})` : ''}`}
              aria-expanded={pop === 'bell'}
            >
              <Bell />
              {nextCount > 0 ? <span className="dot-badge">{nextCount > 9 ? '9+' : nextCount}</span> : null}
            </button>
            {pop === 'bell' ? (
              <div className="pop">
                <div className="pop-title">Next actions</div>
                {loadingActions && !nextActions ? (
                  <div className="pop-empty">Loading…</div>
                ) : nextCount === 0 ? (
                  <div className="pop-empty">You’re all caught up</div>
                ) : (
                  nextActions!.map((a, i) => {
                    // Backend resolves both slug and numeric id; prefer the slug.
                    const target = `/projects/${slugOf(a.projectId) ?? a.projectId}`;
                    return (
                      <Link key={i} className="pop-item" to={target} onClick={() => setPop(null)}>
                        <ArrowRight />
                        <span>
                          {a.text}
                          <div className="pi-sub">{a.projectName}</div>
                        </span>
                      </Link>
                    );
                  })
                )}
              </div>
            ) : null}
          </div>

          <button
            className="icon-btn"
            onClick={() => navigate('/settings')}
            aria-label="Settings"
            title="Settings"
          >
            <Settings />
          </button>

          <button
            className="icon-btn"
            onClick={toggleFullscreen}
            aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {fullscreen ? <Minimize2 /> : <Maximize2 />}
          </button>

          <div className="user-chip" title="Signed in locally">
            <span className="avatar">Y</span>
            <span>
              <div className="u-name">You</div>
              <div className="u-role">Owner</div>
            </span>
          </div>

          <div className="pop-wrap theme-wrap">
            <button
              className="icon-btn"
              onClick={() => setPop(p => (p === 'theme' ? null : 'theme'))}
              aria-label="Switch theme"
              aria-expanded={pop === 'theme'}
            >
              <SunMoon />
            </button>
            {pop === 'theme' ? (
              <div className="pop">
                <div className="pop-title">Theme</div>
                {THEMES.map(t => (
                  <button
                    key={t.id}
                    className={'theme-opt' + (theme === t.id ? ' on' : '')}
                    onClick={() => {
                      applyTheme(t.id);
                      setThemeState(t.id);
                      setPop(null);
                    }}
                  >
                    <span className="swatches">
                      {t.swatches.map((c, ci) => (
                        <span key={ci} className="sw" style={{ background: c }} />
                      ))}
                    </span>
                    {t.label}
                    {theme === t.id ? <Check className="tick" /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className="content">
          <Outlet />
        </div>
      </div>

      {pop ? <button className="pop-dismiss" aria-label="Close menu" onClick={() => setPop(null)} /> : null}

      <QuickAdd onCreated={() => {
        reloadProjects();
        reloadTags();
      }} />
    </div>
  );
}
