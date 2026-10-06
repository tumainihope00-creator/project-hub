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

// ---------------------------------------------------------------------------
// Phase 6: PROJECT.md -> database synchronization
// ---------------------------------------------------------------------------

/**
 * Read-only change detection, shown on every load of the document card.
 *
 * `modified` is decided by comparing content hashes, never by the file's mtime, so
 * a `touch` or a copy that changes nothing does not read as an edit.
 */
export interface ProjectDocumentSyncState {
  projectId: number;
  documentHash: string | null;
  lastSyncedHash: string | null;
  lastSyncedAt: string | null;
  modified: boolean;
  neverSynchronized: boolean;
  /** At least one field is in conflict. */
  conflict: boolean;
  /** Phase 7: the classified state, for one badge instead of several booleans. */
  state: ProjectDocumentSyncStatusState;
  /** Phase 7: the fields that need a decision. Empty unless there is a conflict. */
  conflictFields: string[];
  /** Phase 7: when the agreement this comparison used was recorded. */
  baselineCapturedAt: string | null;
}

export interface ProjectDocumentSyncIssue {
  code: string;
  message: string;
}

export interface ProjectDocumentFieldChange {
  field: string;
  from: string | null;
  to: string | null;
}

export interface ProjectDocumentChildChange {
  entity: string;
  action: 'create' | 'update';
  key: string;
  label: string;
  changes: { field: string; from: unknown; to: unknown }[];
}

export interface ProjectDocumentUnmatchedRecord {
  entity: string;
  key: string;
  label: string;
}

/**
 * The classified synchronization state.
 *
 * Each state names a different situation with a different fix, so they are kept
 * apart rather than collapsed into "modified" / "conflict":
 *
 *  - `synchronized`      nothing to do.
 *  - `markdown_changed`  only PROJECT.md moved. Safe to apply.
 *  - `database_changed`  only the project record moved. Kept; regenerate to catch up.
 *  - `both_changed`      both moved, to the same value. No conflict, no write.
 *  - `conflict`          both moved the same field to different values. Needs a decision.
 *  - `error`             the document has problems. Reported, never guessed at.
 *  - `unavailable`       there is no readable document to compare.
 */
export type ProjectDocumentSyncStatusState =
  | 'synchronized'
  | 'markdown_changed'
  | 'database_changed'
  | 'both_changed'
  | 'conflict'
  | 'error'
  | 'unavailable';

/** Which way data moved in one synchronization. */
export type ProjectDocumentSyncDirection =
  | 'MARKDOWN_TO_DATABASE'
  | 'DATABASE_TO_MARKDOWN'
  | 'CONFLICT_RESOLUTION';

/** One field that changed on both sides and needs an explicit decision. */
export interface ProjectDocumentConflict {
  /** Column name, e.g. `description`. */
  field: string;
  scope: 'project' | 'record';
  entity: string | null;
  key: string | null;
  label: string | null;
  /** What the two sides last agreed on. Null when no agreement was recorded. */
  baseline: string | null;
  databaseValue: string | null;
  markdownValue: string | null;
}

/**
 * The Phase 7 half of every preview, status and synchronization response.
 *
 * This is the part that answers "what is safe, what is held back, and why".
 */
export interface ProjectDocumentSyncClassification {
  state: ProjectDocumentSyncStatusState;
  baseline: { available: boolean; capturedAt: string | null; documentHash: string | null };
  conflicts: ProjectDocumentConflict[];
  conflictFields: string[];
  /** Fields only PROJECT.md changed. Safe to apply. */
  markdownChanged: string[];
  /** Fields only the project record changed. Kept as they are. */
  databaseChanged: string[];
  modified: boolean;
  neverSynchronized: boolean;
  conflict: boolean;
}

