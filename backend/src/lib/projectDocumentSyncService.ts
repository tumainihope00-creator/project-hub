import fsp from 'node:fs/promises';
import { ApiError } from './errors.js';
import { parseProjectDocument, type ParsedProjectDocument } from './projectDocumentParser.js';
import {
  ChangeSet,
  SyncResult,
  SyncProjectRow,
  buildBaseline,
  buildChangeSet,
  applyChangeSet,
  hashContent
} from './projectDocumentSync.js';
import {
  advanceBaseline,
  conflictFieldNames,
  normalizeCell,
  parseBaseline,
  type FieldVerdict,
  type SyncBaseline,
  type SyncState
} from './projectDocumentBaseline.js';
import { loadProjectDocumentData, resolveProjectDocumentPath } from './projectDocument.js';
import { prisma } from './prisma.js';
import type { Prisma } from '@prisma/client';

/**
 * Phase 6, part three: the explicit, user-triggered synchronization flow.
 *
 *   read PROJECT.md -> parse -> compare against the baseline -> (preview stops here)
 *                                                  -> (sync applies in one transaction)
 *
 * Nothing in this file runs on a timer, on startup, or on a request that does not
 * explicitly ask for it. There is no watcher, no poll, and no background job: the
 * only way a document reaches the database is the user pressing "Synchronize".
 *
 * `preview` is the same pipeline as `sync` up to and including building the change
 * set, and it never opens a write. `sync` re-runs the identical pipeline (so the
 * preview the user saw and the applied set cannot disagree) and then applies.
 *
 * Loop prevention: a synchronization records the hash of the file it applied. If a
 * later sync sees the same hash, the document has not changed since the last one
 * and the engine reports `unchanged` with nothing to do. Because a sync never
 * rewrites PROJECT.md, and the document is only ever read here, the
 * DB -> document -> DB cycle cannot start.
 *
 * LOGGING. Every outcome gets one line on stdout/stderr with the `[project-document-sync]`
 * prefix, so a synchronization is visible in the backend log without attaching a
 * debugger. What is logged is deliberately limited to the project id and name, the
 * counts, the field names, and the error codes: never the document content, never a
 * field value, and never a path. `readAndBuild` itself is silent, because the card
 * on the details page calls the state endpoint on every load and that would be
 * noise rather than an event.
 */

const LOG_PREFIX = '[project-document-sync]';

function log(message: string, ...rest: unknown[]): void {
  console.log(`${LOG_PREFIX} ${message}`, ...rest);
}

function logWarn(message: string, ...rest: unknown[]): void {
  console.warn(`${LOG_PREFIX} ${message}`, ...rest);
}

/**
 * The field names a change set touches: project column names first, then one
 * `entity:key` entry per child record. Identical in shape to the `metadata` the
 * activity event records, so the log line, the API response and the timeline can
 * be compared by eye.
 */
function describeFields(projectChanges: ChangeSet['projectChanges'], childChanges: ChangeSet['childChanges']): string[] {
  return [
    ...projectChanges.map((c) => c.field),
    ...childChanges.map((c) => `${c.entity}:${c.key}`)
  ];
}

/** Which way data moved. Recorded per run so the history reads as a narrative. */
export type SyncDirection =
  | 'MARKDOWN_TO_DATABASE'
  | 'DATABASE_TO_MARKDOWN'
  | 'CONFLICT_RESOLUTION';

/** One conflicting field, flattened for the UI. */
export interface SyncConflictView {
  /** Column name, e.g. `description` or `acceptanceCriteria`. */
  field: string;
  scope: 'project' | 'record';
  entity: string | null;
  key: string | null;
  label: string | null;
  /** What the two sides last agreed on. Null when there was no agreement recorded. */
  baseline: string | null;
  databaseValue: string | null;
  markdownValue: string | null;
}

/** One entry of synchronization history, read back from the activity timeline. */
export interface SyncHistoryEntry {
  at: string | null;
  direction: SyncDirection | null;
  state: string | null;
  applied: string[];
  databaseKept: string[];
  conflicts: string[];
  resolutions: { target: string; choice: string }[];
  warnings: number;
  actor: string | null;
  description: string;
}

export interface SyncStateSummary {
  /** `unavailable` when there is no readable PROJECT.md to compare. */
  state: SyncState | 'unavailable';
  baseline: { available: boolean; capturedAt: string | null; documentHash: string | null };
  conflicts: SyncConflictView[];
  conflictFields: string[];
  /** Fields only PROJECT.md changed. Safe to apply. */
  markdownChanged: string[];
  /** Fields only the database moved. Kept as they are. */
  databaseChanged: string[];
  modified: boolean;
  neverSynchronized: boolean;
  /** Phase 6 spelling of "has at least one conflict". */
  conflict: boolean;
}

/** The stable name of one classified field, used in responses, logs and metadata. */
function verdictName(v: { scope: string; field: string; entity: string | null; key: string | null }): string {
  return v.scope === 'project' ? v.field : `${v.entity}:${v.key}.${v.field}`;
}

