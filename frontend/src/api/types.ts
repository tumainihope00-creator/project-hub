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
  /**
   * Phase 3 physical workspace. Null means the project has no folder: either it
   * predates the feature, or it came from the document importer.
   */
  folderName?: string | null;
  folderPath?: string | null;
}

export interface WorkspacePreview {
  root: string;
  folderName: string;
  folderPath: string;
  renamed: boolean;
  willCreate: boolean;
}

export interface WorkspaceStatus {
  hasWorkspace: boolean;
  folderPath: string | null;
  folderName: string | null;
  exists?: boolean | null;
  isDirectory?: boolean | null;
  readable?: boolean | null;
  problems?: PathProblem[];
  checkedAt?: string;
}

/**
 * Phase 4: PROJECT.md, the living document at the root of the project workspace.
 *
 * `available: false` is a normal answer, not a failure. It means this project
 * cannot have a PROJECT.md right now, and `reason` says why: no Projects Root is
 * configured, the project has no workspace folder, or the stored path no longer
 * resolves inside the Projects Root. The project page shows the reason and the
 * suggested action instead of hiding the card.
 */
export type ProjectDocumentReason =
  | 'PROJECTS_ROOT_NOT_CONFIGURED'
  | 'PROJECT_WORKSPACE_MISSING'
  | 'PROJECT_WORKSPACE_UNSAFE'
  | 'PROJECT_WORKSPACE_NOT_ON_DISK';

export interface ProjectDocumentStatus {
  projectId: number;
  projectName: string;
  available: boolean;
  reason?: ProjectDocumentReason;
  message?: string;
  possibleAction?: string;
  /** Always relative. The client never supplies, and never needs, a full path. */
  relativePath: string;
  documentPath?: string;
  /** null when the state could not be determined, false when there is no file. */
  exists: boolean | null;
  isDirectory: boolean;
  sizeBytes: number | null;
  modifiedAt: string | null;
  workspaceExists: boolean | null;
  workspaceIsSymbolicLink: boolean;
  documentVersion: number;
  /** Phase 4 writes the document from the database and nothing else. */
  direction: 'DATABASE_TO_DOCUMENT';
  /** Always false in Phase 4. Edits to the file are never applied to Project Hub. */
  documentToDatabaseSync: false;
}

export interface ProjectDocumentContent {
  projectId: number;
  projectName: string;
  relativePath: string;
  documentPath: string;
  content: string;
  sizeBytes: number;
  modifiedAt: string | null;
  documentVersion: number;
  direction: 'DATABASE_TO_DOCUMENT';
  documentToDatabaseSync: false;
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