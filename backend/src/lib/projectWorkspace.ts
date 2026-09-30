import fsp from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './errors.js';

/**
 * Phase 3: the link between a project record and a physical workspace folder.
 *
 * Three rules govern everything in this file.
 *
 * 1. A project name is user input and is NEVER allowed to decide where on disk
 *    anything goes. The only trusted base is the Projects Root from Phase 2.
 *    Every candidate path is built with `path.resolve` from that root and then
 *    checked for real containment, so `../../etc` and `D:\somewhere` cannot
 *    escape.
 *
 * 2. A folder is only ever removed if P-Hub created it during the current
 *    operation AND it is still empty. `rmdir` is used rather than `rm -r`, so a
 *    file appearing in the folder between creation and rollback is a hard
 *    failure rather than silent data loss.
 *
 * 3. A pre-existing directory is never modified, never claimed, and never
 *    deleted, no matter what happens afterwards.
 */

/** Windows device names that cannot be used as a folder name. */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

/** `< > : " / \ | ? *` plus the control characters Windows also forbids. */
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;

/** Longest folder name we will produce. Leaves room inside a 260 char budget. */
export const MAX_FOLDER_NAME = 100;

export class ProjectNameError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly possibleAction: string
  ) {
    super(message);
    this.name = 'ProjectNameError';
  }
}

export interface ResolvedWorkspace {
  /** The safe single path segment, e.g. `My Trading Bot - V2`. */
  folderName: string;
  /** Absolute path, guaranteed to be inside the Projects Root. */
  folderPath: string;
  /** True when `folderName` differs from the project name, so the UI can say so. */
  renamed: boolean;
}

/**
 * Turn a display name into one safe filesystem segment.
 *
 * The display name is never rewritten in the database: `name` stays exactly
 * what the user typed. Only the folder name is made filesystem-safe, and when
 * the two differ the caller is told so it can be shown in the UI rather than
 * silently surprising the user.
 *
 * The transformation is deliberately conservative and readable:
 *   - illegal characters and control characters become `-`
 *   - runs of separators collapse to a single `-`
 *   - leading/trailing dots, spaces and hyphens are trimmed
 *   - reserved Windows device names get a `-` suffix, not a random suffix
 *   - over-long names are truncated on a separator boundary where possible
 */
export function toSafeFolderName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new ProjectNameError(
      'The project name is empty, so no workspace folder could be created.',
      'PROJECT_NAME_EMPTY',
      'Enter a project name.'
    );
  }

  let safe = trimmed
    .replace(ILLEGAL, '-')
    .replace(/\s+/g, ' ')
    .trim();

  // Collapse separator runs that the replacement above may have lengthened.
  safe = safe.replace(/-{2,}/g, '-');

  // Windows strips trailing dots and spaces silently, so strip them ourselves
  // and refuse to emit a name that is nothing but dots.
  safe = safe.replace(/^[.\-\s]+/, '').replace(/[.\-\s]+$/, '');

  if (!safe) {
    throw new ProjectNameError(
      `"${trimmed}" contains no characters that can be used in a folder name.`,
      'PROJECT_NAME_UNUSABLE',
      'Use letters or numbers in the project name, for example "My Project".'
    );
  }

  if (safe.length > MAX_FOLDER_NAME) {
    const cut = safe.slice(0, MAX_FOLDER_NAME);
    // Prefer to end on a word boundary so the folder stays readable.
    const boundary = cut.lastIndexOf(' ');
    safe = (boundary > MAX_FOLDER_NAME * 0.6 ? cut.slice(0, boundary) : cut).replace(/[.\-\s]+$/, '');
  }

  // `nul`, `con.txt` and `Nul` are all reserved: Windows matches on the part
  // before the first dot, case-insensitively.
  const stem = safe.split('.')[0].toLowerCase();
  if (WINDOWS_RESERVED.has(stem)) {
    // The suffix has to go BEFORE the extension. Appending it to the end would
    // leave `NUL.txt-project`, whose stem before the first dot is still `nul`,
    // which Windows would still treat as a device rather than a folder.
    const dot = safe.indexOf('.');
    safe = dot === -1 ? `${safe}-project` : `${safe.slice(0, dot)}-project${safe.slice(dot)}`;
  }

  return safe;
}

/**
 * True when `target` is genuinely inside `root`.
 *
 * A string prefix check is not enough: `D:\ProjectsOther` starts with
 * `D:\Projects` but is a different folder. This compares resolved path segments
 * and, on Windows, folds case because `D:\projects` and `D:\Projects` are the
 * same directory.
 */
export function isInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const rootSegments = segmentsOf(resolvedRoot);
  const targetSegments = segmentsOf(resolvedTarget);

  if (targetSegments.length <= rootSegments.length) return false;

  return rootSegments.every((segment, i) => sameSegment(segment, targetSegments[i]));
}