function toConflictView(v: FieldVerdict): SyncConflictView {
  return {
    field: v.field,
    scope: v.scope,
    entity: v.entity,
    key: v.key,
    label: v.label,
    baseline: v.baseline,
    databaseValue: v.databaseValue,
    markdownValue: v.markdownValue
  };
}

export interface PreviewResult {
  /** False when the change set has errors or unresolved conflicts. */
  success: boolean;
  /** True when the change set would write at least one field or record. */
  changed: boolean;
  /** The fields this change set touches: project columns, then `entity:key` records. */
  updatedFields: string[];
  projectId: number;
  projectName: string;
  relativePath: string;
  documentVersion: number | null;
  documentHash: string;
  /** True when the file is identical to the last generate/sync. */
  unchanged: boolean;
  firstSynchronization: boolean;
  conflict: boolean;
  /** False when the change set cannot be applied (errors present). */
  applicable: boolean;
  projectChanges: ChangeSet['projectChanges'];
  childChanges: ChangeSet['childChanges'];
  unmatchedDatabaseRecords: ChangeSet['unmatchedDatabaseRecords'];
  warnings: ChangeSet['warnings'];
  errors: ChangeSet['errors'];
  unsupportedSections: string[];
  preservedDetailSections: ChangeSet['preservedDetailSections'];
  /** Phase 7: the classified state and what is safe, held back, or kept. */
  sync: SyncStateSummary;
}

/** The project fields the sync engine reads, plus the document metadata columns. */
async function loadSyncProject(
  projectId: number
): Promise<SyncProjectRow & { folderPath: string | null; projectDocumentBaseline: unknown }> {
  const row = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      folderPath: true,
      projectDocumentHash: true,
      projectDocumentStateHash: true,
      projectDocumentSyncedAt: true,
      projectDocumentBaseline: true
    }
  });
  if (!row) {
    throw new ApiError(404, 'Project not found.', undefined, {
      category: 'NOT_FOUND',
      operation: 'load the project to synchronize its PROJECT.md',
      possibleAction: 'Go back to the project list and open an existing project.'
    });
  }
  return row;
}

type SyncProject = Awaited<ReturnType<typeof loadSyncProject>>;

/**
 * Read the project's PROJECT.md.
 *
 * The path is resolved from the stored workspace, never from the request. Every
 * failure mode is a typed error the UI can explain.
 */
async function readDocumentContent(project: { folderPath: string | null }): Promise<string> {
  // Reuse the Phase 4 path resolver so this feature cannot drift from it: it is
  // the same Projects Root containment and symlink policy.
  const resolved = await resolveProjectDocumentPath({ folderPath: project.folderPath });
  if (!resolved.available) {
    throw new ApiError(
      409,
      resolved.message,
      { code: resolved.reason, relativePath: './PROJECT.md' },
      {
        category: 'VALIDATION_FAILED',
        operation: 'resolve the PROJECT.md path to synchronize',
        possibleAction: resolved.possibleAction
      }
    );
  }

  try {
    return await fsp.readFile(resolved.path.documentPath, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new ApiError(
        404,
        'This project does not have a PROJECT.md to synchronize.',
        { code: 'PROJECT_DOCUMENT_MISSING', relativePath: resolved.path.relativePath },
        {
          category: 'NOT_FOUND',
          operation: 'read PROJECT.md to synchronize',
          possibleAction: 'Generate PROJECT.md from the project record first, then edit it and synchronize.'
        }
      );
    }
    throw new ApiError(
      500,
      `Project Hub could not read PROJECT.md (${e.code ?? 'unknown error'}).`,
      { code: 'PROJECT_DOCUMENT_READ_FAILED', documentPath: resolved.path.documentPath },
      {
        category: 'FILESYSTEM_ERROR',
        operation: 'read PROJECT.md to synchronize',
        possibleAction: 'Check that the workspace folder exists and is readable.'
      }
    );
  }
}

/**
 * Read the project's PROJECT.md and build the change set.
 *
 * The baseline is read from the project row and passed in as the third side of
 * every comparison. A project that has never been synchronized in this phase has
 * none, and that is a supported state: `buildChangeSet` reports every difference
 * as a conflict rather than guessing, and the baseline is adopted here (in memory
 * only, this function never writes) once the two sides are seen to agree.
 */
async function readAndBuild(projectId: number): Promise<{
  project: SyncProject;
  content: string;
  parsed: ParsedProjectDocument;
  changeSet: ChangeSet;
  baseline: SyncBaseline | null;
}> {
  const project = await loadSyncProject(projectId);
  const content = await readDocumentContent(project);
  const parsed = parseProjectDocument(content);
  const data = await loadProjectDocumentData(projectId);
  const baseline = parseBaseline(project.projectDocumentBaseline);
  const changeSet = buildChangeSet(project, parsed, content, data, baseline);
  return { project, content, parsed, changeSet, baseline };
}

/**
 * The baseline that the next comparison should use.
 *
 * Derived from the document that was just analyzed, advanced past the fields that
 * are still in conflict: an unresolved field keeps its old baseline value, so the
 * conflict stays visible until somebody decides. `null` when there was no baseline
 * and none can be derived - the project then has, by definition, never agreed.
 */
