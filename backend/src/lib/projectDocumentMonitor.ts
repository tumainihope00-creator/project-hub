import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ApiError } from './errors.js';
import {
  PROJECT_DOCUMENT_FILENAME,
  PROJECT_DOCUMENT_MAX_BYTES,
  PROJECT_DOCUMENT_VERSION,
  resolveProjectDocumentPath
} from './projectDocument.js';
import { hashContent } from './projectDocumentSync.js';
import { previewProjectDocumentSync, PreviewResult } from './projectDocumentSyncService.js';
import { getProjectsRoot } from './settings.js';
import { prisma } from './prisma.js';
import type { Prisma } from '@prisma/client';

/**
 * Phase 7: centralized monitoring of registered PROJECT.md files.
 *
 * The whole point of this phase is detection and notification, nothing else:
 *
 *   fs.watch(PROJECT.md) -> debounce -> read stable content -> sha256
 *     -> compare to the Phase 6 last-synchronized hash
 *       -> classify through the Phase 6 change set  (READ ONLY)
 *         -> notify the UI  (in-process event + SSE)
 *
 * There is no write path here. This module never writes a project data column
 * and never writes a child table; the single database write it can perform is to
 * four dedicated monitoring columns (see `persistMonitorState`), holding the last
 * detected hash, when it was detected, its classified state, and whether the user
 * dismissed it. Project content still only moves through the explicit Phase 6
 * synchronization the user triggers.
 *
 * Design decisions worth stating, because they are the ones the requirements
 * actually care about:
 *
 *  - Centralized, not per component. There is exactly one registration per
 *    project, keyed by project id, created by `startDocumentMonitor` or by an
 *    explicit register call. Two dashboard cards looking at the same project get
 *    the same single watcher, not two.
 *
 *  - One watcher per project folder, not per file, and never recursive. We watch
 *    the folder and filter on the exact filename. `fs.watch` has no portable
 *    "this one file" watch, and watching the file itself breaks on the atomic-save
 *    pattern every editor uses (write a temp file, rename over the target), which
 *    destroys the inode the watch was attached to. Watching the parent directory
 *    survives that, and a non-recursive watch on a folder's own directory sees
 *    only that folder's entries.
 *
 *  - Hashing is the change test, never mtime. Every save produces several events
 *    and editors rewrite mtime constantly; a content hash collapses a burst into
 *    one decision and makes timestamp-only touches impossible to mistake for an
 *    edit.
 *
 *  - An honest operating mode. If `fs.watch` cannot be established for a project
 *    (missing folder, inotify limit, unsupported platform) that project falls back
 *    to a slow hash-based poll, and the reported service mode says so instead of
 *    implying live watching. Per-project `mode` is visible in the API.
 *
 *  - Failures are contained. One unreadable folder, one malformed document or one
 *    watch error degrades that project to a classified state and an explanatory
 *    message. It never throws into the event loop and never stops another project
 *    from being monitored.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Every way a monitored document can differ from the synchronized state.
 *
 * The states exist separately so the UI never has to reduce "the file is
 * missing", "the file is broken" and "the file is from another project" into one
 * meaningless "problem" state: they have three different causes and three
 * different fixes.
 */
export type MonitorState =
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

export type MonitorMode = 'WATCH' | 'POLL';

export type ServiceMode = 'STOPPED' | 'WATCH' | 'HYBRID' | 'POLL';

/** States that mean "there is something for the user to look at". */
export const ATTENTION_STATES: readonly MonitorState[] = [
  'MODIFIED',
  'CONFLICT',
  'INVALID',
  'UNSUPPORTED_VERSION',
  'IDENTITY_MISMATCH',
  'MISSING',
  'UNREADABLE',
  'UNAVAILABLE',
  'ERROR'
];

/** States caused by the document failing validation rather than by a real edit. */
export const DOCUMENT_FAULT_STATES: readonly MonitorState[] = [
  'INVALID',
  'UNSUPPORTED_VERSION',
  'IDENTITY_MISMATCH'
];

export interface MonitorIssue {
  code: string;
  message: string;
}

/**
 * The change summary carried by a notification.
 *
 * Deliberately built from counts, field *names* and entity names only. No field
 * value, no record key, no record label and no document text appears here, so a
 * notification can never leak document contents into a dashboard, a log line or
 * an SSE frame. The full detail is one click away on the Phase 6 preview
 * endpoint, which the user opens deliberately.
 */
export interface DocumentChangeNotification {
  /** Stable across restarts for the same (project, content) pair. */
  id: string;
  projectId: number;
  projectName: string;
  relativePath: string;
  state: MonitorState;
  mode: MonitorMode;
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
  /** The file's bytes differ from the synchronized version but no record does. */
  noRecordDifferences: boolean;
  warnings: MonitorIssue[];
  errors: MonitorIssue[];
  /** Set when the user dismissed it; a dismissed change is not re-announced. */
  dismissedAt: string | null;
}

