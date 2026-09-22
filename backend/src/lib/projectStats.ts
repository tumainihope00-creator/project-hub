import { prisma } from './prisma.js';

export const STAGE_ORDER = [
  'IDEA', 'RESEARCH', 'PLANNING', 'ARCHITECTURE', 'BUILDING', 'TESTING',
  'DEPLOYMENT', 'PRODUCTION', 'MAINTENANCE', 'COMPLETED'
];

export interface ProjectStats {
  tasksTotal: number;
  tasksCompleted: number;
  tasksOpen: number;
  tasksBlocked: number;
  tasksOverdue: number;
  issuesOpen: number;
  issuesCritical: number;
  features: number;
  requirements: number;
  milestones: number;
  researchEntries: number;
  researchQuestions: number;
  prompts: number;
  aiSessions: number;
  developmentSessions: number;
  deployments: number;
  incidentsOpen: number;
  documents: number;
  notes: number;
  decisions: number;
  activityCount: number;
  progress: number;
  lastActivityAt: Date | null;
  lastDeploymentAt: Date | null;
}

export async function projectStats(projectId: number): Promise<ProjectStats> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    return emptyStats();
  }
  const [completed, blocked, openIssuesEx, criticalIssues, inc] = await Promise.all([
    prisma.task.count({ where: { projectId, status: 'COMPLETED' } }),
    prisma.task.count({ where: { projectId, status: 'BLOCKED' } }),
    prisma.issue.count({ where: { projectId, status: { in: ['OPEN', 'INVESTIGATING', 'FIXING'] } } }),
    prisma.issue.count({ where: { projectId, severity: 'CRITICAL', status: { in: ['OPEN', 'INVESTIGATING', 'FIXING'] } } }),
    prisma.productionIncident.count({ where: { projectId, status: { in: ['OPEN', 'INVESTIGATING'] } } })
  ]);

  const totals = await Promise.all([
    prisma.task.count({ where: { projectId } }),
    prisma.feature.count({ where: { projectId } }),
    prisma.requirement.count({ where: { projectId } }),
    prisma.milestone.count({ where: { projectId } }),
    prisma.researchEntry.count({ where: { projectId } }),
    prisma.researchQuestion.count({ where: { projectId } }),
    prisma.prompt.count({ where: { projectId } }),
    prisma.aiSession.count({ where: { projectId } }),
    prisma.developmentSession.count({ where: { projectId } }),
    prisma.deployment.count({ where: { projectId } }),
    prisma.projectDocument.count({ where: { projectId } }),
    prisma.note.count({ where: { projectId } }),
    prisma.architectureDecision.count({ where: { projectId } }),
    prisma.activityEvent.aggregate({ where: { projectId }, _count: true }),
    prisma.activityEvent.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    prisma.deployment.findFirst({ where: { projectId }, orderBy: { date: 'desc' }, select: { date: true } })
  ]) as any;

  const overdueCount = await prisma.task.count({
    where: {
      projectId,
      dueDate: { not: null, lt: new Date() },
      status: { in: ['TODO', 'IN_PROGRESS', 'BLOCKED', 'TESTING'] }
    }
  });

  const [tasksTotal, features, requirements, milestones, researchEntries, researchQuestions, prompts, aiSessions, developmentSessions, deployments, documents, notes, decisions, activityAgg, lastAct, lastDep] = totals;

  const tasksOpen = tasksTotal - completed - (await prisma.task.count({ where: { projectId, status: 'CANCELLED' } }));

  let progress = 0;
  if (tasksTotal > 0) {
    progress = Math.round((completed / tasksTotal) * 100);
  } else {
    const idx = STAGE_ORDER.indexOf(project.stage);
    progress = idx >= 0 ? Math.round((idx / (STAGE_ORDER.length - 1)) * 100) : 0;
  }

  return {
    tasksTotal,
    tasksCompleted: completed,
    tasksOpen,
    tasksBlocked: blocked,
    tasksOverdue: overdueCount,
    issuesOpen: openIssuesEx,
    issuesCritical: criticalIssues,
    features,
    requirements,
    milestones,
    researchEntries,
    researchQuestions,
    prompts,
    aiSessions,
    developmentSessions,
    deployments,
    incidentsOpen: inc,
    documents,
    notes,
    decisions,
    activityCount: activityAgg._count,
    progress,
    lastActivityAt: lastAct ? lastAct.createdAt : null,
    lastDeploymentAt: lastDep ? lastDep.date : null
  };
}

function emptyStats(): ProjectStats {
  return {
    tasksTotal: 0, tasksCompleted: 0, tasksOpen: 0, tasksBlocked: 0, tasksOverdue: 0,
    issuesOpen: 0, issuesCritical: 0, features: 0, requirements: 0, milestones: 0,
    researchEntries: 0, researchQuestions: 0, prompts: 0, aiSessions: 0,
    developmentSessions: 0, deployments: 0, incidentsOpen: 0, documents: 0,
    notes: 0, decisions: 0, activityCount: 0, progress: 0,
    lastActivityAt: null, lastDeploymentAt: null
  };
}