/** One past synchronization, read back from the project timeline. */
export interface ProjectDocumentSyncHistoryEntry {
  at: string | null;
  direction: ProjectDocumentSyncDirection | null;
  state: string | null;
  applied: string[];
  databaseKept: string[];
  conflicts: string[];
  resolutions: { target: string; choice: string }[];
  warnings: number;
  actor: string | null;
  description: string;
}

/** The same shape the preview returns and the sync applies, so they cannot disagree. */
export interface ProjectDocumentSyncPreview {
  /** False when the change set has errors and nothing can be applied. */
  success: boolean;
  /** True when at least one field or record differs from the database. */
  changed: boolean;
  /** Project column names, then one `entity:key` entry per record. */
  updatedFields: string[];
  projectId: number;
  projectName: string;
  relativePath: string;
  documentVersion: number | null;
  documentHash: string;
  unchanged: boolean;
  firstSynchronization: boolean;
  conflict: boolean;
  /** False when the change set cannot be applied (errors present). */
  applicable: boolean;
  projectChanges: ProjectDocumentFieldChange[];
  childChanges: ProjectDocumentChildChange[];
  /** Database records with no counterpart in the document. Reported, never deleted. */
  unmatchedDatabaseRecords: ProjectDocumentUnmatchedRecord[];
  warnings: ProjectDocumentSyncIssue[];
  errors: ProjectDocumentSyncIssue[];
  unsupportedSections: string[];
  preservedDetailSections: { section: string; reason: string }[];
  sync: ProjectDocumentSyncClassification;
}

/** The preview plus the outcome of the synchronization that was applied. */
export interface ProjectDocumentSyncResult extends ProjectDocumentSyncPreview {
  applied: {
    appliedProjectChanges: ProjectDocumentFieldChange[];
    appliedChildChanges: { entity: string; action: 'create' | 'update'; key: string; label: string }[];
    unmatchedDatabaseRecords: ProjectDocumentUnmatchedRecord[];
    warnings: ProjectDocumentSyncIssue[];
    syncedAt: string;
    syncState: ProjectDocumentSyncStatusState;
    conflictFields: string[];
  } | null;
  /** Why nothing was applied, when applicable. */
  skipped: 'unchanged' | 'not_applicable' | null;
}

/**
 * Everything the details page needs about synchronization in one response: the
 * preview, the classified state with every conflicting value, and the history.
 */
export interface ProjectDocumentSyncStatus extends ProjectDocumentSyncPreview {
  lastSyncedAt: string | null;
  lastSyncedHash: string | null;
  history: ProjectDocumentSyncHistoryEntry[];
}

/**
 * One decision about one conflicting field.
 *
 * `database` keeps the project record and discards the document's value, `markdown`
 * keeps PROJECT.md, `manual` writes `value`. A resolution for a field that is no
 * longer in conflict is refused rather than applied.
 */
export interface ProjectDocumentConflictResolution {
  field: string;
  scope: 'project' | 'record';
  entity?: string | null;
  key?: string | null;
  choice: 'database' | 'markdown' | 'manual';
  value?: string | null;
}

/**
 * What each synchronization state means, in the user's terms rather than the
 * engine's. Every entry says what happened and what to do about it, because a
 * label that only names the state leaves the user to guess the next step.
 */
export const PROJECT_DOCUMENT_SYNC_STATE_LABEL: Record<ProjectDocumentSyncStatusState, string> = {
  synchronized: 'In sync with the project record',
  markdown_changed: 'PROJECT.md has changes to apply',
  database_changed: 'The project record changed - regenerate to catch up',
  both_changed: 'Both sides changed to the same value',
  conflict: 'Conflict - a field changed in both PROJECT.md and the project record',
  error: 'PROJECT.md has problems that must be fixed first',
  unavailable: 'No readable PROJECT.md to compare'
};

// ---------------------------------------------------------------------------
// Phase 7: PROJECT.md change monitoring
// ---------------------------------------------------------------------------
/**
 * Why a monitored PROJECT.md is not synchronized with its project.
 *
 * The states are separate on purpose. A missing file, an unreadable file, a file
 * that is valid but belongs to a different project and a file that parses but
 * records conflicts are four different problems with four different fixes, and
 * collapsing them into one "problem" indicator would leave the user guessing.
 */
