import fsp from 'node:fs/promises';
import { ApiError } from './errors.js';
import { parseProjectDocument } from './projectDocumentParser.js';
import {
  ChangeSet,
  SyncResult,
  SyncProjectRow,
  buildChangeSet,
  applyChangeSet,
  hashContent
} from './projectDocumentSync.js';
import { loadProjectDocumentData, renderProjectDocument, resolveProjectDocumentPath } from './projectDocument.js';
import { prisma } from './prisma.js';

/**
 * Phase 6, part three: the explicit, user-triggered synchronization flow.
 *
 *   read PROJECT.md -> parse -> build change set -> (preview stops here)
 *                                        -> (sync applies in one transaction)
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
 */

export interface PreviewResult {
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
}

/** The project fields the sync engine reads, plus the document metadata columns. */
async function loadSyncProject(projectId: number): Promise<SyncProjectRow & { folderPath: string | null }> {
  const row = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      folderPath: true,
      projectDocumentHash: true,
      projectDocumentStateHash: true,
      projectDocumentSyncedAt: true
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

/**
 * Read the project's PROJECT.md and build the change set.
 *
 * The path is resolved from the stored workspace, never from the request. Every
 * failure mode is a typed error the UI can explain.
 */
async function readAndBuild(projectId: number): Promise<{
  project: SyncProjectRow & { folderPath: string | null };
  content: string;
  changeSet: ChangeSet;
}> {
  const project = await loadSyncProject(projectId);

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

  let content: string;
  try {
    content = await fsp.readFile(resolved.path.documentPath, 'utf8');
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

  const parsed = parseProjectDocument(content);
  const data = await loadProjectDocumentData(projectId);
  const changeSet = buildChangeSet(project, parsed, content, data);
  return { project, content, changeSet };
}

function toPreview(project: SyncProjectRow, changeSet: ChangeSet): PreviewResult {
  return {
    projectId: project.id,
    projectName: project.name,
    relativePath: './PROJECT.md',
    documentVersion: changeSet.documentVersion,
    documentHash: changeSet.documentHash,
    unchanged: changeSet.unchanged,
    firstSynchronization: changeSet.firstSynchronization,
    conflict: changeSet.conflict,
    applicable: changeSet.errors.length === 0,
    projectChanges: changeSet.projectChanges,
    childChanges: changeSet.childChanges,
    unmatchedDatabaseRecords: changeSet.unmatchedDatabaseRecords,
    warnings: changeSet.warnings,
    errors: changeSet.errors,
    unsupportedSections: changeSet.unsupportedSections,
    preservedDetailSections: changeSet.preservedDetailSections
  };
}

/**
 * Build a preview. Performs no database write of any kind.
 */
export async function previewProjectDocumentSync(projectId: number): Promise<PreviewResult> {
  const { project, changeSet } = await readAndBuild(projectId);
  return toPreview(project, changeSet);
}

export interface SyncRunResult extends PreviewResult {
  applied: SyncResult | null;
  /** Why nothing was applied, when applicable. */
  skipped: 'unchanged' | 'not_applicable' | null;
}

/**
 * Apply the document to the database.
 *
 * Refuses to do anything when:
 *  - the change set has errors (wrong project, unknown version, duplicate keys);
 *  - the caller did not acknowledge a detected conflict;
 *  - the document is byte-identical to the last sync (nothing to do).
 *
 * In every one of those cases the database is left exactly as it was.
 */
export async function runProjectDocumentSync(
  projectId: number,
  options: { acknowledgeConflict?: boolean; actor?: string }
): Promise<SyncRunResult> {
  const { project, changeSet } = await readAndBuild(projectId);

  if (changeSet.errors.length > 0) {
    return { ...toPreview(project, changeSet), applied: null, skipped: 'not_applicable' };
  }

  if (changeSet.conflict && !options.acknowledgeConflict) {
    // Surface the conflict as an error so the caller cannot miss it, and change
    // nothing. The user must explicitly choose to proceed.
    const preview = toPreview(project, changeSet);
    return {
      ...preview,
      applicable: false,
      applied: null,
      skipped: 'not_applicable',
      errors: [
        ...preview.errors,
        {
          code: 'UNACKNOWLEDGED_CONFLICT',
          message:
            'The project record changed after this document was last synchronized. Preview the changes and synchronize again with the conflict acknowledged to apply them.'
        }
      ]
    };
  }

  if (changeSet.unchanged) {
    return { ...toPreview(project, changeSet), applied: null, skipped: 'unchanged' };
  }

  const applied = await applyChangeSet(projectId, changeSet, { actor: options.actor ?? 'user' });

  // After applying, the file is now the last-synced state. Return a fresh preview
  // so the UI shows the post-sync (unchanged) position.
  const after = await readAndBuild(projectId);
  return { ...toPreview(after.project, after.changeSet), applied, skipped: null };
}

/**
 * The change-detection snapshot used by the card on page load: has the document
 * changed since it was last synchronized? Read-only.
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
  /** True when the database moved after the last sync. */
  conflict: boolean;
}> {
  const project = await loadSyncProject(projectId);
  if (project.projectDocumentHash == null) {
    // Never synchronized: read the file only if it exists, purely to show a hash.
    let documentHash: string | null = null;
    try {
      const resolved = await resolveProjectDocumentPath({ folderPath: project.folderPath });
      if (resolved.available) {
        const content = await fsp.readFile(resolved.path.documentPath, 'utf8');
        documentHash = hashContent(content);
      }
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
      conflict: false
    };
  }

  let modified = false;
  let conflict = false;
  try {
    const resolved = await resolveProjectDocumentPath({ folderPath: project.folderPath });
    if (resolved.available) {
      const content = await fsp.readFile(resolved.path.documentPath, 'utf8');
      modified = hashContent(content) !== project.projectDocumentHash;
    }
    // Conflict: has the database moved since the last sync?
    const data = await loadProjectDocumentData(projectId);
    const currentState = hashContent(renderProjectDocument(data));
    conflict = project.projectDocumentStateHash != null && project.projectDocumentStateHash !== currentState;
  } catch {
    // A missing/unreadable file is "not modified"; the preview will explain it.
    modified = false;
  }

  return {
    projectId,
    documentHash: null,
    lastSyncedHash: project.projectDocumentHash,
    lastSyncedAt: project.projectDocumentSyncedAt?.toISOString() ?? null,
    modified,
    neverSynchronized: false,
    conflict
  };
}
