import React, { memo, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import { Bug, CheckCircle2, FolderKanban, ListTodo, Scale, Sparkles } from 'lucide-react';
import { useApi } from '../lib/useApi';
import { useApp } from '../context/AppContext';
import type { DashboardData, NextAction } from '../api/types';
import { api } from '../api/client';
import { statusColor } from '../lib/status';
import { EmptyState, Loading, StageBadge, TimeAgo } from '../components/ui';
import { DocumentChangePanel } from '../components/DocumentChangePanel';
import { humanize } from '../resources';

/* ------------------------------------------------------------------ KPI --- */

type KpiKind = 1 | 2 | 3 | 4 | 5 | 6;

function KpiCard({
  k,
  icon: Icon,
  label,
  value,
  hint,
  pill,
  spark
}: {
  k: KpiKind;
  icon: React.ElementType;
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  pill?: React.ReactNode;
  spark?: number[] | null;
}) {
  return (
    <div className={`kpi k${k}`}>
      <div className="kpi-top">
        <span className="kpi-label">{label}</span>
        <span className="kpi-ico">
          <Icon />
        </span>
      </div>
      <div className="kpi-val">{value}</div>
      <div className="kpi-foot">
        <span className="kpi-hint">{hint ?? ' '}</span>
        {pill ? <span className="kpi-pill">{pill}</span> : null}
      </div>
      {spark && spark.length >= 2 ? (
        <div className="kpi-spark">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={spark.map((v, i) => ({ i, v }))} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
              <Area type="monotone" dataKey="v" stroke="#ffffff" strokeWidth={1.5} fill="rgba(255,255,255,0.3)" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- Charts --- */

function ChartTip({ active, payload, label }: { active?: boolean; payload?: any[]; label?: string | number }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      {label !== undefined ? (
        <div className="tiny dim">{typeof label === 'number' ? `#${label}` : String(label)}</div>
      ) : null}
      {payload.map((p, i) => (
        <div key={i}>
          {humanize(String(p.name ?? p.dataKey))}: <strong>{p.value}</strong>
        </div>
      ))}
    </div>
  );
}

const ChartTipMemo = memo(ChartTip);

const ActivityChart = memo(function ActivityChart({ series }: { series: { date: string; count: number }[] | null }) {
  if (!series || series.length === 0) return <div className="chart-empty">No activity yet</div>;
  return (
    <div className="chart-box">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: -22 }}>
          <defs>
            <linearGradient id="kpiActivityFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.32} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} minTickGap={28} />
          <YAxis allowDecimals={false} width={36} />
          <Tooltip content={<ChartTipMemo />} />
          <Area type="monotone" dataKey="count" stroke="var(--accent)" strokeWidth={2} fill="url(#kpiActivityFill)" isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
});

const StageDonut = memo(function StageDonut({ entries }: { entries: [string, number][] }) {
  const total = entries.reduce((a, [, n]) => a + n, 0);
  if (entries.length === 0) return <div className="chart-empty">No projects yet</div>;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: '100%', minHeight: 190 }}>
      <div className="chart-box short" style={{ flex: '0 0 46%', minWidth: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={entries.map(([stage, n]) => ({ name: stage, value: n }))} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="86%" paddingAngle={2} stroke="none" isAnimationActive={false}>
              {entries.map(([stage]) => (
                <Cell key={stage} fill={statusColor(stage)} />
              ))}
            </Pie>
            <Tooltip content={<ChartTipMemo />} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="donut-legend" style={{ flex: 1, minWidth: 0 }}>
        {entries.slice(0, 8).map(([stage, count]) => (
          <div className="dl-row" key={stage}>
            <span className="dl-swatch" style={{ background: statusColor(stage) }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{humanize(stage)}</span>
            <span className="dl-val">{count}</span>
          </div>
        ))}
        {entries.length > 8 ? <div className="tiny dim">and {entries.length - 8} more</div> : null}
        <div className="dl-row" style={{ marginTop: 6, borderTop: '1px solid var(--border)' }} />
        <div className="dl-row">
          <strong>Total</strong>
          <span className="dl-val">{total}</span>
        </div>
      </div>
    </div>
  );
});

const TaskBars = memo(function TaskBars({ entries }: { entries: [string, number][] }) {
  if (entries.length === 0) return <div className="chart-empty">No tasks yet</div>;
  const data = entries.map(([status, count]) => ({ name: status, count }));
  return (
    <div className="chart-box">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -22 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="name" tickFormatter={(s: string) => s.slice(0, 3)} />
          <YAxis allowDecimals={false} width={36} />
          <Tooltip content={<ChartTipMemo />} cursor={{ fill: 'var(--surface-hover)' }} />
          <Bar dataKey="count" radius={[5, 5, 0, 0]} isAnimationActive={false}>
            {entries.map(([status]) => (
              <Cell key={status} fill={statusColor(status)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
});

/* ------------------------------------------------------------- Dashboard -- */

export function Dashboard() {
  const { data, loading } = useApi<DashboardData>('/dashboard');
  const { data: nextActions } = useApi<NextAction[]>('/dashboard/next-actions');
  const { projects } = useApp();
  const navigate = useNavigate();

  const [promptSpark, setPromptSpark] = useState<number[] | null>(null);
  const [pendingDecisions, setPendingDecisions] = useState<number | null>(null);

  /* KPI 4 sparkline: prompt creation over the last 14 days, from the global
     prompt list (non-archived only). Shape only — the value stays honest. */
  useEffect(() => {
    let cancelled = false;
    api
      .get<{ createdAt: string }[]>('/prompts?limit=200')
      .then(res => {
        if (cancelled) return;
        const evs = res.data ?? [];
        if (evs.length === 0) {
          setPromptSpark(null);
          return;
        }
        const days = new Array(14).fill(0) as number[];
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        for (const ev of evs) {
          const d = new Date(ev.createdAt);
          d.setHours(0, 0, 0, 0);
          const diff = Math.round((today.getTime() - d.getTime()) / 86400000);
          if (diff >= 0 && diff < 14) days[13 - diff] += 1;
        }
        setPromptSpark(days);
      })
      .catch(() => {
        if (!cancelled) setPromptSpark(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* KPI 6: pending ADR proposals, one cheap pageSize=1 probe per active
     project reading meta.total. Falls back to 0 when nothing to probe. */
  useEffect(() => {
    const targets = projects.filter(p => !p.isArchived);
    if (targets.length === 0) {
      setPendingDecisions(0);
      return;
    }
    let cancelled = false;
    Promise.all(
      targets.map(p =>
        api
          .get<unknown>(`/projects/${p.id}/decisions?status=PROPOSED&pageSize=1`)
          .then(r => r.meta?.total ?? 0)
          .catch(() => 0)
      )
    ).then(counts => {
      if (!cancelled) setPendingDecisions(counts.reduce((a, b) => a + b, 0));
    });
    return () => {
      cancelled = true;
    };
  }, [projects]);

  /* Chart datasets, stable per fetch so memoized charts don't redraw. */
  const activitySeries = useMemo(() => {
    const evs = data?.recentActivity ?? [];
    if (evs.length === 0) return null;
    const start = evs[evs.length - 1].createdAt.slice(0, 10);
    const end = evs[0].createdAt.slice(0, 10);
    const days: string[] = [];
    const cur = new Date(`${start}T00:00:00`);
    const last = new Date(`${end}T00:00:00`);
    while (cur <= last) {
      days.push(cur.toISOString().slice(0, 10));
      cur.setDate(cur.getDate() + 1);
    }
    const counts: Record<string, number> = {};
    for (const ev of evs) counts[ev.createdAt.slice(0, 10)] = (counts[ev.createdAt.slice(0, 10)] ?? 0) + 1;
    return days.map(d => ({ date: d, count: counts[d] ?? 0 }));
  }, [data]);

  const stageEntries = useMemo(() => Object.entries(data?.byStage ?? {}).sort((a, b) => b[1] - a[1]), [data]);
  const taskEntries = useMemo(() => Object.entries(data?.tasksByStatus ?? {}), [data]);

  const openTasks = useMemo(() => {
    if (!data) return 0;
    return (
      data.totals.tasks -
      (data.tasksByStatus['COMPLETED'] ?? 0) -
      (data.tasksByStatus['CANCELLED'] ?? 0)
    );
  }, [data]);

  const promptsTotal = useMemo(() => projects.reduce((a, p) => a + (p.stats?.prompts ?? 0), 0), [projects]);
  const activeProjects = useMemo(() => projects.filter(p => !p.isArchived), [projects]);
  const inProgress = data?.tasksByStatus['IN_PROGRESS'] ?? 0;
  const todo = data?.tasksByStatus['TODO'] ?? 0;

  const slugOf = (id: number) => projects.find(p => p.id === id)?.slug;

  if (loading && !data) return <div className="page"><Loading /></div>;
  if (!data) return <div className="page"><EmptyState title="Nothing to show yet" /></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <div className="sub">Everything across your projects, in one place.</div>
        </div>
        <div className="actions">
          <Link to="/projects?new=1" className="btn primary">
            + New Project
          </Link>
        </div>
      </div>

      {activeProjects.length === 0 ? (
        <div className="alert-card" style={{ marginBottom: 16 }}>
          <div className="ac-head">
            <Sparkles size={15} />
            Your workspace is ready
          </div>
          <div className="ac-body">
            There are no active projects yet. Create one from an idea or note, and it will appear here with its own
            monitoring, AI prompts, decisions and documents.
          </div>
        </div>
      ) : null}

      <div className="kpi-grid">
        <KpiCard k={1} icon={FolderKanban} label="Active projects" value={data.totals.active} hint={`${data.totals.archived} archived`} pill="live" />
        <KpiCard k={2} icon={ListTodo} label="Open tasks" value={openTasks} hint={`${inProgress} in progress · ${todo} to do`} />
        <KpiCard k={3} icon={Bug} label="Open bugs" value={data.totals.openIssues} hint="issues & problems in flight" />
        <KpiCard k={4} icon={Sparkles} label="AI prompts" value={promptsTotal} hint={`across ${activeProjects.length} project${activeProjects.length === 1 ? '' : 's'}`} pill="library" spark={promptSpark} />
        <KpiCard k={5} icon={CheckCircle2} label="Tasks completed" value={data.tasksByStatus['COMPLETED'] ?? 0} hint="across all time" pill="done" />
        <KpiCard k={6} icon={Scale} label="Decisions & ADRs" value={pendingDecisions ?? 0} hint="ADR proposals still pending" pill="ADR" />
      </div>

      <div className="grid c2" style={{ marginTop: 16 }}>
        <div className="card chart-card">
          <div className="chart-head">
            <div>
              <div className="chart-title">Activity</div>
              <div className="chart-sub">Events across all projects · most recent 15</div>
            </div>
          </div>
          <ActivityChart series={activitySeries} />
        </div>
        <div className="card chart-card">
          <div className="chart-head">
            <div>
              <div className="chart-title">Stage distribution</div>
              <div className="chart-sub">Projects by lifecycle stage</div>
            </div>
          </div>
          <StageDonut entries={stageEntries} />
        </div>
      </div>

      <div className="grid c2" style={{ marginTop: 16 }}>
        <div className="card chart-card">
          <div className="chart-head">
            <div>
              <div className="chart-title">Task status</div>
              <div className="chart-sub">All tasks grouped by status</div>
            </div>
          </div>
          <TaskBars entries={taskEntries} />
        </div>
        <div>
          <h2 className="section">Next actions</h2>
          <div className="card">
            {!nextActions || nextActions.length === 0 ? (
              <div className="dim">You're all caught up.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {nextActions.slice(0, 8).map((a, i) => {
                  const target = `/projects/${slugOf(a.projectId) ?? a.projectId}`;
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--border-muted)' }}>
                      <Link to={target} className="tiny" style={{ fontWeight: 600, minWidth: 90 }}>
                        {a.projectName}
                      </Link>
                      <span className="muted" style={{ fontSize: 12.5 }}>{a.text}</span>
                      <span className="dim tiny nowrap" style={{ marginLeft: 'auto' }}>
                        →
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <DocumentChangePanel />
        </div>
      </div>

      <div className="grid c2" style={{ marginTop: 16 }}>
        <div>
          <h2 className="section">Projects</h2>
          <div className="table-wrap">
            {activeProjects.length === 0 ? (
              <div className="empty">No active projects.</div>
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Stage</th>
                    <th style={{ textAlign: 'right' }}>Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {activeProjects.slice(0, 8).map(p => (
                    <tr key={p.id} onClick={() => navigate(`/projects/${p.slug}`)}>
                      <td>
                        <Link to={`/projects/${p.slug}`} style={{ fontWeight: 550 }}>
                          {p.name}
                        </Link>
                        <span className="dim tiny" style={{ marginLeft: 8 }}>
                          {p.stats.tasksOpen} open tasks
                        </span>
                      </td>
                      <td>
                        <StageBadge stage={p.stage} />
                      </td>
                      <td className="right nowrap" style={{ width: 110 }}>
                        <div className="progress" style={{ display: 'inline-block', verticalAlign: 'middle', width: 56 }}>
                          <div style={{ width: `${p.stats.progress}%`, background: 'var(--accent)' }} />
                        </div>
                        <span className="dim tiny" style={{ marginLeft: 7 }}>{p.stats.progress}%</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="table-foot">
              <span>
                {activeProjects.length} active of {data.totals.projects} total
              </span>
              <Link to="/projects" style={{ marginLeft: 'auto' }}>
                View all projects →
              </Link>
            </div>
          </div>
        </div>

        <div>
          <h2 className="section">Recent activity</h2>
          <div className="card">
            {data.recentActivity.length === 0 ? (
              <div className="dim">No activity yet.</div>
            ) : (
              <div className="timeline">
                {data.recentActivity.slice(0, 12).map(a => (
                  <div className="timeline-item" key={a.id}>
                    <div className="tl-head">
                      <span className="tl-type">{humanize(a.type)}</span>
                      {a.project ? (
                        <Link to={`/projects/${a.project.slug}`} className="tiny">
                          {a.project.name}
                        </Link>
                      ) : null}
                      <span className="tl-time">
                        <TimeAgo value={a.createdAt} />
                      </span>
                    </div>
                    <div className="tl-desc">{a.description}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}