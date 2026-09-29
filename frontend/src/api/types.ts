export interface Tag {
  id: number;
  name: string;
  color?: string | null;
  count?: number;
}

export interface TagUsage {
  id: number;
  name: string;
  color: string | null;
  count: number;
}

export type Project = FullProject;

export interface ProjectStats {
  tasksTotal: number;
  tasksCompleted: number;
  tasksOpen: number;
  issuesOpen: number;
  issuesCritical: number;
  deployments: number;
  prompts: number;
  aiSessions: number;
  developmentSessions: number;
  research: number;
  progress: number;
}

export interface ProjectSummary {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  stage: string;
  isArchived: boolean;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string | null;
  stats: ProjectStats;
  tags: Tag[];
}

export interface FullProject extends ProjectSummary {
  problem?: string | null;
  motivation?: string | null;
  targetUsers?: string | null;
  expectedValue?: string | null;
  assumptions?: string | null;
  initialQuestions?: string | null;
  inspiration?: string | null;
  v1Scope?: string | null;
  originalIdea?: string | null;
  repositoryUrl?: string | null;
}

export interface ProjectRelationship {
  id: number;
  fromProjectId: number;
  toProjectId: number;
  type: string;
  notes?: string | null;
  fromProject?: { id: number; name: string; slug: string; stage: string };
  toProject?: { id: number; name: string; slug: string; stage: string };
}

export interface ActivityEvent {
  id: number;
  type: string;
  description: string;
  relatedType?: string | null;
  relatedId?: number | null;
  projectId: number;
  createdAt: string;
  project?: { id: number; name: string; slug: string } | null;
  metadata?: Record<string, unknown> | null;
}

export interface NextAction {
  projectId: number;
  projectName: string;
  text: string;
}

export interface DashboardData {
  totals: {
    projects: number;
    active: number;
    archived: number;
    tasks: number;
    openIssues: number;
  };
  byStage: Record<string, number>;
  tasksByStatus: Record<string, number>;
  recentActivity: ActivityEvent[];
}

export interface ProjectStatsFull {
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
  lastActivityAt: string | null;
  lastDeploymentAt: string | null;
}

export interface ProjectOverview {
  project: FullProject;
  tags: Tag[];
  stats: ProjectStatsFull;
  recentActivity: ActivityEvent[];
  nextActions: string[];
}

export interface ResourceRow {
  id: number;
  [key: string]: unknown;
}

/**
 * The Projects Root: the folder that will contain every project folder Project
 * Hub manages. `null` in the nullable fields means "not configured" or "not
 * tested yet" - see `writableTested` for the one that is genuinely untested.
 */
export interface ProjectsRoot {
  configured: boolean;
  key: string;
  path: string | null;
  updatedAt: string | null;
  exists: boolean | null;
  isDirectory: boolean | null;
  isSymbolicLink: boolean | null;
  readable: boolean | null;
  writable: boolean | null;
  writableTested: boolean;
  usable: boolean;
  problems: PathProblem[];
  checkedAt: string;
}

export interface PathProblem {
  code: string;
  message: string;
  possibleAction?: string;
}