function nextBaselineFor(
  existing: SyncBaseline | null,
  parsed: ParsedProjectDocument,
  documentHash: string,
  unresolved: FieldVerdict[]
): SyncBaseline | null {
  const derived = buildBaseline(parsed, documentHash);
  if (!derived) return existing;
  return advanceBaseline(existing, derived, unresolved);
}

/** Write one classified field's value into a baseline map, used by manual resolutions. */
function setBaselineValue(baseline: SyncBaseline, v: FieldVerdict, value: string | null): void {
  if (v.scope === 'project') {
    baseline.project[v.field] = normalizeCell(value);
    return;
  }
  const entity = (baseline.records[v.entity as string] ??= {});
  const fields = (entity[v.key as string] ??= {});
  fields[v.field] = normalizeCell(value);
}

/** The value a field will be written as, matching the engine's own convention. */
function asWriteText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * A change set with every conflicting field also written from the document.
 *
 * This is what the legacy `acknowledgeConflict` means now: "I have seen the
 * conflicts, let PROJECT.md win". Without it, conflicts are reported and nothing
 * is written.
 */
function withMarkdownWins(conflicts: FieldVerdict[], changeSet: ChangeSet): ChangeSet {
  const projectChanges = [...changeSet.projectChanges];
  const childChanges = [...changeSet.childChanges];
  for (const c of conflicts) {
    if (c.scope === 'project') {
      projectChanges.push({
        field: c.field,
        from: asWriteText(c.databaseValue),
        to: asWriteText(c.markdownValue)
      });
      continue;
    }
    const change = {
      entity: c.entity!,
      action: 'update' as const,
      key: c.key!,
      label: c.label ?? c.key!,
      changes: [
        { field: c.field, from: asWriteText(c.databaseValue), to: asWriteText(c.markdownValue) }
      ]
    };
    const existing = childChanges.findIndex(
      (ch) => ch.entity === change.entity && ch.key === change.key && ch.action === 'update'
    );
    if (existing >= 0) {
      childChanges[existing]!.changes.push(...change.changes);
    } else {
      childChanges.push(change);
    }
  }
  return { ...changeSet, projectChanges, childChanges, conflicts: [] };
}

/**
 * Persist the bookkeeping of a run that wrote nothing.
 *
 * Used when a document is already in step with the database, or when only the
 * database moved. No activity row: "nothing happened" is not an event, and a
 * timeline full of it is a timeline nobody reads.
 */
async function recordSyncOutcome(
  projectId: number,
  outcome: {
    state: SyncState;
    direction: SyncDirection;
    conflictFields: string[];
    baseline: SyncBaseline | null;
  }
): Promise<void> {
  await prisma.project.update({
    where: { id: projectId },
    data: {
      projectDocumentSyncState: outcome.state,
      projectDocumentSyncDirection: outcome.direction,
      projectDocumentConflictFields: outcome.conflictFields,
      ...(outcome.baseline
        ? { projectDocumentBaseline: outcome.baseline as unknown as Prisma.InputJsonValue }
        : {})
    }
  });
}

/**
 * One synchronization at a time per project.
 *
 * Two overlapping syncs would both read the same document, both diff it, and the
 * second apply would be based on a stale read. A promise chain keyed by project id
 * is enough for a single-process backend and costs nothing at this scale.
 */
const projectLocks = new Map<number, Promise<void>>();

async function withProjectLock<T>(projectId: number, fn: () => Promise<T>): Promise<T> {
  const previous = projectLocks.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => held);
  projectLocks.set(projectId, tail);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (projectLocks.get(projectId) === tail) projectLocks.delete(projectId);
  }
}

/**
 * Re-read the file and confirm it is still the one that was analyzed.
 *
 * Between the preview and the apply the user may have saved again - or an editor
 * may have written twice in quick succession, which is exactly the case a change
 * aware engine gets wrong if it trusts a hash it took a moment ago. Returns the
 * reason instead of throwing so the caller can return a refusal the UI can show.
 */
async function verifyDocumentUnchanged(
  project: { folderPath: string | null },
  expectedHash: string
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  let content: string;
  try {
    content = await readDocumentContent(project);
  } catch {
    return {
      ok: false,
      code: 'DOCUMENT_UNREADABLE_DURING_SYNC',
      message: 'PROJECT.md could not be read again before applying, so nothing was written.'
    };
  }
  if (hashContent(content) !== expectedHash) {
    return {
      ok: false,
      code: 'DOCUMENT_CHANGED_DURING_SYNC',
      message:
        'PROJECT.md changed while it was being synchronized. Nothing was written; preview again and apply the newer version.'
    };
  }
  return { ok: true };
}