function segmentsOf(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean);
}

function sameSegment(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Resolve a project name to a concrete workspace path inside the root.
 *
 * Throws rather than returning a partial result: there is no sensible fallback
 * folder, and inventing one (`NODIA2`) is exactly the silent behaviour this
 * phase forbids.
 */
export function resolveWorkspace(root: string, projectName: string): ResolvedWorkspace {
  const folderName = toSafeFolderName(projectName);
  const folderPath = path.resolve(root, folderName);

  if (!isInsideRoot(root, folderPath)) {
    // Unreachable via toSafeFolderName, which strips separators, but the check
    // is cheap and this is the boundary that must never be wrong.
    throw new ApiError(400, 'The project folder would fall outside the configured Projects Root.', {
      code: 'WORKSPACE_OUTSIDE_ROOT'
    }, {
      category: 'VALIDATION_FAILED',
      operation: 'create the project workspace',
      possibleAction: 'Choose a project name without path separators.'
    });
  }

  return { folderName, folderPath, renamed: folderName !== projectName.trim() };
}

export type CollisionKind = 'exists' | 'file' | 'symlink' | 'unreadable';

export interface Collision {
  kind: CollisionKind;
  path: string;
  message: string;
  possibleAction: string;
}

/**
 * Look at the target before touching it. Returns null when the path is free.
 *
 * This never creates, never writes and never modifies anything.
 */
export async function inspectTarget(target: string): Promise<Collision | null> {
  let stat: import('node:fs').Stats;
  try {
    stat = await fsp.lstat(target);
  } catch (err) {
    if (isMissing(err)) return null;
    return {
      kind: 'unreadable',
      path: target,
      message: 'Project Hub could not check whether that folder already exists.',
      possibleAction: 'Check the folder permissions on the Projects Root and try again.'
    };
  }

  if (stat.isSymbolicLink()) {
    return {
      kind: 'symlink',
      path: target,
      message: 'A link already exists at that path, so Project Hub will not use it.',
      possibleAction: 'Choose a different project name, or remove the link yourself.'
    };
  }
  if (stat.isDirectory()) {
    return {
      kind: 'exists',
      path: target,
      message: `A folder already exists at ${target}. Project Hub will not overwrite it or assume it belongs to a project.`,
      possibleAction: 'Choose a different project name, or rename that folder yourself first.'
    };
  }
  return {
    kind: 'file',
    path: target,
    message: `A file already exists at ${target}, so it cannot be used as a project folder.`,
    possibleAction: 'Choose a different project name.'
  };
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Create the workspace folder.
 *
 * `mkdir` without `recursive` is deliberate. The Projects Root is guaranteed to
 * exist by the caller, so a missing root means something is wrong and must
 * surface as an error rather than being silently created deep inside a path
 * that may not be what the user thinks.
 *
 * Returns whether this call is the one that created it, which is the flag the
 * rollback relies on. A folder that already existed is never returned as
 * created, and therefore can never be removed by rollback.
 */
export async function createWorkspaceFolder(folderPath: string): Promise<{ createdByUs: boolean }> {
  try {
    await fsp.mkdir(folderPath);
    return { createdByUs: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
      return { createdByUs: false };
    }
    const e = err as NodeJS.ErrnoException;
    throw new ApiError(500, `Project Hub could not create the project folder at ${folderPath}.`, {
      code: 'WORKSPACE_CREATE_FAILED',
      errno: e.code ?? null
    }, {
      category: 'FILESYSTEM_ERROR',
      operation: 'create the project workspace folder',
      possibleAction: 'Check that the Projects Root exists and is writable, then try again.'
    });
  }
}

/**
 * Remove a folder that this operation created and that is still empty.
 *
 * Uses `rmdir`, never a recursive delete. If anything at all is inside - a file
 * the user dropped in, a git repo someone initialised in the last second - the
 * removal fails and the partial state is reported. Losing a user's files to
 * clean up a failed database write is never the right trade.
 */
export async function removeEmptyCreatedFolder(folderPath: string): Promise<{ removed: boolean; reason: string | null }> {
  try {
    await fsp.rmdir(folderPath);
    return { removed: true, reason: null };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const reason =
      e.code === 'ENOTEMPTY'
        ? 'the folder is no longer empty'
        : e.code === 'ENOENT'
          ? 'the folder was already gone'
          : e.code ?? 'an unknown error';
    return { removed: false, reason };
  }
}

export function collisionError(collision: Collision): ApiError {
  return new ApiError(409, collision.message, {
    code: 'WORKSPACE_ALREADY_EXISTS',
    kind: collision.kind,
    path: collision.path
  }, {
    category: 'CONFLICT',
    operation: 'create the project workspace folder',
    possibleAction: collision.possibleAction
  });
}