export type DocumentMonitorState =
  | 'SYNCHRONIZED'
  | 'MODIFIED'
  | 'CONFLICT'
  | 'INVALID'
  | 'UNSUPPORTED_VERSION'
  | 'IDENTITY_MISMATCH'
  | 'MISSING'
  | 'UNREADABLE'
  | 'UNAVAILABLE'
  | 'ERROR';

/** How this project's document is actually being watched. */
export type DocumentMonitorMode = 'WATCH' | 'POLL';

/**
 * The service's real operating mode.
 *
 * `HYBRID` means some projects are watched and some are polled because a watcher
 * could not be established for those; `STOPPED` means the monitor is not running.
 * The UI reports this as-is rather than claiming live watching it does not have.
 */
export type DocumentMonitorServiceMode = 'STOPPED' | 'WATCH' | 'HYBRID' | 'POLL';

export interface DocumentMonitorIssue {
  code: string;
  message: string;
}

/**
 * A detected change, as the dashboard and the project page show it.
 *
 * Contains counts, field *names* and entity names only - never a field value, a
 * record key or document text. The full detail is on the Phase 6 preview endpoint,
 * which the user opens deliberately.
 */
export interface DocumentChangeNotification {
  id: string;
  projectId: number;
  projectName: string;
  relativePath: string;
  state: DocumentMonitorState;
  mode: DocumentMonitorMode;
  detectedAt: string;
  documentHash: string | null;
  lastSyncedHash: string | null;
  lastSyncedAt: string | null;
  summary: string;
  projectFieldCount: number;
  recordChangeCount: number;
  recordCreateCount: number;
  recordUpdateCount: number;
  changedFieldNames: string[];
  changedEntityNames: string[];
  /**
   * Phase 7: the fields that changed on both sides and need an explicit decision.
   * Names only - the values are on the synchronization status endpoint.
   */
  conflictFieldNames: string[];
  noRecordDifferences: boolean;
  warnings: DocumentMonitorIssue[];
  errors: DocumentMonitorIssue[];
  dismissedAt: string | null;
}

/** The monitored state of one project, for the project details page. */
export interface ProjectMonitorReport {
  projectId: number;
  projectName: string;
  relativePath: string;
  state: DocumentMonitorState;
  mode: DocumentMonitorMode;
  monitored: boolean;
  unavailableReason: string | null;
  documentHash: string | null;
  lastSyncedHash: string | null;
  lastSyncedAt: string | null;
  detectedAt: string | null;
  dismissedAt: string | null;
  summary: string | null;
  hasPendingChange: boolean;
  message: string | null;
}

/** The application-wide monitor status. */
export interface DocumentMonitorStatus {
  running: boolean;
  mode: DocumentMonitorServiceMode;
  projectsRoot: string | null;
  watchedProjects: number;
  polledProjects: number;
  skippedProjects: number;
  debounceMs: number;
  pollIntervalMs: number;
  registeredAt: string | null;
  lastScanAt: string | null;
  lastError: string | null;
}

/** `GET /api/document-monitor` */
export interface DocumentMonitorSnapshot {
  status: DocumentMonitorStatus;
  pending: DocumentChangeNotification[];
  /** Undismissed pending changes: the dashboard badge number. */
  pendingCount: number;
  skipped: { projectId: number; reason: string }[];
  streamClients: number;
}

/** Human labels for the monitoring states, kept in one place. */
export const DOCUMENT_MONITOR_STATE_LABEL: Record<DocumentMonitorState, string> = {
  SYNCHRONIZED: 'In sync',
  MODIFIED: 'Changed',
  CONFLICT: 'Conflict',
  INVALID: 'Cannot be read as changes',
  UNSUPPORTED_VERSION: 'Unsupported document version',
  IDENTITY_MISMATCH: 'Belongs to another project',
  MISSING: 'File is missing',
  UNREADABLE: 'File cannot be read',
  UNAVAILABLE: 'Workspace folder is unavailable',
  ERROR: 'Monitoring failed'
};