function toPreview(project: SyncProjectRow, changeSet: ChangeSet): PreviewResult {
  const applicable = changeSet.errors.length === 0;
  const conflicts = changeSet.conflicts.map(toConflictView);
  return {
    success: applicable,
    changed: changeSet.projectChanges.length + changeSet.childChanges.length > 0,
    updatedFields: describeFields(changeSet.projectChanges, changeSet.childChanges),
    projectId: project.id,
    projectName: project.name,
    relativePath: './PROJECT.md',
    documentVersion: changeSet.documentVersion,
    documentHash: changeSet.documentHash,
    unchanged: changeSet.unchanged,
    firstSynchronization: changeSet.firstSynchronization,
    conflict: changeSet.conflicts.length > 0,
    applicable,
    projectChanges: changeSet.projectChanges,
    childChanges: changeSet.childChanges,
    unmatchedDatabaseRecords: changeSet.unmatchedDatabaseRecords,
    warnings: changeSet.warnings,
    errors: changeSet.errors,
    unsupportedSections: changeSet.unsupportedSections,
    preservedDetailSections: changeSet.preservedDetailSections,
    sync: {
      state: changeSet.syncState,
      baseline: {
        available: changeSet.baselineAvailable,
        capturedAt: changeSet.baselineCapturedAt ?? null,
        documentHash: null
      },
      conflicts,
      conflictFields: conflictFieldNames(changeSet.conflicts),
      markdownChanged: changeSet.verdicts
        .filter((v) => v.state === 'markdown_changed')
        .map(verdictName),
      databaseChanged: changeSet.databaseChanges.map(verdictName),
      modified: !changeSet.unchanged,
      neverSynchronized: changeSet.firstSynchronization,
      conflict: changeSet.conflicts.length > 0
    }
  };
}

/**
 * Build a preview. Performs no database write of any kind.
 */
export async function previewProjectDocumentSync(projectId: number): Promise<PreviewResult> {
  const { project, changeSet } = await readAndBuild(projectId);
  const preview = toPreview(project, changeSet);
  log(
    `preview project ${project.id} (${project.name}): ` +
      `${preview.applicable ? 'applicable' : 'refused'}, state=${preview.sync.state}, ` +
      `safe=${preview.sync.markdownChanged.length}, conflicts=${preview.sync.conflictFields.length}, ` +
      `kept=${preview.sync.databaseChanged.length}` +
      (preview.errors.length ? `, errors=[${preview.errors.map((e) => e.code).join(', ')}]` : '')
  );
  return preview;
}

export interface SyncRunResult extends PreviewResult {
  applied: SyncResult | null;
  /** Why nothing was applied, when applicable. */
  skipped: 'unchanged' | 'not_applicable' | null;
}

export interface ConflictResolutionInput {
  /** The classified field name, as returned in `sync.conflictFields`. */
  field: string;
  scope: 'project' | 'record';
  entity?: string | null;
  key?: string | null;
  choice: 'database' | 'markdown' | 'manual';
  /** Required for `choice: 'manual'`. */
  value?: string | null;
}

/**
 * Apply the document to the database.
 *
 * Refuses to write anything when:
 *  - the change set has errors (wrong project, unknown version, duplicate keys);
 *  - there are unresolved conflicts and the caller did not decide;
 *  - the document changed on disk between the read and the apply.
 *
 * In every one of those cases the database is left exactly as it was, and the
 * response carries the conflicts so the UI can offer the per-field choices.
 *
 * `acknowledgeConflict` keeps its Phase 6 meaning and is still supported: it means
 * "let PROJECT.md win every conflicting field". Prefer `resolveProjectDocumentConflicts`,
 * which decides field by field.
 */