export interface ProjectMonitorReport {
  projectId: number;
  projectName: string;
  relativePath: string;
  /** The folder being watched. Relative to the Projects Root; never the root itself. */
  folderPath: string | null;
  state: MonitorState;
  mode: MonitorMode;
  monitored: boolean;
  /** Why this project is not being watched, when it is not. */
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

export interface MonitorStatus {
  running: boolean;
  /** The real, combined mode. Never claims live watching it is not doing. */
  mode: ServiceMode;
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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Tunables, overridable for tests so they do not have to sleep in real time.
 */
export interface MonitorOptions {
  debounceMs: number;
  pollIntervalMs: number;
  /**
   * How many times a single file read may disagree with itself before we assume
   * the writer is still going and try again later. One save from an editor is
   * several writes; reading mid-write is the main source of false positives, so
   * we confirm stability rather than trust a single read.
   */
  maxReadAttempts: number;
}

const DEFAULT_OPTIONS: MonitorOptions = {
  // Long enough to swallow a burst of writes from one save, short enough that the
  // user does not notice the delay.
  debounceMs: 300,
  // Only used for projects whose watcher could not be established. Deliberately
  // slow: this is a safety net, not the primary mechanism, and it is still
  // hash-gated so it does no work when nothing changed.
  pollIntervalMs: 30_000,
  maxReadAttempts: 3
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Registration {
  projectId: number;
  projectName: string;
  /** Absolute, containment-checked workspace folder. */
  folderPath: string;
  /** Absolute path of the single file this registration may ever touch. */
  documentPath: string;
  watcher: fs.FSWatcher | null;
  pollTimer: NodeJS.Timeout | null;
  debounceTimer: NodeJS.Timeout | null;
  mode: MonitorMode;
  /** Last content hash this registration analyzed. null = nothing analyzed yet. */
  observedHash: string | null;
  unavailableReason: string | null;
  /** Serializes analyses so a forced check cannot interleave with a debounce one. */
  inFlight: Promise<void> | null;
  watchError: string | null;
}

const registrations = new Map<number, Registration>();
/** Defensive: the document path -> project id, so two projects can never watch one file. */
const documentPaths = new Map<string, number>();
const notifications = new Map<number, DocumentChangeNotification>();
/** Project id -> why it is not monitored. Projects with no folder land here too. */
const skipped = new Map<number, string>();

const emitter = new EventEmitter();
// SSE keeps one listener per open browser tab; do not warn about it.
emitter.setMaxListeners(0);

let options: MonitorOptions = { ...DEFAULT_OPTIONS };
let running = false;
let registeredAt: string | null = null;
let lastScanAt: string | null = null;
let lastError: string | null = null;
/** Cached Projects Root path; see safeProjectsRoot. */
let projectsRootCache: string | null = null;
let sseClientCount = 0;

function log(message: string, ...rest: unknown[]): void {
  console.log(`[document-monitor] ${message}`, ...rest);
}

function logWarn(message: string, ...rest: unknown[]): void {
  console.warn(`[document-monitor] ${message}`, ...rest);
}

function needsAttention(state: MonitorState): boolean {
  return ATTENTION_STATES.includes(state);
}

function plural(n: number, singular: string, many = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : many}`;
}

// ---------------------------------------------------------------------------
// The only write path in this module
// ---------------------------------------------------------------------------

/**
 * The complete set of columns the monitoring feature may write.
 *
 * Typed as a literal union and listed explicitly in the `data` object so that
 * this function structurally *cannot* be made to write a project data column: a
 * caller passing `name` or `description` is a compile error, not a runtime bug.
 * There is no spread of caller data into the update.
 */
type MonitorColumnPatch = {
  projectDocumentLastDetectedHash?: string | null;
  projectDocumentDetectedAt?: Date | null;
  projectDocumentChangeState?: string | null;
  projectDocumentDismissedAt?: Date | null;
};

async function persistMonitorState(projectId: number, patch: MonitorColumnPatch): Promise<void> {
  // Only the columns present in the patch are written. A field that was simply
  // not mentioned must keep its current value: dismissing a change sets
  // dismissedAt alone, and blanking the other three here would erase the record
  // of what was detected and re-alert on the next restart.
  const data: Prisma.ProjectUpdateInput = {};
  if ('projectDocumentLastDetectedHash' in patch) {
    data.projectDocumentLastDetectedHash = patch.projectDocumentLastDetectedHash ?? null;
  }
  if ('projectDocumentDetectedAt' in patch) {
    data.projectDocumentDetectedAt = patch.projectDocumentDetectedAt ?? null;
  }
  if ('projectDocumentChangeState' in patch) {
    data.projectDocumentChangeState = patch.projectDocumentChangeState ?? null;
  }
  if ('projectDocumentDismissedAt' in patch) {
    data.projectDocumentDismissedAt = patch.projectDocumentDismissedAt ?? null;
  }

  await prisma.project.update({
    where: { id: projectId },
    // Never touch project data. The key set is built explicitly above rather
    // than spread from the caller, so no caller-supplied field can reach here.
    data,
    select: { id: true }
  }).catch((err: unknown) => {
    // P2025: the project row is gone. A hard delete can land while an analysis
    // started a moment earlier is still finishing, and a project that no longer
    // exists has no monitoring state worth persisting. Dropping the write is the
    // correct outcome, not an error to propagate into an unhandled rejection.
    if ((err as { code?: string }).code === 'P2025') return;
    throw err;
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

type ReadResult =
  | { ok: true; content: string; hash: string }
  | { ok: false; kind: 'MISSING' | 'UNREADABLE' | 'UNSTABLE'; message: string };

/**
 * Read the file and confirm it stopped changing mid-read.
 *
 * Reading once is not enough: an editor writing a large file can have the read
 * land between two writes, producing a torn buffer whose hash is different from
 * both the old and the final content. Comparing a second read catches that
 * without pretending we can lock the file.
 */
async function readStableDocument(documentPath: string): Promise<ReadResult> {
  let lastHash: string | null = null;

  for (let attempt = 1; attempt <= options.maxReadAttempts; attempt += 1) {
    let content: string;
    try {
      const stat = await fsp.lstat(documentPath);
      if (stat.isDirectory()) {
        return {
          ok: false,
          kind: 'UNREADABLE',
          message: `${PROJECT_DOCUMENT_FILENAME} exists but is a folder, not a file.`
        };
      }
      if (stat.size > PROJECT_DOCUMENT_MAX_BYTES) {
        return {
          ok: false,
          kind: 'UNREADABLE',
          message: `${PROJECT_DOCUMENT_FILENAME} is larger than the ${PROJECT_DOCUMENT_MAX_BYTES} byte limit.`
        };
      }
      content = await fsp.readFile(documentPath, 'utf8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        return { ok: false, kind: 'MISSING', message: `${PROJECT_DOCUMENT_FILENAME} no longer exists.` };
      }
      return {
        ok: false,
        kind: 'UNREADABLE',
        message: `Project Hub could not read ${PROJECT_DOCUMENT_FILENAME} (${e.code ?? 'unknown error'}).`
      };
    }

    const hash = hashContent(content);
    if (lastHash !== null && lastHash === hash) {
      return { ok: true, content, hash };
    }
    lastHash = hash;
    // First read of this pass: read once more to see whether it settles.
  }

  return {
    ok: false,
    kind: 'UNSTABLE',
    message: `${PROJECT_DOCUMENT_FILENAME} was still being written after ${options.maxReadAttempts} reads.`
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

interface Classification {
  state: MonitorState;
  documentHash: string | null;
  preview: PreviewResult | null;
  message: string | null;
  issues: { warnings: MonitorIssue[]; errors: MonitorIssue[] };
}

/**
 * Replace Phase 6's issue messages with content-free ones.
 *
 * Phase 6 messages are written for the preview page, where the user has
 * deliberately opened the document, and several of them quote the document: an
 * unrecognised line, the raw `p-hub-project-id`, a milestone target date, a
 * record key. A notification is broadcast to the dashboard, written to a log and
 * pushed over SSE, so it must not carry any of that. The stable machine-readable
 * `code` is kept - it is the part a client can act on - and the human message
 * becomes a fixed sentence per code.
 */
const ISSUE_SUMMARY: Record<string, string> = {
  PARSE_ERROR: 'The document could not be parsed.',
  PARSE_WARNING: 'Part of the document could not be read.',
  PROJECT_ID_MISMATCH: 'The document declares a different project id.',
  PROJECT_ID_INVALID: 'The document declares an unusable project id.',
  PROJECT_DOCUMENT_VERSION_MISSING: 'The document declares no version.',
  UNSUPPORTED_DOCUMENT_VERSION: 'The document declares a version Project Hub does not understand.',
  PROTECTED_FIELD: 'The document tries to change a column Project Hub never writes.',
  UNKNOWN_SECTION: 'The document has a section Project Hub does not read.',
  UNPARSEABLE_DATE: 'A date in the document is not in the expected format and was ignored.',
  UNREADABLE_FIELD: 'A field in the document could not be read.',
  AMBIGUOUS_RECORD: 'Two records in the document cannot be told apart.',
  DUPLICATE_RECORD_KEY: 'Two records in the document share a key.',
  UNKNOWN_RECORD_KIND: 'The document contains a record Project Hub does not understand.'
};

function sanitizeIssues(issues: readonly { code: string; message: string }[]): MonitorIssue[] {
  return issues.map(issue => ({
    code: issue.code,
    message: ISSUE_SUMMARY[issue.code] ?? 'Project Hub could not use part of this document.'
  }));
}

/**
 * Turn "the file differs" into a specific reason, using Phase 6 as the analyser.
 *
 * `previewProjectDocumentSync` performs the full read + parse + change-set build
 * and performs no write of any kind, so calling it is exactly "analyze the change
 * through Phase 6" with no new logic and no drift between the notification and
 * the preview the user will read next.
 */
async function classify(projectId: number, documentHash: string): Promise<Classification> {
  const empty = { warnings: [] as MonitorIssue[], errors: [] as MonitorIssue[] };

  let preview: PreviewResult;
  try {
    preview = await previewProjectDocumentSync(projectId);
  } catch (err) {
    const e = err as { code?: string; status?: number; message?: string; details?: { code?: string } };
    // A 409/404 from Phase 6 means the workspace or the file vanished between the
    // read and the analysis. Classify it; do not let it escape as an exception.
    return {
      state: e.status === 409 ? 'UNAVAILABLE' : e.status === 404 ? 'MISSING' : 'ERROR',
      documentHash,
      preview: null,
      message: e.message ?? 'Project Hub could not analyze PROJECT.md.',
      issues: {
        warnings: [],
        errors: [{ code: e.details?.code ?? e.code ?? 'MONITOR_ANALYSIS_FAILED', message: e.message ?? 'Analysis failed.' }]
      }
    };
  }

  const errors = sanitizeIssues(preview.errors);
  const warnings = sanitizeIssues(preview.warnings);

  // Byte-identical to the last synchronize: nothing to report at all.
  if (preview.unchanged) {
    return { state: 'SYNCHRONIZED', documentHash, preview, message: null, issues: empty };
  }

  // Version first: an unsupported version makes every other check meaningless,
  // because we cannot say what its fields mean.
  if (preview.documentVersion !== null && preview.documentVersion !== PROJECT_DOCUMENT_VERSION) {
    return {
      state: 'UNSUPPORTED_VERSION',
      documentHash,
      preview,
      message: `This PROJECT.md declares document version ${preview.documentVersion}. Project Hub understands version ${PROJECT_DOCUMENT_VERSION}.`,
      issues: { warnings, errors }
    };
  }

  // Identity second: a document belonging to another project must never be
  // described as changes to this one, whatever else it contains.
  if (errors.some((e) => e.code === 'PROJECT_ID_MISMATCH')) {
    return {
      state: 'IDENTITY_MISMATCH',
      documentHash,
      preview,
      message: 'This PROJECT.md declares a different project id, so it does not belong to this project.',
      issues: { warnings, errors }
    };
  }

  if (errors.length > 0) {
    return {
      state: 'INVALID',
      documentHash,
      preview,
      message: 'PROJECT.md could not be parsed into changes. See the preview for the exact problems.',
      issues: { warnings, errors }
    };
  }

  if (preview.conflict) {
    return {
      state: 'CONFLICT',
      documentHash,
      preview,
      message:
        'This project was changed in Project Hub after the document was last synchronized, and PROJECT.md was also changed. Review both before synchronizing.',
      issues: { warnings, errors }
    };
  }

  // Parsed cleanly, no conflict. The bytes differ from the synchronized version,
  // so this is not synchronized; it may simply be that nothing in it maps to a
  // record difference (whitespace, section ordering, prose-only detail blocks).
  return { state: 'MODIFIED', documentHash, preview, message: null, issues: { warnings, errors } };
}

/**
 * Build the notification payload. Counts and names only - see the type doc.
 *
 * The last-synchronized hash and timestamp come from the project row rather than
 * from the Phase 6 preview, which deliberately does not echo them.
 */
function toNotification(
  reg: Registration,
  result: Classification,
  detectedAt: Date,
  previous: DocumentChangeNotification | undefined,
  lastSyncedHash: string | null,
  lastSyncedAt: string | null
): DocumentChangeNotification {
  const preview = result.preview;
  const fieldNames = preview ? [...new Set(preview.projectChanges.map(c => c.field))].sort() : [];
  const entityNames = preview ? [...new Set(preview.childChanges.map(c => c.entity))].sort() : [];
  const creates = preview ? preview.childChanges.filter(c => c.action === 'create').length : 0;
  const updates = preview ? preview.childChanges.filter(c => c.action === 'update').length : 0;
  const fieldCount = preview ? preview.projectChanges.length : 0;
  const recordCount = creates + updates;

  const parts: string[] = [];
  if (fieldCount > 0) parts.push(plural(fieldCount, 'project field'));
  if (recordCount > 0) parts.push(plural(recordCount, 'record'));
  if (result.issues.errors.length > 0) parts.push(plural(result.issues.errors.length, 'problem'));
  if (parts.length === 0) {
    parts.push(
      DOCUMENT_FAULT_STATES.includes(result.state)
        ? 'the document could not be read as changes'
        : 'no record differences'
    );
  }

  const id = buildId(reg.projectId, result);

  return {
    id,
    projectId: reg.projectId,
    projectName: reg.projectName,
    relativePath: `./${PROJECT_DOCUMENT_FILENAME}`,
    state: result.state,
    mode: reg.mode,
    detectedAt: detectedAt.toISOString(),
    documentHash: result.documentHash,
    lastSyncedHash,
    lastSyncedAt,
    summary: `${parts.join(' and ')}.`,
    projectFieldCount: fieldCount,
    recordChangeCount: recordCount,
    recordCreateCount: creates,
    recordUpdateCount: updates,
    changedFieldNames: fieldNames,
    changedEntityNames: entityNames,
    noRecordDifferences: result.state === 'MODIFIED' && recordCount === 0 && fieldCount === 0,
    warnings: result.issues.warnings,
    errors: result.issues.errors,
    // A dismissal belongs to specific content. The same bytes keep the dismissal;
    // different bytes are a different change and must alert again.
    dismissedAt: previous?.id === id ? previous.dismissedAt : null
  };
}

function buildId(projectId: number, result: Classification): string {
  return `${projectId}:${result.documentHash ?? 'none'}:${result.state}`;
}

/**
 * The last-synchronized hash/timestamp per project, cached from the database.
 *
 * Kept as a cache rather than re-queried on every report so that reading the
 * monitor state is cheap; the values are refreshed on every analysis, on startup
 * and on resync, and `markProjectSynchronized` clears them.
 */
const lastSyncedHashCache = new Map<number, string | null>();
const lastSyncedAtCache = new Map<number, string | null>();

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

interface AnalysisOutcome {
  reg: Registration;
  state: MonitorState;
  documentHash: string | null;
  message: string | null;
  changed: boolean;
  notified: boolean;
}

/**
 * Analyze one registered project and, if the content actually differs from what
 * this registration already saw, publish a notification.
 *
 * Two gates, in order:
 *   1. the hash differs from what we last analyzed  -> suppress pure event bursts
 *   2. the hash differs from the Phase 6 synchronized hash -> report it at all
 *
 * Gate 1 is what makes "one save, five events" produce one notification. Gate 2
 * is what makes a timestamp-only touch produce nothing, and what stops a restart
 * from re-announcing a change the user has already seen.
 */
async function analyzeRegistration(reg: Registration, trigger: 'watch' | 'poll' | 'manual' | 'scan'): Promise<AnalysisOutcome> {
  const started = Date.now();
  const outcome: AnalysisOutcome = {
    reg,
    state: 'SYNCHRONIZED',
    documentHash: reg.observedHash,
    message: null,
    changed: false,
    notified: false
  };

  const read = await readStableDocument(reg.documentPath);
  if (!read.ok) {
    if (read.kind === 'UNSTABLE') {
      // Still moving. Try again shortly rather than analysing a torn file.
      scheduleDebounce(reg, trigger);
      outcome.state = reg.observedHash === null ? 'SYNCHRONIZED' : 'MODIFIED';
      return outcome;
    }
    outcome.state = read.kind === 'MISSING' ? 'MISSING' : 'UNREADABLE';
    outcome.message = read.message;
    outcome.documentHash = null;
    reg.observedHash = null;
    await publish(
      reg,
      {
        state: outcome.state,
        documentHash: null,
        preview: null,
        message: read.message,
        issues: {
          warnings: [],
          errors: [{ code: read.kind, message: read.message }]
        }
      },
      lastSyncedHashCache.get(reg.projectId) ?? null,
      lastSyncedAtCache.get(reg.projectId) ?? null
    );
    return outcome;
  }

  outcome.documentHash = read.hash;

  // Gate 1: identical to what this registration last analyzed. Nothing to say,
  // no database write, no notification.
  if (reg.observedHash === read.hash) {
    outcome.state = currentStateOf(reg.projectId) ?? 'SYNCHRONIZED';
    return outcome;
  }

  reg.observedHash = read.hash;
  outcome.changed = true;

  const [row, classified] = await Promise.all([
    prisma.project.findUnique({
      where: { id: reg.projectId },
      select: { projectDocumentHash: true, projectDocumentSyncedAt: true }
    }),
    classify(reg.projectId, read.hash)
  ]);
  const lastSyncedHash = row?.projectDocumentHash ?? null;
  const lastSyncedAt = row?.projectDocumentSyncedAt?.toISOString() ?? null;
  lastSyncedHashCache.set(reg.projectId, lastSyncedHash);
  lastSyncedAtCache.set(reg.projectId, lastSyncedAt);

  outcome.state = classified.state;
  outcome.message = classified.message;
  outcome.notified = await publish(reg, classified, lastSyncedHash, lastSyncedAt);

  lastScanAt = new Date().toISOString();
  if (trigger === 'manual') {
    log(`project ${reg.projectId} re-checked on request -> ${outcome.state} (${Date.now() - started}ms)`);
  }
  return outcome;
}

/** The state currently on record for a project, if it has one. */
function currentStateOf(projectId: number): MonitorState | null {
  return notifications.get(projectId)?.state ?? null;
}

/**
 * Persist the detection and publish it. Returns whether a notification was
 * actually emitted (i.e. this is new information rather than a repeat).
 */
async function publish(
  reg: Registration,
  result: Classification,
  lastSyncedHash: string | null,
  lastSyncedAt: string | null
): Promise<boolean> {
  const detectedAt = new Date();
  const previous = notifications.get(reg.projectId);
  const id = buildId(reg.projectId, result);

  // Same project, same content, same state -> already reported. Re-publishing
  // would spam the dashboard on every save of an unchanged broken file.
  if (previous?.id === id) {
    return false;
  }

  const notification = toNotification(reg, result, detectedAt, previous, lastSyncedHash, lastSyncedAt);
  notifications.set(reg.projectId, notification);

  await persistMonitorState(reg.projectId, {
    projectDocumentLastDetectedHash: result.documentHash,
    projectDocumentDetectedAt: detectedAt,
    projectDocumentChangeState: result.state,
    projectDocumentDismissedAt: notification.dismissedAt ? new Date(notification.dismissedAt) : null
  });

  // Counts, field names and entity names only. No document text reaches the log.
  log(`project ${reg.projectId} "${reg.projectName}" -> ${result.state}: ${notification.summary}`, {
    fields: notification.changedFieldNames,
    entities: notification.changedEntityNames,
    errors: notification.errors.map(e => e.code)
  });

  emitter.emit('notification', notification);
  return true;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * Collapse a burst of filesystem events into one analysis.
 *
 * There can only ever be one pending timer per registration: the timer lives on
 * the registration object and is cleared before being replaced, so an event storm
 * restarts a single timer instead of queueing dozens of reads.
 */
function scheduleDebounce(reg: Registration, _trigger: 'watch' | 'poll' | 'manual' | 'scan'): void {
  if (reg.debounceTimer) clearTimeout(reg.debounceTimer);
  reg.debounceTimer = setTimeout(() => {
    reg.debounceTimer = null;
    void runAnalysis(reg, 'watch');
  }, options.debounceMs);
  // A debounce timer must not hold the event loop open by itself.
  reg.debounceTimer.unref?.();
}

async function runAnalysis(reg: Registration, trigger: 'watch' | 'poll' | 'manual' | 'scan'): Promise<AnalysisOutcome> {
  // Serialize: a manual check landing on top of a debounce check would run two
  // reads and could publish two notifications for one change.
  const previous = reg.inFlight ?? Promise.resolve();
  const next = previous.then(() => analyzeRegistration(reg, trigger));
  // Swallow failures on the tracked handle so one bad analysis cannot poison
  // every later check for this project; the caller still sees the rejection.
  reg.inFlight = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

async function stopRegistration(projectId: number): Promise<void> {
  const reg = registrations.get(projectId);
  if (!reg) return;
  registrations.delete(projectId);
  if (documentPaths.get(reg.documentPath) === projectId) documentPaths.delete(reg.documentPath);
  if (reg.debounceTimer) clearTimeout(reg.debounceTimer);
  if (reg.pollTimer) clearInterval(reg.pollTimer);
  if (reg.watcher) {
    try {
      reg.watcher.close();
    } catch {
      // Closing a watcher that is already broken is not an error worth raising.
    }
  }
}

function startPollFallback(reg: Registration, reason: string): void {
  reg.mode = 'POLL';
  reg.watchError = reason;
  if (reg.pollTimer) return;
  reg.pollTimer = setInterval(() => {
    void runAnalysis(reg, 'poll');
  }, options.pollIntervalMs);
  reg.pollTimer.unref?.();
  logWarn(`project ${reg.projectId} "${reg.projectName}" is being polled, not watched: ${reason}`);
}

/**
 * Watch exactly this project's workspace folder, filtered to PROJECT.md.
 *
 * Non-recursive on purpose: this registration may observe one file in one folder
 * and nothing else. The Projects Root and any nested folder are never watched, so
 * activity elsewhere in the root cannot influence any project's state.
 */
function startWatch(reg: Registration): void {
  try {
    const watcher = fs.watch(reg.folderPath, { persistent: true, recursive: false }, (_eventType, filename) => {
      // filename is null on some platforms/edge cases. Re-checking this one
      // project's file is harmless because the hash gate decides whether anything
      // is actually reported.
      if (filename === null || filename === undefined || filename === PROJECT_DOCUMENT_FILENAME) {
        scheduleDebounce(reg, 'watch');
      }
    });
    watcher.on('error', err => {
      const e = err as NodeJS.ErrnoException;
      startPollFallback(reg, `filesystem watch failed (${e.code ?? 'unknown error'})`);
      try {
        watcher.close();
      } catch {
        // ignore
      }
      reg.watcher = null;
    });
    reg.watcher = watcher;
    reg.mode = 'WATCH';
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    startPollFallback(reg, `filesystem watch unavailable (${e.code ?? 'unknown error'})`);
  }
}

/**
 * Resolve the project through the same Phase 4 path resolver every other feature
 * uses, so the monitor cannot drift from the Projects Root containment and
 * symlink policy. The project id comes from the database record; no path from the
 * browser is ever resolved here.
 */
async function resolveForRegistration(project: { id: number; name: string; folderPath: string | null }): Promise<{
  ok: boolean;
  registration?: Registration;
  reason?: string;
}> {
  const resolved = await resolveProjectDocumentPath({ folderPath: project.folderPath });
  if (!resolved.available) {
    return { ok: false, reason: resolved.reason };
  }

  // Belt and braces: the resolver already guarantees this, but the monitor's
  // whole safety argument rests on "this process may only read these files", so
  // the assertion is repeated where the watch is actually established.
  const documentPath = path.resolve(resolved.path.documentPath);
  const folderPath = path.resolve(resolved.path.folderPath);
  if (path.dirname(documentPath) !== folderPath) {
    return { ok: false, reason: 'PROJECT_DOCUMENT_PATH_UNSAFE' };
  }
  if (path.basename(documentPath) !== PROJECT_DOCUMENT_FILENAME) {
    return { ok: false, reason: 'PROJECT_DOCUMENT_PATH_UNSAFE' };
  }

  const owner = documentPaths.get(documentPath);
  if (owner !== undefined && owner !== project.id) {
    // Two project records pointing at one folder. Monitoring it for both would
    // mean one file driving two projects' state, so neither gets a watch.
    return { ok: false, reason: 'PROJECT_DOCUMENT_PATH_SHARED' };
  }

  return {
    ok: true,
    registration: {
      projectId: project.id,
      projectName: project.name,
      folderPath,
      documentPath,
      watcher: null,
      pollTimer: null,
      debounceTimer: null,
      mode: 'WATCH',
      observedHash: null,
      unavailableReason: null,
      inFlight: null,
      watchError: null
    }
  };
}

/**
 * Start (or refresh) monitoring for one project.
 *
 * Idempotent by construction: keyed by project id, so calling it twice for the
 * same project tears the old registration down first and leaves exactly one
 * watcher. That is what makes "the dashboard card mounted, the overview page
 * mounted, and the server startup all want to watch this project" a non-event.
 */
export async function registerProject(
  project: { id: number; name: string; folderPath: string | null },
  opts: { watch?: boolean } = {}
): Promise<{ monitored: boolean; mode: MonitorMode | 'SKIPPED'; reason: string | null }> {
  await refreshProjectsRootCache();
  const resolved = await resolveForRegistration(project);
  if (!resolved.ok || !resolved.registration) {
    await stopRegistration(project.id);
    skipped.set(project.id, resolved.reason ?? 'UNAVAILABLE');
    return { monitored: false, mode: 'SKIPPED', reason: resolved.reason ?? 'UNAVAILABLE' };
  }

  await stopRegistration(project.id);
  const reg = resolved.registration;
  registrations.set(project.id, reg);
  skipped.delete(project.id);
  documentPaths.set(reg.documentPath, project.id);

  if (opts.watch !== false) startWatch(reg);
  await establishBaseline(reg);
  return { monitored: true, mode: reg.mode, reason: reg.watchError };
}

/**
 * Read the current content once, without writing anything.
 *
 * This is the startup answer to "what did we already know about this file?":
 *
 *  - The Phase 6 synchronized hash says what the database last accepted.
 *  - The Phase 7 monitoring columns say what we last detected, when, and whether
 *    the user dismissed it.
 *  - Comparing the two on startup is what makes a restart transparent: an
 *    unchanged pending change is restored (still pending, still dismissed if it
 *    was dismissed), and a change detected while the server was down is reported
 *    now rather than lost.
 *
 * No database write happens here. A baseline is an observation, not an event.
 */
async function establishBaseline(reg: Registration): Promise<void> {
  const [read, row] = await Promise.all([
    readStableDocument(reg.documentPath),
    prisma.project.findUnique({
      where: { id: reg.projectId },
      select: {
        projectDocumentHash: true,
        projectDocumentSyncedAt: true,
        projectDocumentLastDetectedHash: true,
        projectDocumentDetectedAt: true,
        projectDocumentChangeState: true,
        projectDocumentDismissedAt: true
      }
    })
  ]);

  lastSyncedHashCache.set(reg.projectId, row?.projectDocumentHash ?? null);
  lastSyncedAtCache.set(reg.projectId, row?.projectDocumentSyncedAt?.toISOString() ?? null);

  if (!read.ok) {
    // A missing or unreadable document at startup is a real state, but it is not
    // a change the user made, so it is not announced. It surfaces in the report.
    reg.observedHash = null;
    return;
  }

  reg.observedHash = read.hash;

  const syncedHash = row?.projectDocumentHash ?? null;
  const knownDetected = row?.projectDocumentLastDetectedHash ?? null;

  // Identical to the last synchronized version: nothing was ever pending.
  if (syncedHash !== null && read.hash === syncedHash) return;

  // The same change we already detected on a previous run, and the user
  // dismissed it: restore it as dismissed so nothing re-alerts.
  if (knownDetected !== null && knownDetected === read.hash && row?.projectDocumentChangeState) {
    notifications.set(reg.projectId, {
      id: `${reg.projectId}:${read.hash}:${row.projectDocumentChangeState}`,
      projectId: reg.projectId,
      projectName: reg.projectName,
      relativePath: `./${PROJECT_DOCUMENT_FILENAME}`,
      state: row.projectDocumentChangeState as MonitorState,
      mode: reg.mode,
      detectedAt: (row.projectDocumentDetectedAt ?? new Date()).toISOString(),
      documentHash: read.hash,
      lastSyncedHash: syncedHash,
      lastSyncedAt: row?.projectDocumentSyncedAt?.toISOString() ?? null,
      summary: 'Restored from a previous run of Project Hub.',
      projectFieldCount: 0,
      recordChangeCount: 0,
      recordCreateCount: 0,
      recordUpdateCount: 0,
      changedFieldNames: [],
      changedEntityNames: [],
      noRecordDifferences: false,
      warnings: [],
      errors: [],
      dismissedAt: row.projectDocumentDismissedAt?.toISOString() ?? null
    });
    return;
  }

  // Either a change detected while the server was not running, or a change made
  // before monitoring existed. Analyze it now, so the pending state is honest
  // from the very first request.
  try {
    const classified = await classify(reg.projectId, read.hash);
    await publish(reg, classified, syncedHash, row?.projectDocumentSyncedAt?.toISOString() ?? null);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }
}

/** Stop monitoring a project. Safe to call for an unknown project. */
export async function unregisterProject(projectId: number): Promise<void> {
  await stopRegistration(projectId);
  notifications.delete(projectId);
  lastSyncedHashCache.delete(projectId);
  lastSyncedAtCache.delete(projectId);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Register every project that has a workspace folder and start watching.
 *
 * Never throws for a single bad project: one project with a missing folder is
 * skipped and reported, and the rest keep working.
 */
export async function startDocumentMonitor(overrides: Partial<MonitorOptions> = {}): Promise<MonitorStatus> {
  options = { ...DEFAULT_OPTIONS, ...overrides };

  if (running) {
    // Idempotent: a second start must not create a second watcher per project.
    await resyncDocumentMonitor();
    return getMonitorStatus();
  }

  running = true;
  registeredAt = new Date().toISOString();
  lastError = null;
  skipped.clear();
  await refreshProjectsRootCache();

  // Every project is considered, including the ones with no workspace folder, so
  // the skipped count in the status is truthful rather than only counting
  // projects that were attempted and failed.
  const projects = await prisma.project.findMany({
    select: { id: true, name: true, folderPath: true }
  });

  for (const project of projects) {
    if (project.folderPath == null) {
      skipped.set(project.id, 'PROJECT_WORKSPACE_MISSING');
      continue;
    }
    try {
      await registerProject(project);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      skipped.set(project.id, 'PROJECT_WORKSPACE_UNSAFE');
      logWarn(`could not register project ${project.id}: ${lastError}`);
    }
  }

  const status = getMonitorStatus();
  log(
    `started in ${status.mode} mode: ${status.watchedProjects} watched, ${status.polledProjects} polled, ${status.skippedProjects} skipped`
  );
  return status;
}

/**
 * Close every watcher and timer. Idempotent, and safe to call when never started.
 *
 * Called from `closeServer`, so shutting Project Hub down does not leave handles
 * open or a timer that refuses to let the process exit.
 */
export async function stopDocumentMonitor(): Promise<void> {
  const ids = [...registrations.keys()];
  for (const id of ids) await stopRegistration(id);
  notifications.clear();
  lastSyncedHashCache.clear();
  lastSyncedAtCache.clear();
  skipped.clear();
  running = false;
  registeredAt = null;
  lastScanAt = null;
  sseClientCount = 0;
  emitter.removeAllListeners();
}

/**
 * Re-read the project list and rebuild the registrations.
 *
 * Needed when projects are created or deleted in another tab, when the Projects
 * Root setting changes, or after the database was modified underneath us. It
 * tears down and rebuilds rather than merging, so a registration for a project
 * that no longer exists cannot survive.
 */
export async function resyncDocumentMonitor(): Promise<MonitorStatus> {
  if (!running) return getMonitorStatus();

  await refreshProjectsRootCache();
  const projects = await prisma.project.findMany({
    select: { id: true, name: true, folderPath: true }
  });
  const wanted = new Set(projects.map(p => p.id));

  // Registrations for projects that no longer exist, or that no longer have a
  // folder, are dropped rather than left behind.
  for (const id of [...registrations.keys()]) {
    const project = projects.find(p => p.id === id);
    if (!project || project.folderPath == null) {
      await unregisterProject(id);
      skipped.set(id, project ? 'PROJECT_WORKSPACE_MISSING' : 'PROJECT_DELETED');
    }
  }

  for (const project of projects) {
    if (project.folderPath == null) {
      skipped.set(project.id, 'PROJECT_WORKSPACE_MISSING');
      continue;
    }
    const existing = registrations.get(project.id);
    // Already registered for exactly this folder: leave its watcher alone, so a
    // resync does not close and reopen watchers that are working.
    if (existing && existing.folderPath === path.resolve(project.folderPath)) continue;
    try {
      await registerProject(project);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      skipped.set(project.id, 'PROJECT_WORKSPACE_UNSAFE');
      logWarn(`could not re-register project ${project.id}: ${lastError}`);
    }
  }

  for (const id of [...skipped.keys()]) {
    if (!wanted.has(id)) skipped.delete(id);
  }

  return getMonitorStatus();
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/**
 * Re-check one project now, on request.
 *
 * The automatic path already exists; this is the "I just fixed the file, check
 * again" button and the hook the sync endpoint uses to settle a project after
 * Phase 6 applied a change. Still read-only.
 */
export async function checkProjectNow(projectId: number): Promise<DocumentChangeNotification | null> {
  const reg = registrations.get(projectId);
  if (!reg) return null;
  await runAnalysis(reg, 'manual');
  return notifications.get(projectId) ?? null;
}

/**
 * Dismiss the pending notification for a project.
 *
 * Dismissal is recorded so the same unchanged content is not announced again on
 * the next restart. Editing the file produces a new content hash, and therefore a
 * new notification, which is exactly the behaviour a dismissal should have.
 */
export async function dismissProjectChange(projectId: number): Promise<DocumentChangeNotification | null> {
  const current = notifications.get(projectId);
  const dismissedAt = new Date().toISOString();
  const next: DocumentChangeNotification = current
    ? { ...current, dismissedAt }
    : {
        id: `${projectId}:none:${'SYNCHRONIZED'}`,
        projectId,
        projectName: registrations.get(projectId)?.projectName ?? '',
        relativePath: `./${PROJECT_DOCUMENT_FILENAME}`,
        state: 'SYNCHRONIZED',
        mode: registrations.get(projectId)?.mode ?? 'WATCH',
        detectedAt: dismissedAt,
        documentHash: null,
        lastSyncedHash: null,
        lastSyncedAt: null,
        summary: 'No pending change.',
        projectFieldCount: 0,
        recordChangeCount: 0,
        recordCreateCount: 0,
        recordUpdateCount: 0,
        changedFieldNames: [],
        changedEntityNames: [],
        noRecordDifferences: false,
        warnings: [],
        errors: [],
        dismissedAt
      };
  notifications.set(projectId, next);
  await persistMonitorState(projectId, { projectDocumentDismissedAt: new Date(dismissedAt) });
  emitter.emit('dismissed', next);
  return next;
}

/**
 * Called after Phase 6 applied a synchronization.
 *
 * The database now matches the file, so the pending change is genuinely gone.
 * Clearing it here is what stops the monitor from immediately re-reporting the
 * change the user just resolved. Phase 6 never rewrites PROJECT.md, so the bytes
 * on disk are exactly what was applied: the new synchronized hash *is* the
 * observed hash, and re-reading it from the database keeps the two in step.
 */
export async function markProjectSynchronized(projectId: number): Promise<void> {
  const row = await prisma.project.findUnique({
    where: { id: projectId },
    select: { projectDocumentHash: true, projectDocumentSyncedAt: true }
  });

  lastSyncedHashCache.set(projectId, row?.projectDocumentHash ?? null);
  lastSyncedAtCache.set(projectId, row?.projectDocumentSyncedAt?.toISOString() ?? null);

  const reg = registrations.get(projectId);
  if (reg && row?.projectDocumentHash) reg.observedHash = row.projectDocumentHash;

  notifications.delete(projectId);
  await persistMonitorState(projectId, {
    projectDocumentLastDetectedHash: null,
    projectDocumentDetectedAt: null,
    projectDocumentChangeState: null,
    projectDocumentDismissedAt: null
  });
  emitter.emit('synchronized', { projectId });
}

export function getProjectMonitorReport(projectId: number): ProjectMonitorReport {
  const reg = registrations.get(projectId);
  const notification = notifications.get(projectId);
  const syncedHash = lastSyncedHashCache.get(projectId) ?? null;

  if (!reg) {
    // Distinguish "we know why we are not watching this" from "we were never told
    // about it", so the UI can explain an unsafe workspace rather than claiming
    // the project is simply unknown.
    const reason = skipped.get(projectId);
    return {
      projectId,
      projectName: '',
      relativePath: `./${PROJECT_DOCUMENT_FILENAME}`,
      folderPath: null,
      state: notification ? notification.state : 'UNAVAILABLE',
      mode: 'WATCH',
      monitored: false,
      unavailableReason: reason ?? 'NOT_REGISTERED',
      documentHash: notification?.documentHash ?? null,
      lastSyncedHash: syncedHash,
      lastSyncedAt: lastSyncedAtCache.get(projectId) ?? null,
      detectedAt: notification?.detectedAt ?? null,
      dismissedAt: notification?.dismissedAt ?? null,
      summary: notification?.summary ?? null,
      hasPendingChange: needsAttention(notification?.state ?? 'SYNCHRONIZED') && notification?.dismissedAt == null,
      message:
        reason === 'PROJECT_WORKSPACE_MISSING'
          ? 'This project has no workspace folder, so there is no PROJECT.md to watch.'
          : reason === 'PROJECT_WORKSPACE_UNSAFE'
            ? "This project's workspace folder does not resolve inside the configured Projects Root, so Project Hub will not read anything from it."
            : reason === 'PROJECT_DOCUMENT_PATH_SHARED'
              ? "Another project's record points at this folder, so Project Hub will not watch a file that two projects claim."
              : 'This project is not currently registered for document monitoring.'
    };
  }

  return {
    projectId,
    projectName: reg.projectName,
    relativePath: `./${PROJECT_DOCUMENT_FILENAME}`,
    folderPath: reg.folderPath,
    state: notification?.state ?? 'SYNCHRONIZED',
    mode: reg.mode,
    monitored: true,
    unavailableReason: reg.unavailableReason,
    documentHash: notification?.documentHash ?? reg.observedHash,
    lastSyncedHash: syncedHash,
    lastSyncedAt: lastSyncedAtCache.get(projectId) ?? null,
    detectedAt: notification?.detectedAt ?? null,
    dismissedAt: notification?.dismissedAt ?? null,
    summary: notification?.summary ?? null,
    hasPendingChange: needsAttention(notification?.state ?? 'SYNCHRONIZED') && notification?.dismissedAt == null,
    message: notification?.errors[0]?.message ?? null
  };
}

/** Pending changes across every registered project, newest first. */
export function listPendingChanges(): DocumentChangeNotification[] {
  return [...notifications.values()]
    .filter(n => needsAttention(n.state))
    .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
}

/** The dashboard badge number: pending, undismissed changes. */
export function countPendingChanges(): number {
  return listPendingChanges().filter(n => n.dismissedAt == null).length;
}

export function getMonitorStatus(): MonitorStatus {
  const all = [...registrations.values()];
  const watched = all.filter(r => r.mode === 'WATCH').length;
  const polled = all.filter(r => r.mode === 'POLL').length;
  const projectsRoot = safeProjectsRoot();

  let mode: ServiceMode;
  if (!running) {
    mode = 'STOPPED';
  } else if (watched === 0 && polled === 0) {
    // Running, but nothing is eligible to be watched - for example every project
    // has no usable workspace folder. Reported as WATCH with a zero count rather
    // than STOPPED, which is reserved for the service actually not running.
    mode = 'WATCH';
  } else if (polled === 0) mode = 'WATCH';
  else if (watched === 0) mode = 'POLL';
  else mode = 'HYBRID';

  return {
    running,
    mode,
    projectsRoot,
    watchedProjects: watched,
    polledProjects: polled,
    skippedProjects: countProjectsWithoutRegistration(),
    debounceMs: options.debounceMs,
    pollIntervalMs: options.pollIntervalMs,
    registeredAt,
    lastScanAt,
    lastError
  };
}

/**
 * The Projects Root, cached from the setting.
 *
 * `getProjectsRoot` probes the filesystem and is async, which `getMonitorStatus`
 * cannot be. The root is refreshed whenever the monitor registers or rescans, and
 * reported from the cache in between, so the status endpoint stays a cheap
 * synchronous read and never blocks a status poll on disk I/O.
 */
function safeProjectsRoot(): string | null {
  return projectsRootCache;
}

async function refreshProjectsRootCache(): Promise<string | null> {
  try {
    const response = await getProjectsRoot();
    projectsRootCache = response.path;
  } catch {
    projectsRootCache = null;
  }
  return projectsRootCache;
}

/**
 * Registered projects are every project with a workspace folder.
 * `skippedProjects` is the difference: projects with no folder at all, or whose
 * folder cannot be resolved inside the Projects Root, which cannot be watched.
 */
function countProjectsWithoutRegistration(): number {
  return skipped.size;
}

/** Why a project is not monitored, for the diagnostics view. */
export function listSkippedProjects(): { projectId: number; reason: string }[] {
  return [...skipped.entries()].map(([projectId, reason]) => ({ projectId, reason }));
}

// ---------------------------------------------------------------------------
// Event bus (used by the SSE endpoint)
// ---------------------------------------------------------------------------

export interface MonitorEvent {
  kind: 'notification' | 'dismissed' | 'synchronized' | 'snapshot';
  payload: unknown;
}

export function subscribeToMonitor(listener: (event: MonitorEvent) => void): () => void {
  const onNotification = (payload: DocumentChangeNotification) => listener({ kind: 'notification', payload });
  const onDismissed = (payload: DocumentChangeNotification) => listener({ kind: 'dismissed', payload });
  const onSynchronized = (payload: { projectId: number }) => listener({ kind: 'synchronized', payload });
  emitter.on('notification', onNotification);
  emitter.on('dismissed', onDismissed);
  emitter.on('synchronized', onSynchronized);
  sseClientCount += 1;
  return () => {
    emitter.off('notification', onNotification);
    emitter.off('dismissed', onDismissed);
    emitter.off('synchronized', onSynchronized);
    sseClientCount = Math.max(0, sseClientCount - 1);
  };
}

export function monitorSubscriberCount(): number {
  return sseClientCount;
}

/**
 * Assert the project exists before any monitoring endpoint touches it. Keeps a
 * bad id a clean 404 instead of an unhandled Prisma error.
 */
export async function requireProject(projectId: number): Promise<{ id: number; name: string; folderPath: string | null }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, folderPath: true }
  });
  if (!project) {
    throw new ApiError(404, 'Project not found.', undefined, {
      category: 'NOT_FOUND',
      operation: 'open the document monitor for this project',
      possibleAction: 'Go back to the project list and open an existing project.'
    });
  }
  return project;
}