// ---------------------------------------------------------------------------
// Phase 5: STATUS.md and the project status
// ---------------------------------------------------------------------------

/**
 * The project statuses, as the backend reports them.
 *
 * The list comes from the API (`validStatuses`) rather than a copy kept in the
 * client, so a status added to the enum cannot be silently missing from the UI.
 * `src/resources.ts` still carries the same list for the places that need a
 * label before any request has finished.
 */
export type LifecycleStage =
  | 'IDEA'
  | 'RESEARCH'
  | 'PLANNING'
  | 'ARCHITECTURE'
  | 'BUILDING'
  | 'TESTING'
  | 'DEPLOYMENT'
  | 'PRODUCTION'
  | 'MAINTENANCE'
  | 'PAUSED'
  | 'COMPLETED'
  | 'ARCHIVED'
  | 'ABANDONED';

export type StatusUnavailableReason =
  | 'PROJECTS_ROOT_NOT_CONFIGURED'
  | 'PROJECT_WORKSPACE_MISSING'
  | 'PROJECT_WORKSPACE_UNSAFE'
  | 'PROJECT_WORKSPACE_NOT_ON_DISK'
  | 'PROJECT_WORKSPACE_IS_A_LINK';

/**
 * Every way the database and STATUS.md can fail to agree.
 *
 * The point of the extra states is that the UI never has to reduce "the file is
 * broken" to "the status is wrong": a missing file, an unreadable file and a file
 * declaring something that is not a status are three different problems with
 * three different fixes.
 */
export type StatusConsistencyState =
  | 'SYNCHRONIZED'
  | 'STATUS_MISMATCH'
  | 'DOCUMENT_MISSING'
  | 'DOCUMENT_INVALID'
  | 'DOCUMENT_UNREADABLE'
  | 'UNAVAILABLE';

export interface StatusConsistency {
  projectId: number;
  projectName: string;
  /** The database is the authority. This is the status of the project. */
  databaseStatus: LifecycleStage;
  /** What STATUS.md declares, or null when it declares nothing valid. */
  documentStatus: LifecycleStage | null;
  /** True only for SYNCHRONIZED; null when it cannot be determined. */
  isConsistent: boolean | null;
  state: StatusConsistencyState;
  relativePath: string;
  documentPath?: string;
  documentExists: boolean | null;
  documentModifiedAt: string | null;
  /** The literal text found in the file, so an invalid value can be shown. */
  rawDocumentStatus: string | null;
  invalidDocumentStatus?: string | null;
  documentProjectId?: number | null;
  reason?: StatusUnavailableReason;
  message?: string;
  possibleAction?: string;
  /** The authoritative list, so the client never invents a status. */
  validStatuses: LifecycleStage[];
  /** Phase 5 never resolves a disagreement on its own. */
  autoResolved: false;
  /** Editing STATUS.md never changes the project record. */
  documentToDatabaseSync: false;
}

export interface ChangeProjectStatusResponse {
  projectId: number;
  projectName: string;
  previousStatus: LifecycleStage;
  status: LifecycleStage;
  statusChanged: boolean;
  documentWritten: boolean;
  /** True when the requested status was already the stored one. */
  noChange: boolean;
  consistency: StatusConsistency;
  warning?: { code: string; message: string; possibleAction: string };
}

export interface StatusDocumentContent {
  projectId: number;
  projectName: string;
  relativePath: string;
  documentPath: string;
  content: string;
  parsed: {
    status: LifecycleStage | null;
    rawStatus: string | null;
    projectId: number | null;
    hasStatusLine: boolean;
    isValidStatus: boolean;
  };
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