export async function runProjectDocumentSync(
  projectId: number,
  options: { acknowledgeConflict?: boolean; actor?: string }
): Promise<SyncRunResult> {
  return withProjectLock(projectId, async () => {
    const { project, changeSet, parsed, baseline } = await readAndBuild(projectId);

    if (changeSet.errors.length > 0) {
      const preview = toPreview(project, changeSet);
      logWarn(
        `sync refused for project ${project.id} (${project.name}): ` +
          `[${preview.errors.map((e) => e.code).join(', ')}]. Nothing was applied.`
      );
      return { ...preview, success: false, applied: null, skipped: 'not_applicable' };
    }

    const actor = options.actor ?? 'user';

    if (changeSet.conflicts.length > 0 && !options.acknowledgeConflict) {
      // Stop and report. The safe changes are held back with everything else,
      // because applying half a decision set leaves the user guessing which half
      // landed. Resolving the conflicts is a separate, explicit request.
      const preview = toPreview(project, changeSet);
      const names = conflictFieldNames(changeSet.conflicts);
      logWarn(
        `sync refused for project ${project.id} (${project.name}): ${names.length} conflicting field(s) ` +
          `[${names.join(', ')}] are unresolved. Nothing was applied.`
      );
      return {
        ...preview,
        success: false,
        changed: false,
        updatedFields: [],
        applicable: false,
        applied: null,
        skipped: 'not_applicable',
        errors: [
          ...preview.errors,
          {
            code: 'UNRESOLVED_CONFLICTS',
            message:
              `${names.length} field(s) changed in both PROJECT.md and the project record: ${names.join(', ')}. ` +
              `Choose which value to keep for each one, then apply. Nothing was written.`
          }
        ]
      };
    }

    // The document wins every conflict when it was acknowledged, so those fields are
    // no longer unresolved and the baseline can move on them.
    const applyConflicts = options.acknowledgeConflict ? [] : changeSet.conflicts;
    const changeSetToApply = options.acknowledgeConflict
      ? withMarkdownWins(changeSet.conflicts, changeSet)
      : changeSet;
    const nextBaseline = nextBaselineFor(baseline, parsed, changeSet.documentHash, applyConflicts);

    const hasWrites =
      changeSetToApply.projectChanges.length + changeSetToApply.childChanges.length > 0;

    if (!hasWrites && (baseline !== null || nextBaseline === null)) {
      // Nothing to write. The agreement can still move: when the document and the
      // record now hold the same value for every compared field - which is what a
      // `both_changed` verdict means - the baseline advances and the state settles
      // to `synchronized`. When only the database moved, it must NOT: the baseline
      // records the document, so adopting it there would claim the document agrees
      // with a value it does not contain, and the next edit to that field would be
      // measured against a fiction.
      const agreementReached =
        changeSet.conflicts.length === 0 && changeSet.databaseChanges.length === 0;
      await recordSyncOutcome(projectId, {
        state: agreementReached ? 'synchronized' : changeSet.syncState,
        direction: 'MARKDOWN_TO_DATABASE',
        conflictFields: [],
        baseline: agreementReached ? nextBaseline : null
      });
      log(`sync project ${project.id} (${project.name}): ${changeSet.syncState}, nothing to apply.`);
      const after = await readAndBuild(projectId);
      return {
        ...toPreview(after.project, after.changeSet),
        changed: false,
        updatedFields: [],
        applied: null,
        skipped: changeSet.unchanged ? 'unchanged' : null
      };
    }

    const guard = await verifyDocumentUnchanged(project, changeSet.documentHash);
    if (!guard.ok) {
      const preview = toPreview(project, changeSet);
      logWarn(`sync refused for project ${project.id} (${project.name}): ${guard.code}.`);
      return {
        ...preview,
        success: false,
        changed: false,
        updatedFields: [],
        applicable: false,
        applied: null,
        skipped: 'not_applicable',
        errors: [...preview.errors, { code: guard.code, message: guard.message }]
      };
    }

    if (!hasWrites) {
      // The one case where a run writes no project data: a project that predates
      // synchronization and whose document already agrees with the database. The
      // agreement is now recorded, which is what makes every later comparison
      // meaningful. No activity row: the project has not changed, only what Project
      // Hub knows about it has.
      await recordSyncOutcome(projectId, {
        state: 'synchronized',
        direction: 'MARKDOWN_TO_DATABASE',
        conflictFields: [],
        baseline: nextBaseline
      });
      log(`sync project ${project.id} (${project.name}): baseline established, nothing to apply.`);
      const after = await readAndBuild(projectId);
      return {
        ...toPreview(after.project, after.changeSet),
        changed: false,
        updatedFields: [],
        applied: null,
        skipped: null
      };
    }

    const resolutions =
      options.acknowledgeConflict && changeSet.conflicts.length > 0
        ? changeSet.conflicts.map((c) => ({ target: verdictName(c), choice: 'markdown' }))
        : undefined;

    log(
      `sync project ${project.id} (${project.name}): applying ${describeFields(changeSetToApply.projectChanges, changeSetToApply.childChanges).length} change(s), ` +
        `${changeSet.databaseChanges.length} database change(s) kept`
    );
    const applied = await applyChangeSet(projectId, changeSetToApply, {
      actor,
      baseline: nextBaseline,
      direction: 'MARKDOWN_TO_DATABASE',
      resolutions
    });

    // After applying, the file is now the last-synced state. Return a fresh preview
    // so the UI shows the post-sync position. `changed` and `updatedFields` describe
    // what this run actually wrote, not what the post-sync preview can still see, so
    // they are taken from `applied`.
    const after = await readAndBuild(projectId);
    const updatedFields = [
      ...applied.appliedProjectChanges.map((c) => c.field),
      ...applied.appliedChildChanges.map((c) => `${c.entity}:${c.key}`)
    ];
    log(
      `sync complete for project ${project.id}: ${updatedFields.length} field(s)/record(s) updated` +
        (updatedFields.length ? ` [${updatedFields.join(', ')}]` : '') +
        (applied.conflictFields.length ? `, ${applied.conflictFields.length} still conflicting` : '')
    );
    return {
      ...toPreview(after.project, after.changeSet),
      changed: updatedFields.length > 0,
      updatedFields,
      applied,
      skipped: null
    };
  });
}

/**
 * Decide conflicting fields and apply the decisions in one transaction.
 *
 * A resolution is per field, because a conflict is per field. `database` writes
 * nothing and leaves the database value authoritative; `markdown` writes the
 * document's value; `manual` writes the value supplied. Fields not named in
 * `resolutions` stay in conflict, keep their old baseline value, and are reported
 * again in the result - a partially resolved set is a real state, not a failure.
 */
export async function resolveProjectDocumentConflicts(
  projectId: number,
  resolutions: ConflictResolutionInput[],
  options: { actor?: string } = {}
): Promise<SyncRunResult> {
  return withProjectLock(projectId, async () => {
    if (resolutions.length === 0) {
      throw new ApiError(400, 'No conflict resolutions were provided.', { code: 'NO_RESOLUTIONS' }, {
        category: 'VALIDATION_FAILED',
        operation: 'resolve conflicting PROJECT.md fields',
        possibleAction: 'Choose "Keep database" or "Keep PROJECT.md" for at least one conflicting field.'
      });
    }

    const { project, changeSet, parsed, baseline } = await readAndBuild(projectId);
    if (changeSet.errors.length > 0) {
      throw new ApiError(
        409,
        `PROJECT.md has ${changeSet.errors.length} problem(s) that must be fixed before conflicts can be resolved.`,
        { code: 'CHANGE_SET_HAS_ERRORS', errors: changeSet.errors.map((e) => e.code) },
        {
          category: 'VALIDATION_FAILED',
          operation: 'resolve conflicting PROJECT.md fields',
          possibleAction: 'Fix the reported problems in PROJECT.md, preview again, then resolve.'
        }
      );
    }

    const current = new Map(changeSet.conflicts.map((c) => [verdictName(c), c] as const));
    const decisions = resolutions.map((r) => {
      const name = r.scope === 'project' ? r.field : `${r.entity}:${r.key}.${r.field}`;
      const verdict = current.get(name);
      if (!verdict) {
        throw new ApiError(
          409,
          `"${name}" is not a conflicting field right now. The project may have changed since the conflict list was loaded.`,
          { code: 'NOT_A_CURRENT_CONFLICT', field: name, conflictingFields: [...current.keys()] },
          {
            category: 'VALIDATION_FAILED',
            operation: 'resolve conflicting PROJECT.md fields',
            possibleAction: 'Preview again and resolve the conflicts that are still listed.'
          }
        );
      }
      if (r.choice === 'manual' && r.value == null) {
        throw new ApiError(
          400,
          `"${name}" was resolved manually but no value was supplied.`,
          { code: 'MANUAL_VALUE_REQUIRED', field: name },
          {
            category: 'VALIDATION_FAILED',
            operation: 'resolve conflicting PROJECT.md fields',
            possibleAction: 'Enter the value to store for this field.'
          }
        );
      }
      return { verdict, name, choice: r.choice, value: r.value ?? null };
    });

    const resolvedNames = new Set(decisions.map((d) => d.name));
    const remaining = changeSet.conflicts.filter((c) => !resolvedNames.has(verdictName(c)));

    const derived = buildBaseline(parsed, changeSet.documentHash);
    const nextBaseline = derived
      ? advanceBaseline(baseline, derived, remaining)
      : baseline;
    if (nextBaseline) {
      // A manual value is the agreement going forward, so it - not the document's
      // value - is what the next comparison starts from.
      for (const d of decisions) {
        if (d.choice === 'manual') setBaselineValue(nextBaseline, d.verdict, d.value);
      }
    }

    const projectChanges = changeSet.projectChanges.filter((c) => !resolvedNames.has(c.field));
    const childChanges = changeSet.childChanges.filter(
      (ch) => !(ch.action === 'update' && resolvedNames.has(`${ch.entity}:${ch.key}`))
    );
    for (const d of decisions) {
      if (d.choice === 'database') continue; // the database value stands; nothing to write
      const to = d.choice === 'manual' ? asWriteText(d.value) : asWriteText(d.verdict.markdownValue);
      if (d.verdict.scope === 'project') {
        projectChanges.push({
          field: d.verdict.field,
          from: asWriteText(d.verdict.databaseValue),
          to
        });
        continue;
      }
      childChanges.push({
        entity: d.verdict.entity!,
        action: 'update',
        key: d.verdict.key!,
        label: d.verdict.label ?? d.verdict.key!,
        changes: [{ field: d.verdict.field, from: asWriteText(d.verdict.databaseValue), to }]
      });
    }

    const changeSetToApply: ChangeSet = {
      ...changeSet,
      projectChanges,
      childChanges,
      conflicts: remaining,
      databaseChanges: changeSet.databaseChanges.filter((c) => !resolvedNames.has(verdictName(c)))
    };

    const guard = await verifyDocumentUnchanged(project, changeSet.documentHash);
    if (!guard.ok) {
      throw new ApiError(409, guard.message, { code: guard.code }, {
        category: 'VALIDATION_FAILED',
        operation: 'resolve conflicting PROJECT.md fields',
        possibleAction: 'Preview again and resolve the newer version of the document.'
      });
    }

    const actor = options.actor ?? 'user';
    const hasWrites = changeSetToApply.projectChanges.length + changeSetToApply.childChanges.length > 0;

    if (hasWrites) {
      await applyChangeSet(projectId, changeSetToApply, {
        actor,
        baseline: nextBaseline,
        direction: 'CONFLICT_RESOLUTION',
        resolutions: decisions.map((d) => ({ target: d.name, choice: d.choice }))
      });
    } else {
      // Every decision was "keep database", so nothing is written. The baseline
      // still moves onto the document's values: that is what stops the rejected
      // text from being resurrected by the next synchronization.
      await recordSyncOutcome(projectId, {
        state: remaining.length > 0 ? 'conflict' : 'synchronized',
        direction: 'CONFLICT_RESOLUTION',
        conflictFields: conflictFieldNames(remaining),
        baseline: nextBaseline
      });
    }

    const appliedFields = [
      ...changeSetToApply.projectChanges.map((c) => c.field),
      ...changeSetToApply.childChanges.map((c) => `${c.entity}:${c.key}`)
    ];
    log(
      `resolved ${decisions.length} conflict(s) for project ${project.id} (${project.name}): ` +
        `[${decisions.map((d) => `${d.name}=${d.choice}`).join(', ')}]` +
        (remaining.length ? `, ${remaining.length} still unresolved` : '')
    );

    const after = await readAndBuild(projectId);
    // The cached state must agree with the classification the user is about to see,
    // so it is written from the fresh comparison rather than from what the engine
    // believed before the decision.
    const agreementReached =
      after.changeSet.conflicts.length === 0 && after.changeSet.databaseChanges.length === 0;
    await recordSyncOutcome(projectId, {
      state: agreementReached ? 'synchronized' : after.changeSet.syncState,
      direction: 'CONFLICT_RESOLUTION',
      conflictFields: conflictFieldNames(after.changeSet.conflicts),
      baseline: null
    });

    return {
      ...toPreview(after.project, after.changeSet),
      success: true,
      changed: appliedFields.length > 0,
      updatedFields: appliedFields,
      applied: null,
      skipped: null
    };
  });
}

/**
 * Advance the baseline after Project Hub writes PROJECT.md itself.
 *
 * A generate or regenerate renders the document from the database, so the two
 * sides agree by construction. Recording that agreement is what stops the next
 * preview from reporting every freshly generated line as a conflict - the case
 * §28 of the phase is about.
 *
 * The file is re-read rather than passed in, because the route that generated it
 * holds a status object and a byte count, not the content, and re-reading one
 * small file is cheaper than threading content through three call sites.
 *
 * This never throws: failing a generate because bookkeeping could not be written
 * would be a worse outcome than a missing baseline, which the next synchronization
 * recovers by adopting.
 */
export async function recordGeneratedBaseline(projectId: number): Promise<void> {
  try {
    const project = await loadSyncProject(projectId);
    const content = await readDocumentContent(project);
    const parsed = parseProjectDocument(content);
    const baseline = buildBaseline(parsed, hashContent(content));
    if (!baseline) return;
    await prisma.project.update({
      where: { id: projectId },
      data: {
        projectDocumentBaseline: baseline as unknown as Prisma.InputJsonValue,
        projectDocumentSyncState: 'synchronized',
        projectDocumentSyncDirection: 'DATABASE_TO_MARKDOWN',
        projectDocumentConflictFields: []
      }
    });
    log(`generated document for project ${projectId}: baseline captured at ${baseline.capturedAt}.`);
  } catch (err) {
    logWarn(
      `could not capture the baseline for project ${projectId} after generating PROJECT.md: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function parseHistoryMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Synchronization history, read back from the activity timeline.
 *
 * There is no separate audit table for this, deliberately: every synchronization
 * already writes one activity row inside its transaction, with the direction, the
 * fields it wrote, the fields it held back, and the decisions behind that in
 * `metadata`. A new table would hold the same facts in a second place that could
 * disagree with the timeline.
 */
async function loadSyncHistory(projectId: number): Promise<SyncHistoryEntry[]> {
  const events = await prisma.activityEvent.findMany({
    where: { projectId, relatedType: 'ProjectDocumentSync' },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { createdAt: true, description: true, metadata: true }
  });
  return events.map((event) => {
    const meta = parseHistoryMetadata(event.metadata);
    const created = asStringArray(meta.created);
    const updated = asStringArray(meta.updated);
    const resolutions = Array.isArray(meta.resolutions)
      ? meta.resolutions.flatMap((r) => {
          const row = r as { target?: unknown; choice?: unknown };
          return typeof row?.target === 'string' && typeof row.choice === 'string'
            ? [{ target: row.target, choice: row.choice }]
            : [];
        })
      : [];
    return {
      at: event.createdAt.toISOString(),
      direction: typeof meta.direction === 'string' ? (meta.direction as SyncDirection) : null,
      state: typeof meta.state === 'string' ? meta.state : null,
      applied: [...asStringArray(meta.projectFields), ...created, ...updated],
      databaseKept: asStringArray(meta.databaseKept),
      conflicts: asStringArray(meta.conflicts),
      resolutions,
      warnings: typeof meta.warnings === 'number' ? meta.warnings : 0,
      actor: typeof meta.actor === 'string' ? meta.actor : null,
      description: event.description
    };
  });
}

/**
 * The full synchronization status for the details page: the classified state, every
 * conflict with both values and the baseline that preceded them, what is safe to
 * apply, what the database moved on its own, and the recent history.
 *
 * Read-only. A project with no readable document reports `unavailable` instead of
 * failing, because this is what the card calls on every page load.
 */
export async function projectDocumentSyncStatus(projectId: number): Promise<
  PreviewResult & { history: SyncHistoryEntry[]; lastSyncedAt: string | null; lastSyncedHash: string | null }
> {
  let built: Awaited<ReturnType<typeof readAndBuild>> | null = null;
  let unavailable: string | null = null;
  try {
    built = await readAndBuild(projectId);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    unavailable = err.message;
  }

  const history = await loadSyncHistory(projectId);

  if (!built) {
    const project = await loadSyncProject(projectId);
    const baseline = parseBaseline(project.projectDocumentBaseline);
    return {
      success: false,
      changed: false,
      updatedFields: [],
      projectId: project.id,
      projectName: project.name,
      relativePath: './PROJECT.md',
      documentVersion: null,
      documentHash: '',
      unchanged: true,
      firstSynchronization: project.projectDocumentHash == null,
      conflict: false,
      applicable: false,
      projectChanges: [],
      childChanges: [],
      unmatchedDatabaseRecords: [],
      warnings: [],
      errors: [{ code: 'PROJECT_DOCUMENT_UNAVAILABLE', message: unavailable ?? 'PROJECT.md is not available.' }],
      unsupportedSections: [],
      preservedDetailSections: [],
      sync: {
        state: 'unavailable',
        baseline: {
          available: baseline != null,
          capturedAt: baseline?.capturedAt ?? null,
          documentHash: baseline?.documentHash ?? null
        },
        conflicts: [],
        conflictFields: [],
        markdownChanged: [],
        databaseChanged: [],
        modified: false,
        neverSynchronized: project.projectDocumentHash == null,
        conflict: false
      },
      lastSyncedAt: project.projectDocumentSyncedAt?.toISOString() ?? null,
      lastSyncedHash: project.projectDocumentHash,
      history
    };
  }

  const { project, changeSet, baseline } = built;
  const preview = toPreview(project, changeSet);
  return {
    ...preview,
    sync: {
      ...preview.sync,
      baseline: {
        available: baseline != null,
        capturedAt: baseline?.capturedAt ?? null,
        documentHash: baseline?.documentHash ?? null
      }
    },
    lastSyncedAt: project.projectDocumentSyncedAt?.toISOString() ?? null,
    lastSyncedHash: project.projectDocumentHash,
    history
  };
}

/**
 * The change-detection snapshot used by the card on page load: has the document
 * changed since it was last synchronized? Read-only.
 *
 * The Phase 6 fields are unchanged and still mean what they meant; the Phase 7
 * state and conflict names are added alongside so the card can show one badge
 * without asking for the full status.
 */
export async function projectDocumentSyncState(projectId: number): Promise<{
  projectId: number;
  documentHash: string | null;
  lastSyncedHash: string | null;
  lastSyncedAt: string | null;
  /** True when the file differs from the last synchronized version. */
  modified: boolean;
  /** True when this project has never been synchronized. */
  neverSynchronized: boolean;
  /** True when at least one field is in conflict. */
  conflict: boolean;
  /** Phase 7. */
  state: SyncState | 'unavailable';
  conflictFields: string[];
  baselineCapturedAt: string | null;
}> {
  const project = await loadSyncProject(projectId);
  const baseline = parseBaseline(project.projectDocumentBaseline);

  if (project.projectDocumentHash == null) {
    // Never synchronized: read the file only if it exists, purely to show a hash.
    let documentHash: string | null = null;
    try {
      documentHash = hashContent(await readDocumentContent(project));
    } catch {
      documentHash = null;
    }
    return {
      projectId,
      documentHash,
      lastSyncedHash: null,
      lastSyncedAt: null,
      modified: documentHash != null,
      neverSynchronized: true,
      conflict: false,
      state: baseline != null ? 'synchronized' : 'unavailable',
      conflictFields: [],
      baselineCapturedAt: baseline?.capturedAt ?? null
    };
  }

  let modified = false;
  let documentHash: string | null = null;
  let conflict = false;
  let state: SyncState | 'unavailable' = 'unavailable';
  let conflictFields: string[] = [];
  try {
    const content = await readDocumentContent(project);
    documentHash = hashContent(content);
    modified = documentHash !== project.projectDocumentHash;
    // The classified state, not just a byte comparison: with a baseline the engine
    // can say *which* fields moved and whether any of them are in conflict.
    const parsed = parseProjectDocument(content);
    const data = await loadProjectDocumentData(projectId);
    const changeSet = buildChangeSet(project, parsed, content, data, baseline);
    state = changeSet.syncState;
    conflictFields = conflictFieldNames(changeSet.conflicts);
    conflict = conflictFields.length > 0;
  } catch {
    // A missing/unreadable file is "not modified"; the preview will explain it.
    modified = false;
    documentHash = null;
  }

  return {
    projectId,
    documentHash,
    lastSyncedHash: project.projectDocumentHash,
    lastSyncedAt: project.projectDocumentSyncedAt?.toISOString() ?? null,
    modified,
    neverSynchronized: false,
    conflict,
    state,
    conflictFields,
    baselineCapturedAt: baseline?.capturedAt ?? null
  };
}
