import fsp from 'node:fs/promises';
import path from 'node:path';
import { prisma } from './prisma.js';
import { ApiError } from './errors.js';
import { logActivity } from './activity.js';
import { readProjectsRootSetting } from './settings.js';
import { probeProjectsRoot } from './paths.js';
import { isInsideRoot } from './projectWorkspace.js';
import { STAGES } from '../resources.js';

/**
 * Phase 5: STATUS.md, the project's lifecycle/control file.
 *
 * This is a different document from PROJECT.md (Phase 4):
 *
 *   PROJECT.md  describes the project
 *   STATUS.md   declares the project's lifecycle state
 *
 * The single rule this module exists to enforce is the same shape as Phase 4's,
 * with the roles of the two sides made explicit:
 *
 *   DATABASE -> STATUS.md        supported here
 *   STATUS.md -> DATABASE        read and reported, never applied
 *
 * Three consequences are load-bearing, and every function below is written to
 * keep them true:
 *
 * 1. **A folder is not activity.** Nothing here inspects source files, package
 *    manifests, git history or modification times to decide a status. A project
 *    whose folder exists, whose PROJECT.md exists and which contains a
 *    `package.json` is still whatever its database says it is. Evidence-based
 *    inference is a later lifecycle engine's job, and until it exists this file
 *    must never guess.
 *
 * 2. **The database is the authority.** `projects.stage` is persisted truth;
 *    STATUS.md is the explicit control representation of it. A manual edit to
 *    STATUS.md is reported as a disagreement and is *never* written back.
 *
 * 3. **The status vocabulary is not redefined here.** `STAGES` from
 *    `src/resources.ts` is the existing list that mirrors the Prisma
 *    `LifecycleStage` enum, and it is the only list this module accepts,
 *    validates or offers. A second status system is the specific failure this
 *    phase must not introduce.
 *
 * No migration was added. STATUS.md is derived from `projects.folderPath`,
 * which already exists (Phase 3), so there was no column to create and nothing
 * in the database to rewrite.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The existing status list. Re-exported so routes and tests need one import. */
export const LIFECYCLE_STAGES = STAGES;

/** The status every new project starts in. See `projectCreation` / the route. */
export const INITIAL_PROJECT_STATUS = 'IDEA' as const;

type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

/** One filename, constant, never derived from user input. */
export const STATUS_DOCUMENT_FILENAME = 'STATUS.md';

/** Bumped only when the document's own structure changes. Never a timestamp. */
export const STATUS_DOCUMENT_VERSION = 1;

/**
 * STATUS.md is a control file, not a document to read at length. The limit is
 * far below PROJECT.md's because a legitimate status file is a few hundred
 * bytes; anything larger is not something this parser should be chewing on.
 */
export const STATUS_DOCUMENT_MAX_BYTES = 256 * 1024;

/** True when `value` is one of the real database status values. */
export function isLifecycleStage(value: unknown): value is LifecycleStage {
  return typeof value === 'string' && (LIFECYCLE_STAGES as readonly string[]).includes(value);
}

/**
 * Normalise user/document input to a canonical status token, or return null.
 *
 * The rules are fixed and total, so the same input always produces the same
 * output: trim, collapse every run of whitespace to a single underscore,
 * upper-case. Nothing else is substituted, nothing is guessed and no fuzzy
 * matching happens - `FLYING` is simply not a status.
 */
export function normalizeStatusToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const token = value.trim().replace(/\s+/g, '_').toUpperCase();
  return token ? token : null;
}

/** Normalise and validate in one step. */
export function parseLifecycleStage(value: unknown): LifecycleStage | null {
  const token = normalizeStatusToken(value);
  return token && isLifecycleStage(token) ? (token as LifecycleStage) : null;
}

/**
 * The one human sentence per status, used as the description in STATUS.md.
 *
 * Kept as a closed map over the real enum rather than prose assembled from the
 * status name, so the document is deterministic and a new enum value cannot be
 * rendered with an empty description.
 */
const STAGE_DESCRIPTIONS: Record<LifecycleStage, string> = {
  IDEA: 'The project has been captured as an idea. No implementation has been decided or started.',
  RESEARCH: 'The project is being investigated. Questions are open and evidence is being gathered before implementation.',
  PLANNING: 'Scope and approach are being decided. Implementation has not started.',
  ARCHITECTURE: 'The system design is being decided. Implementation has not started.',
  BUILDING: 'Implementation is in progress.',
  TESTING: 'The implementation is being verified before release.',
  DEPLOYMENT: 'A release is being deployed to an environment.',
  PRODUCTION: 'The project is running in production.',
  MAINTENANCE: 'The project is released and is being kept running and improved.',
  PAUSED: 'Work is intentionally on hold. Nothing is being changed right now.',
  COMPLETED: 'The project is finished. No further work is planned.',
  ARCHIVED: 'The project is kept for reference and is no longer active.',
  ABANDONED: 'The project was stopped and will not be continued.'
};

export function describeStage(stage: string): string {
  return isLifecycleStage(stage)
    ? STAGE_DESCRIPTIONS[stage]
    : 'This status is not one Project Hub recognises.';
}

/** A YAML double-quoted scalar: a project name may contain quotes or colons. */
function yamlScalar(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()}"`;
}

// ---------------------------------------------------------------------------
// Generation (section 13)
// ---------------------------------------------------------------------------

/**
 * The only STATUS.md renderer in the codebase.
 *
 * Pure: same input, same bytes. No clock, no randomness, no filesystem, no
 * database. It is used by project creation, by a status change, and by an
 * explicit regeneration, so those three paths cannot drift apart.
 *
 * The machine-readable part of the document is exactly one line:
 *
 *   **Status:** IDEA
 *
 * `**Status:**` is also the front matter key `p-hub-status`, and the parser
 * below accepts both plus the plain `Status:` form, so a hand-written document
 * is still readable. Prose elsewhere in the file is never consulted.
 */
export function renderStatusDocument(input: { projectId: number; projectName: string; stage: string }): string {
  const stage = parseLifecycleStage(input.stage);
  if (!stage) {
    // The generator refuses to emit a document that would need guessing later.
    throw invalidStatusError(input.stage, 'write STATUS.md');
  }
  const name = (input.projectName ?? '').replace(/\s+/g, ' ').trim() || 'Untitled project';

  const blocks: string[] = [
    [
      '---',
      `p-hub-document: ${yamlScalar(STATUS_DOCUMENT_FILENAME)}`,
      `p-hub-document-version: ${STATUS_DOCUMENT_VERSION}`,
      `p-hub-project-id: ${input.projectId}`,
      `p-hub-project-name: ${yamlScalar(name)}`,
      `p-hub-status: ${stage}`,
      'p-hub-authority: "database"',
      'p-hub-direction: "database-to-document"',
      '---'
    ].join('\n'),
    '# Project Status',
    `**Status:** ${stage}`,
    [
      '## Status Description',
      '',
      describeStage(stage)
    ].join('\n'),
    [
      '## Status Rules',
      '',
      'This status is declared in Project Hub and written here from the project record.',
      '',
      'Creating this project folder, writing PROJECT.md or STATUS.md, adding source',
      'files, or having a Git repository, an editor or a package manifest in this',
      'folder do **not** change it. The status changes only when you change it.',
      '',
      'Project Hub writes this file when you change the status here. If you edit the',
      'line above by hand, Project Hub reports the disagreement but does **not**',
      'change the project record.'
    ].join('\n'),
    [
      '## Last Controlled By',
      '',
      'Project Hub'
    ].join('\n'),
    [
      '## Valid Statuses',
      '',
      LIFECYCLE_STAGES.map(s => `- \`${s}\` — ${describeStage(s)}`).join('\n')
    ].join('\n')
  ];

  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** Preview the document for a project without touching disk. Used by tests. */
export async function previewStatusDocument(projectId: number): Promise<string> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, stage: true }
  });
  if (!project) {
    throw new ApiError(404, 'Project not found.', undefined, {
      category: 'NOT_FOUND',
      operation: 'preview STATUS.md',
      possibleAction: 'Open an existing project.'
    });
  }
  return renderStatusDocument({ projectId: project.id, projectName: project.name, stage: project.stage });
}

// ---------------------------------------------------------------------------
// Parsing (section 12)
// ---------------------------------------------------------------------------

export interface ParsedStatusDocument {
  /** True when a recognisable status line was found at all. */
  hasStatusLine: boolean;
  /** The value exactly as written, before normalisation. null when absent. */
  rawStatus: string | null;
  /** The normalised token. null when absent or not a real status. */
  status: LifecycleStage | null;
  /** True when a status line exists and its value is in the real enum. */
  isValidStatus: boolean;
  /** Present only when front matter declared one and it parsed as an integer. */
  projectId: number | null;
  documentVersion: number | null;
  projectName: string | null;
}

const STATUS_LINE_PATTERNS = [
  /^\*\*Status:\*\*\s*(.+?)\s*$/i,
  /^Status:\s*(.+?)\s*$/,
  /^-\s*\*\*Status:\*\*\s*(.+?)\s*$/i,
  /^\*\*Status\*\*:\s*(.+?)\s*$/i
];

const FRONT_MATTER_KEY = /^([A-Za-z0-9-]+):\s*(.*)$/;

/** Unwrap one YAML double-quoted scalar; anything else is returned as-is. */
function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return v;
}

/**
 * Read a status out of a STATUS.md.
 *
 * Deterministic by construction: the first line matching any of four status
 * shapes wins, and nothing else in the file is interpreted. Prose can therefore
 * never change the answer, and a document with two status lines resolves to the
 * first one instead of depending on ordering subtleties.
 *
 * This function never writes anything and never contacts the database. It is
 * used for reporting only.
 */
export function parseStatusDocument(content: string): ParsedStatusDocument {
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  let projectId: number | null = null;
  let documentVersion: number | null = null;
  let projectName: string | null = null;

  // Front matter is optional: a hand-written file with only `Status: X` is valid.
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '---') break;
      const m = FRONT_MATTER_KEY.exec(line);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = unquote(m[2]);
      if (key === 'p-hub-project-id' && /^-?\d+$/.test(value)) projectId = Number(value);
      else if (key === 'p-hub-document-version' && /^\d+$/.test(value)) documentVersion = Number(value);
      else if (key === 'p-hub-project-name') projectName = value;
    }
  }

  let rawStatus: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    // Headings and fenced code are skipped so an example inside the document
    // cannot be mistaken for the declaration.
    if (trimmed.startsWith('#') || trimmed.startsWith('```') || trimmed.startsWith('~~~')) continue;
    for (const pattern of STATUS_LINE_PATTERNS) {
      const m = pattern.exec(trimmed);
      if (m) {
        rawStatus = m[1];
        break;
      }
    }
    if (rawStatus !== null) break;
  }

  if (rawStatus === null) {
    return { hasStatusLine: false, rawStatus: null, status: null, isValidStatus: false, projectId, documentVersion, projectName };
  }

  const status = parseLifecycleStage(rawStatus);
  return {
    hasStatusLine: true,
    rawStatus,
    status,
    isValidStatus: status !== null,
    projectId,
    documentVersion,
    projectName
  };
}

function invalidStatusError(received: unknown, operation: string): ApiError {
  const receivedToken = normalizeStatusToken(received);
  return new ApiError(
    400,
    `Invalid project status: ${receivedToken ?? JSON.stringify(received) ?? 'null'}`,
    {
      code: 'INVALID_PROJECT_STATUS',
      received: receivedToken ?? received,
      validStatuses: [...LIFECYCLE_STAGES]
    },
    {
      category: 'VALIDATION_FAILED',
      operation,
      possibleAction: `Use one of: ${LIFECYCLE_STAGES.join(', ')}.`
    }
  );
}

// ---------------------------------------------------------------------------
// Path resolution (sections 2 and 18)
// ---------------------------------------------------------------------------

export type StatusUnavailableReason =
  | 'PROJECTS_ROOT_NOT_CONFIGURED'
  | 'PROJECT_WORKSPACE_MISSING'
  | 'PROJECT_WORKSPACE_UNSAFE'
  | 'PROJECT_WORKSPACE_NOT_ON_DISK'
  | 'PROJECT_WORKSPACE_IS_A_LINK';

export interface ResolvedStatusDocumentPath {
  root: string;
  folderPath: string;
  documentPath: string;
  relativePath: string;
}

export type StatusPathResult =
  | { available: true; path: ResolvedStatusDocumentPath }
  | { available: false; reason: StatusUnavailableReason; message: string; possibleAction: string };

/**
 * Work out where this project's STATUS.md must be, from the database alone.
 *
 * Deliberately a separate function from PROJECT.md's resolver rather than a
 * shared helper with a filename argument: the filename is not a parameter, so
 * no caller can ever ask for another project's document or another file.
 *
 * Provenance is the whole point of this function: project id -> database row
 * -> stored `folderPath` -> containment inside the configured Projects Root.
 * No filesystem path is ever accepted from the client.
 */
export async function resolveStatusDocumentPath(project: {
  folderPath: string | null;
}): Promise<StatusPathResult> {
  const stored = await readProjectsRootSetting();
  if (!stored) {
    return {
      available: false,
      reason: 'PROJECTS_ROOT_NOT_CONFIGURED',
      message: 'No Projects Root is configured, so STATUS.md has nowhere to live.',
      possibleAction: 'Open Settings and set a Projects Root, then try again.'
    };
  }
  if (!project.folderPath) {
    return {
      available: false,
      reason: 'PROJECT_WORKSPACE_MISSING',
      message: 'This project has no workspace folder, so it cannot have a STATUS.md.',
      possibleAction:
        'Only projects created with a workspace folder have one. STATUS.md is never written into the application directory, a temporary folder or another project.'
    };
  }

  const root = path.resolve(stored.value);
  const folderPath = path.resolve(project.folderPath);
  const documentPath = path.resolve(folderPath, STATUS_DOCUMENT_FILENAME);

  const insideRoot = isInsideRoot(root, folderPath) && isInsideRoot(root, documentPath);
  const parentIsTheFolder = path.dirname(documentPath) === folderPath;

  if (!insideRoot || !parentIsTheFolder) {
    return {
      available: false,
      reason: 'PROJECT_WORKSPACE_UNSAFE',
      message:
        'The stored workspace path for this project does not resolve to a folder inside the configured Projects Root.',
      possibleAction:
        'Project Hub will not read or write outside the Projects Root. Check the Projects Root in Settings, or recreate the project so its workspace is recorded correctly.'
    };
  }

  return {
    available: true,
    path: { root, folderPath, documentPath, relativePath: `./${STATUS_DOCUMENT_FILENAME}` }
  };
}

/** The same check, as an error. Used by every endpoint that acts. */
async function requireStatusDocumentPath(project: {
  folderPath: string | null;
}): Promise<ResolvedStatusDocumentPath> {
  const resolved = await resolveStatusDocumentPath(project);
  if (resolved.available) return resolved.path;
  throw new ApiError(
    409,
    resolved.message,
    { code: resolved.reason, relativePath: `./${STATUS_DOCUMENT_FILENAME}` },
    {
      category: 'VALIDATION_FAILED',
      operation: 'resolve the STATUS.md path for this project',
      possibleAction: resolved.possibleAction
    }
  );
}

/**
 * The workspace check the *readers* also need.
 *
 * `resolveStatusDocumentPath` proves containment textually: the stored
 * `folderPath` starts with the Projects Root. That is enough to decide where to
 * write, but not enough to decide where to read. If a real folder is later
 * replaced by a directory symlink or a Windows junction pointing somewhere else,
 * the stored path still "looks" contained while `readFile` on
 * `<folderPath>/STATUS.md` would happily follow the link and return a file from
 * outside the root.
 *
 * So every read goes through the same directory probe the writer uses. A linked
 * or missing workspace is reported, never followed.
 */
async function probeStatusWorkspace(
  folderPath: string
): Promise<{ usable: true } | { usable: false; reason: StatusUnavailableReason; message: string; possibleAction: string }> {
  const probe = await probeProjectsRoot(folderPath, { testWrite: false });
  // Checked before the directory test: a link reports itself as "not a
  // directory", and "it is a link" is the more useful thing to say.
  if (probe.isSymbolicLink) {
    return {
      usable: false,
      reason: 'PROJECT_WORKSPACE_IS_A_LINK',
      message: `The workspace folder for this project is a link, so Project Hub will not read ${STATUS_DOCUMENT_FILENAME} through it.`,
      possibleAction:
        'Replace the link with a real folder inside the Projects Root, or recreate the project so its workspace is recorded correctly.'
    };
  }
  if (!probe.exists || !probe.isDirectory) {
    return {
      usable: false,
      reason: 'PROJECT_WORKSPACE_NOT_ON_DISK',
      message: `The workspace folder for this project is not on disk (${folderPath}), so ${STATUS_DOCUMENT_FILENAME} cannot be read.`,
      possibleAction:
        'Recreate the folder at that exact path, or generate the document again. Nothing in the project record was lost.'
    };
  }
  return { usable: true };
}

// ---------------------------------------------------------------------------
// Document status / read / write
// ---------------------------------------------------------------------------

export interface StatusDocumentStatus {
  projectId: number;
  projectName: string;
  /** The status Project Hub holds. Never null: the column is NOT NULL. */
  databaseStatus: LifecycleStage;
  available: boolean;
  reason?: StatusUnavailableReason;
  message?: string;
  possibleAction?: string;
  /** Always relative. The client never supplies, and never needs, a full path. */
  relativePath: string;
  documentPath?: string;
  exists: boolean | null;
  isDirectory: boolean;
  sizeBytes: number | null;
  modifiedAt: string | null;
  workspaceExists: boolean | null;
  workspaceIsSymbolicLink: boolean;
  documentVersion: number;
  /** The status parsed from the file, or null when absent/invalid. */
  documentStatus: LifecycleStage | null;
  direction: 'DATABASE_TO_DOCUMENT';
  /** Always false in Phase 5. Edits to the file are never applied to the record. */
  documentToDatabaseSync: false;
}

export async function statusDocumentStatus(project: {
  id: number;
  name: string;
  stage: string;
  folderPath: string | null;
}): Promise<StatusDocumentStatus> {
  const stage = parseLifecycleStage(project.stage) ?? INITIAL_PROJECT_STATUS;
  const base = {
    projectId: project.id,
    projectName: project.name,
    databaseStatus: stage,
    relativePath: `./${STATUS_DOCUMENT_FILENAME}`,
    isDirectory: false,
    sizeBytes: null,
    modifiedAt: null,
    workspaceExists: null,
    workspaceIsSymbolicLink: false,
    documentStatus: null,
    documentVersion: STATUS_DOCUMENT_VERSION,
    direction: 'DATABASE_TO_DOCUMENT' as const,
    documentToDatabaseSync: false as const
  };

  const resolved = await resolveStatusDocumentPath(project);
  if (!resolved.available) {
    return {
      ...base,
      available: false,
      reason: resolved.reason,
      message: resolved.message,
      possibleAction: resolved.possibleAction,
      exists: null
    };
  }

  const probe = await probeProjectsRoot(resolved.path.folderPath, { testWrite: false });
  // This function reads the document to report its declared status, so it needs
  // the same on-disk guard as the reader rather than only reporting the link.
  const workspace = await probeStatusWorkspace(resolved.path.folderPath);
  if (!workspace.usable) {
    return {
      ...base,
      available: false,
      reason: workspace.reason,
      message: workspace.message,
      possibleAction: workspace.possibleAction,
      exists: null
    };
  }
  let exists: boolean | null = null;
  let sizeBytes: number | null = null;
  let modifiedAt: string | null = null;
  let isDirectory = false;
  let documentStatus: LifecycleStage | null = null;

  try {
    const stat = await fsp.lstat(resolved.path.documentPath);
    exists = true;
    isDirectory = stat.isDirectory();
    if (!isDirectory && !stat.isSymbolicLink()) {
      sizeBytes = stat.size;
      modifiedAt = stat.mtime.toISOString();
      if (stat.size <= STATUS_DOCUMENT_MAX_BYTES) {
        documentStatus = (await readAndParse(resolved.path.documentPath)).status;
      }
    }
  } catch (err) {
    // ENOENT simply means there is no document, which is a normal answer. Any
    // other error is reported as "could not determine", never as "missing".
    exists = (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? false : null;
  }

  return {
    ...base,
    available: true,
    documentPath: resolved.path.documentPath,
    exists,
    isDirectory,
    sizeBytes,
    modifiedAt,
    workspaceExists: probe.exists && probe.isDirectory,
    workspaceIsSymbolicLink: probe.isSymbolicLink,
    documentStatus
  };
}

export interface WriteStatusDocumentResult {
  status: StatusDocumentStatus;
  replaced: boolean;
  bytes: number;
}

/**
 * Write STATUS.md for a project.
 *
 * `overwrite: false` is **Initialize**: the exclusive `wx` flag makes the write
 * itself fail if the file appeared in the meantime, so the check and the write
 * cannot disagree, and an existing file is never silently replaced.
 *
 * `overwrite: true` is **Regenerate**: it replaces exactly this one file and
 * touches nothing else in the folder - not PROJECT.md, not source, not config.
 */
export async function writeStatusDocument(
  project: { id: number; name: string; stage: string; folderPath: string | null },
  options: { overwrite: boolean }
): Promise<WriteStatusDocumentResult> {
  const resolved = await requireStatusDocumentPath(project);

  const probe = await probeProjectsRoot(resolved.folderPath, { testWrite: false });
  if (probe.isSymbolicLink) {
    // Writing through a link would place the file at the link's target, which is
    // the exact escape the Projects Root boundary exists to prevent. Checked
    // before the directory check because a link reports itself as "not a
    // directory", and "it is a link" is the more useful thing to say.
    throw new ApiError(
      409,
      'The workspace folder for this project is a link, so Project Hub will not write through it.',
      { code: 'PROJECT_WORKSPACE_IS_A_LINK', folderPath: resolved.folderPath },
      {
        category: 'VALIDATION_FAILED',
        operation: 'write STATUS.md',
        possibleAction: 'Replace the link with a real folder, or point the project at a different workspace in a later phase.'
      }
    );
  }
  if (!probe.exists || !probe.isDirectory) {
    throw new ApiError(
      409,
      `The workspace folder for this project is not on disk (${resolved.folderPath}).`,
      { code: 'PROJECT_WORKSPACE_NOT_ON_DISK', folderPath: resolved.folderPath },
      {
        category: 'VALIDATION_FAILED',
        operation: 'write STATUS.md',
        possibleAction:
          'Recreate the folder at that exact path, or create a new project. Nothing in the project record was lost.'
      }
    );
  }

  let exists = false;
  let isDirectory = false;
  let isLink = false;
  try {
    const stat = await fsp.lstat(resolved.documentPath);
    exists = true;
    isDirectory = stat.isDirectory();
    isLink = stat.isSymbolicLink();
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }

  if (isLink) {
    throw new ApiError(
      409,
      `A link already exists where ${STATUS_DOCUMENT_FILENAME} should be, so Project Hub will not write through it.`,
      { code: 'STATUS_DOCUMENT_IS_A_LINK', documentPath: resolved.documentPath },
      {
        category: 'CONFLICT',
        operation: 'write STATUS.md',
        possibleAction: 'Remove the link yourself, or choose a different project name and create it again.'
      }
    );
  }
  if (isDirectory) {
    throw new ApiError(
      409,
      `A folder exists where ${STATUS_DOCUMENT_FILENAME} should be.`,
      { code: 'STATUS_DOCUMENT_IS_A_DIRECTORY', documentPath: resolved.documentPath },
      {
        category: 'CONFLICT',
        operation: 'write STATUS.md',
        possibleAction: 'Remove or rename that folder yourself, then try again.'
      }
    );
  }
  if (exists && !options.overwrite) {
    throw new ApiError(
      409,
      `${STATUS_DOCUMENT_FILENAME} already exists for this project.`,
      { code: 'STATUS_DOCUMENT_EXISTS', documentPath: resolved.documentPath },
      {
        category: 'CONFLICT',
        operation: 'write STATUS.md',
        possibleAction: `Use "Regenerate ${STATUS_DOCUMENT_FILENAME}" if you want to replace it with the current database status. Regenerating discards any manual edit to the file.`
      }
    );
  }

  const markdown = renderStatusDocument({
    projectId: project.id,
    projectName: project.name,
    stage: project.stage
  });
  const bytes = Buffer.byteLength(markdown, 'utf8');
  if (bytes > STATUS_DOCUMENT_MAX_BYTES) {
    throw new ApiError(
      422,
      `${STATUS_DOCUMENT_FILENAME} would be ${bytes} bytes, over the ${STATUS_DOCUMENT_MAX_BYTES} byte limit, so it was not written.`,
      { code: 'STATUS_DOCUMENT_TOO_LARGE', bytes, limit: STATUS_DOCUMENT_MAX_BYTES },
      {
        category: 'VALIDATION_FAILED',
        operation: 'write STATUS.md',
        possibleAction: 'Shorten the project name and try again.'
      }
    );
  }

  try {
    await fsp.writeFile(resolved.documentPath, markdown, {
      encoding: 'utf8',
      flag: options.overwrite ? 'w' : 'wx'
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EEXIST' && !options.overwrite) {
      throw new ApiError(
        409,
        `${STATUS_DOCUMENT_FILENAME} already exists for this project.`,
        { code: 'STATUS_DOCUMENT_EXISTS', documentPath: resolved.documentPath },
        {
          category: 'CONFLICT',
          operation: 'write STATUS.md',
          possibleAction: `Use "Regenerate ${STATUS_DOCUMENT_FILENAME}" to replace it with the current database status.`
        }
      );
    }
    throw new ApiError(
      500,
      `Project Hub could not write ${STATUS_DOCUMENT_FILENAME} (${e.code ?? 'unknown error'}).`,
      { code: 'STATUS_DOCUMENT_WRITE_FAILED', documentPath: resolved.documentPath, errno: e.code ?? null },
      {
        category: 'FILESYSTEM_ERROR',
        operation: 'write STATUS.md',
        possibleAction: `Check that the workspace folder is writable, then try again. Nothing else in the folder was changed.`
      }
    );
  }

  return {
    status: await statusDocumentStatus(project),
    replaced: exists,
    bytes
  };
}

async function readAndParse(documentPath: string): Promise<ParsedStatusDocument> {
  return parseStatusDocument(await fsp.readFile(documentPath, 'utf8'));
}

export interface ReadStatusDocumentResult {
  projectId: number;
  projectName: string;
  databaseStatus: LifecycleStage;
  relativePath: string;
  documentPath: string;
  content: string;
  parsed: ParsedStatusDocument;
  sizeBytes: number;
  modifiedAt: string | null;
  documentVersion: number;
  direction: 'DATABASE_TO_DOCUMENT';
  documentToDatabaseSync: false;
}

/**
 * Read and validate STATUS.md.
 *
 * Checks, in order: the project exists (the route did it), the workspace
 * resolves inside the Projects Root, the path is a real file and not a
 * directory or a link, the size is within the limit, and the parsed status is
 * in the real enum.
 *
 * An invalid status is reported, never repaired and never applied to the
 * database. This function writes nothing at all.
 */
export async function readStatusDocument(project: {
  id: number;
  name: string;
  stage: string;
  folderPath: string | null;
}): Promise<ReadStatusDocumentResult> {
  const resolved = await requireStatusDocumentPath(project);

  // Containment was proved textually above; prove it on disk before reading, so
  // a workspace replaced by a link cannot pull a file in from outside the root.
  const workspace = await probeStatusWorkspace(resolved.folderPath);
  if (!workspace.usable) {
    throw new ApiError(
      409,
      workspace.message,
      { code: workspace.reason, folderPath: resolved.folderPath, relativePath: resolved.relativePath },
      {
        category: 'VALIDATION_FAILED',
        operation: `read ${STATUS_DOCUMENT_FILENAME}`,
        possibleAction: workspace.possibleAction
      }
    );
  }

  let stat: import('node:fs').Stats;
  try {
    stat = await fsp.lstat(resolved.documentPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new ApiError(
        404,
        `This project does not have a ${STATUS_DOCUMENT_FILENAME} yet.`,
        { code: 'STATUS_DOCUMENT_MISSING', relativePath: resolved.relativePath },
        {
          category: 'NOT_FOUND',
          operation: 'read STATUS.md',
          possibleAction: `Use "Initialize ${STATUS_DOCUMENT_FILENAME}" to create it from the current database status (${project.stage}). The project status does not change.`
        }
      );
    }
    throw new ApiError(
      500,
      `Project Hub could not read ${STATUS_DOCUMENT_FILENAME} (${(err as NodeJS.ErrnoException)?.code ?? 'unknown error'}).`,
      { code: 'STATUS_DOCUMENT_READ_FAILED', documentPath: resolved.documentPath },
      {
        category: 'FILESYSTEM_ERROR',
        operation: 'read STATUS.md',
        possibleAction: 'Check that the workspace folder still exists and is readable.'
      }
    );
  }

  if (stat.isDirectory()) {
    throw new ApiError(
      409,
      `A folder exists where ${STATUS_DOCUMENT_FILENAME} should be, so there is no document to show.`,
      { code: 'STATUS_DOCUMENT_IS_A_DIRECTORY', documentPath: resolved.documentPath },
      {
        category: 'CONFLICT',
        operation: 'read STATUS.md',
        possibleAction: 'Remove or rename that folder yourself, then try again.'
      }
    );
  }
  if (stat.isSymbolicLink()) {
    throw new ApiError(
      409,
      `${STATUS_DOCUMENT_FILENAME} for this project is a link, so Project Hub will not read through it.`,
      { code: 'STATUS_DOCUMENT_IS_A_LINK', documentPath: resolved.documentPath },
      {
        category: 'CONFLICT',
        operation: 'read STATUS.md',
        possibleAction: 'Remove the link yourself, then try again.'
      }
    );
  }
  if (stat.size > STATUS_DOCUMENT_MAX_BYTES) {
    throw new ApiError(
      422,
      `${STATUS_DOCUMENT_FILENAME} is ${stat.size} bytes, over the ${STATUS_DOCUMENT_MAX_BYTES} byte limit, so it was not opened.`,
      { code: 'STATUS_DOCUMENT_TOO_LARGE', sizeBytes: stat.size, limit: STATUS_DOCUMENT_MAX_BYTES },
      {
        category: 'VALIDATION_FAILED',
        operation: 'read STATUS.md',
        possibleAction: 'Open the file in your editor instead. Project Hub will not load a document this large.'
      }
    );
  }

  let content: string;
  try {
    content = await fsp.readFile(resolved.documentPath, 'utf8');
  } catch (err) {
    throw new ApiError(
      500,
      `Project Hub could not read ${STATUS_DOCUMENT_FILENAME} (${(err as NodeJS.ErrnoException)?.code ?? 'unknown error'}).`,
      { code: 'STATUS_DOCUMENT_READ_FAILED', documentPath: resolved.documentPath },
      {
        category: 'FILESYSTEM_ERROR',
        operation: 'read STATUS.md',
        possibleAction: 'Check the permissions on the workspace folder.'
      }
    );
  }

  const parsed = parseStatusDocument(content);

  // A status line that is not a real enum value is a validation failure, and it
  // is reported rather than corrected: the file is not replaced and the project
  // record is not touched.
  if (parsed.hasStatusLine && !parsed.isValidStatus) {
    throw new ApiError(
      422,
      `Invalid project status: ${parsed.rawStatus}`,
      {
        code: 'STATUS_DOCUMENT_INVALID_STATUS',
        received: parsed.rawStatus,
        validStatuses: [...LIFECYCLE_STAGES]
      },
      {
        category: 'VALIDATION_FAILED',
        operation: 'validate the status declared in STATUS.md',
        possibleAction: `Correct the status in the file to one of: ${LIFECYCLE_STAGES.join(', ')}. Project Hub has not changed the project record, which is still ${project.stage}.`
      }
    );
  }

  return {
    projectId: project.id,
    projectName: project.name,
    databaseStatus: parseLifecycleStage(project.stage) ?? INITIAL_PROJECT_STATUS,
    relativePath: resolved.relativePath,
    documentPath: resolved.documentPath,
    content,
    parsed,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    documentVersion: STATUS_DOCUMENT_VERSION,
    direction: 'DATABASE_TO_DOCUMENT',
    documentToDatabaseSync: false
  };
}

// ---------------------------------------------------------------------------
// Consistency (section 25)
// ---------------------------------------------------------------------------

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
  /** What the database holds. Authoritative. */
  databaseStatus: LifecycleStage;
  /** What the document declares, or null when it declares nothing valid. */
  documentStatus: LifecycleStage | null;
  /** True only for SYNCHRONIZED. Null when it cannot be determined. */
  isConsistent: boolean | null;
  state: StatusConsistencyState;
  relativePath: string;
  documentPath?: string;
  documentExists: boolean | null;
  documentModifiedAt: string | null;
  /** The exact text found, so an invalid value can be shown to the user. */
  rawDocumentStatus: string | null;
  /** Present when the document declares a status that is not in the enum. */
  invalidDocumentStatus?: string | null;
  /** Present when the front matter names a different project. */
  documentProjectId?: number | null;
  /** Present when STATE is UNAVAILABLE. */
  reason?: StatusUnavailableReason;
  message?: string;
  possibleAction?: string;
  /** The one authoritative list of statuses, so a client never invents one. */
  validStatuses: LifecycleStage[];
  /** Phase 5 never resolves a mismatch and never applies the document. */
  autoResolved: false;
  documentToDatabaseSync: false;
}

/**
 * Compare the database status with the status declared in STATUS.md.
 *
 * Read-only and non-destructive by construction: it cannot change either side.
 * All five cases in the spec are reported explicitly -
 *
 *   A  equal                     -> SYNCHRONIZED
 *   B  different                 -> STATUS_MISMATCH
 *   C  no file                   -> DOCUMENT_MISSING
 *   D  unparseable status        -> DOCUMENT_INVALID
 *   E  unreadable                -> DOCUMENT_UNREADABLE
 *
 * plus UNAVAILABLE when there is no Projects Root, no workspace, or a workspace
 * that no longer resolves inside the root.
 */
export async function statusConsistency(project: {
  id: number;
  name: string;
  stage: string;
  folderPath: string | null;
}): Promise<StatusConsistency> {
  const databaseStatus = parseLifecycleStage(project.stage) ?? INITIAL_PROJECT_STATUS;
  const base = {
    projectId: project.id,
    projectName: project.name,
    databaseStatus,
    relativePath: `./${STATUS_DOCUMENT_FILENAME}`,
    validStatuses: [...LIFECYCLE_STAGES] as LifecycleStage[],
    autoResolved: false as const,
    documentToDatabaseSync: false as const
  };

  const unavailable = (reason: StatusUnavailableReason, message: string, possibleAction: string): StatusConsistency => ({
    ...base,
    documentStatus: null,
    isConsistent: null,
    state: 'UNAVAILABLE',
    documentExists: null,
    documentModifiedAt: null,
    rawDocumentStatus: null,
    reason,
    message,
    possibleAction
  });

  // Reading the configured root can fail (settings storage, a deleted root).
  // This function is called after the database has already been updated, so it
  // must not throw: an exception here would turn an applied change into a bare
  // 500 and hide the fact that it succeeded.
  let resolved: StatusPathResult;
  try {
    resolved = await resolveStatusDocumentPath(project);
  } catch (err) {
    return unavailable(
      'PROJECTS_ROOT_NOT_CONFIGURED',
      `Project Hub could not determine where ${STATUS_DOCUMENT_FILENAME} lives (${(err as NodeJS.ErrnoException)?.message ?? 'unknown error'}).`,
      'Check the Projects Root in Settings, then reload this page. The project status in the database was not affected.'
    );
  }
  if (!resolved.available) {
    return unavailable(resolved.reason, resolved.message, resolved.possibleAction);
  }

  const shared = {
    ...base,
    documentPath: resolved.path.documentPath,
    documentExists: null as boolean | null,
    documentModifiedAt: null as string | null
  };

  // Same on-disk check as the reader. Without it, a workspace replaced by a link
  // would make this report compare the database against a file from outside the
  // Projects Root - a read that quietly escapes the boundary.
  const workspace = await probeStatusWorkspace(resolved.path.folderPath);
  if (!workspace.usable) {
    return {
      ...base,
      documentStatus: null,
      isConsistent: null,
      state: 'UNAVAILABLE',
      documentExists: null,
      documentModifiedAt: null,
      rawDocumentStatus: null,
      reason: workspace.reason,
      message: workspace.message,
      possibleAction: workspace.possibleAction
    };
  }

  let stat: import('node:fs').Stats;
  try {
    stat = await fsp.lstat(resolved.path.documentPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return {
        ...shared,
        documentStatus: null,
        isConsistent: null,
        state: 'DOCUMENT_MISSING',
        rawDocumentStatus: null,
        message: `${STATUS_DOCUMENT_FILENAME} is missing for this project.`,
        possibleAction: `Use "Initialize ${STATUS_DOCUMENT_FILENAME}" to create it from the current database status (${databaseStatus}). The project status does not change.`
      };
    }
    return {
      ...shared,
      documentStatus: null,
      isConsistent: null,
      state: 'DOCUMENT_UNREADABLE',
      rawDocumentStatus: null,
      message: `Project Hub could not read ${STATUS_DOCUMENT_FILENAME} (${(err as NodeJS.ErrnoException)?.code ?? 'unknown error'}).`,
      possibleAction: 'Check the workspace folder and its permissions, then reload this page.'
    };
  }

  const modifiedAt = stat.mtime.toISOString();
  if (stat.isDirectory() || stat.isSymbolicLink()) {
    return {
      ...shared,
      documentStatus: null,
      isConsistent: null,
      state: 'DOCUMENT_UNREADABLE',
      documentExists: true,
      documentModifiedAt: modifiedAt,
      rawDocumentStatus: null,
      message: stat.isDirectory()
        ? `A folder is sitting where ${STATUS_DOCUMENT_FILENAME} should be.`
        : `${STATUS_DOCUMENT_FILENAME} for this project is a link, so Project Hub will not read through it.`,
      possibleAction: 'Remove or rename it yourself, then reload this page. Project Hub changed nothing.'
    };
  }
  if (stat.size > STATUS_DOCUMENT_MAX_BYTES) {
    return {
      ...shared,
      documentStatus: null,
      isConsistent: null,
      state: 'DOCUMENT_UNREADABLE',
      documentExists: true,
      documentModifiedAt: modifiedAt,
      rawDocumentStatus: null,
      message: `${STATUS_DOCUMENT_FILENAME} is ${stat.size} bytes, over the ${STATUS_DOCUMENT_MAX_BYTES} byte limit.`,
      possibleAction: 'Open the file in your editor instead. Project Hub changed nothing.'
    };
  }

  let parsed: ParsedStatusDocument;
  try {
    parsed = await readAndParse(resolved.path.documentPath);
  } catch (err) {
    return {
      ...shared,
      documentStatus: null,
      isConsistent: null,
      state: 'DOCUMENT_UNREADABLE',
      documentExists: true,
      documentModifiedAt: modifiedAt,
      rawDocumentStatus: null,
      message: `Project Hub could not read ${STATUS_DOCUMENT_FILENAME} (${(err as NodeJS.ErrnoException)?.code ?? 'unknown error'}).`,
      possibleAction: 'Check the permissions on the workspace folder, then reload this page.'
    };
  }

  const withFile = {
    ...shared,
    documentExists: true,
    documentModifiedAt: modifiedAt,
    rawDocumentStatus: parsed.rawStatus,
    documentProjectId: parsed.projectId
  };

  // No status line at all is not "mismatch", it is an unreadable declaration.
  if (!parsed.hasStatusLine) {
    return {
      ...withFile,
      documentStatus: null,
      isConsistent: null,
      state: 'DOCUMENT_INVALID',
      invalidDocumentStatus: null,
      message: `${STATUS_DOCUMENT_FILENAME} does not declare a status. Expected a line like "**Status:** ${databaseStatus}".`,
      possibleAction: 'Add the status line, or use "Regenerate" to rebuild the document from the database.'
    };
  }
  if (!parsed.isValidStatus) {
    return {
      ...withFile,
      documentStatus: null,
      isConsistent: null,
      state: 'DOCUMENT_INVALID',
      invalidDocumentStatus: parsed.rawStatus,
      message: `Invalid project status: ${parsed.rawStatus}`,
      possibleAction: `Correct the status in the file to one of: ${LIFECYCLE_STAGES.join(', ')}. Project Hub has not changed the project record, which is still ${databaseStatus}.`
    };
  }
  // A status line that belongs to another project is a copied file, not a
  // disagreement about this project's status.
  if (parsed.projectId !== null && parsed.projectId !== project.id) {
    return {
      ...withFile,
      documentStatus: parsed.status,
      isConsistent: null,
      state: 'DOCUMENT_INVALID',
      message: `${STATUS_DOCUMENT_FILENAME} in this project folder declares p-hub-project-id ${parsed.projectId}, which is a different project.`,
      possibleAction: 'Restore the correct document, or use "Regenerate" to rebuild it for this project.'
    };
  }

  const consistent = parsed.status === databaseStatus;
  return {
    ...withFile,
    documentStatus: parsed.status,
    isConsistent: consistent,
    state: consistent ? 'SYNCHRONIZED' : 'STATUS_MISMATCH',
    message: consistent
      ? `${STATUS_DOCUMENT_FILENAME} and the project record both say ${databaseStatus}.`
      : `The project record says ${databaseStatus} and ${STATUS_DOCUMENT_FILENAME} says ${parsed.status}. Project Hub has not changed anything.`,
    possibleAction: consistent
      ? undefined
      : `If the database is right, use "Regenerate ${STATUS_DOCUMENT_FILENAME}". If the document is right, change the status in Project Hub - editing the file never changes the record.`
  };
}

// ---------------------------------------------------------------------------
// The centralized status service (section 7)
// ---------------------------------------------------------------------------

/** The columns the status service needs from a project row. */
export type ProjectRow = {
  id: number;
  slug: string;
  name: string;
  stage: string;
  isArchived: boolean;
  folderName: string | null;
  folderPath: string | null;
};

export interface ChangeStatusResult {
  /**
   * The project row as it stands after the call. The full row is returned so
   * that the pre-existing `POST /projects/:id/stage` response shape - where
   * callers read `data.stage` - is unchanged.
   */
  project: ProjectRow;
  previousStatus: LifecycleStage;
  statusChanged: boolean;
  /** False when the document could not be written or did not need to be. */
  documentWritten: boolean;
  /** True when the requested status was already the stored one. */
  noChange: boolean;
  consistency: StatusConsistency;
  /** Set when the database changed but STATUS.md did not. Never silent. */
  warning?: { code: string; message: string; possibleAction: string };
}

/**
 * Change a project's status. The only place `projects.stage` is written from.
 *
 * Order, and why:
 *
 *   1. load the project
 *   2. validate the requested status against the real enum
 *   3. update the database (the authority)
 *   4. update STATUS.md (the control representation)
 *   5. return the new state, including any disagreement
 *
 * Steps 3 and 4 cannot be atomic - a database row and a text file have no shared
 * transaction. The recovery strategy is therefore explicit rather than
 * pretended: if step 4 fails, the database change is **kept** and the response
 * carries a warning naming the failure, because the database is the authority
 * and re-writing the database to "undo" a change the user asked for would be a
 * second failure surface. The document is left exactly as it was - nothing is
 * deleted - and the returned consistency snapshot states the disagreement so the
 * user can regenerate explicitly.
 *
 * A change to the status the project already has is a deliberate no-op: the
 * database is not written, no activity event is logged, and STATUS.md is left
 * alone rather than being overwritten. Silently replacing a file the user may
 * have edited by hand, because they re-selected the value already set, is not
 * something a "set the status" action should do.
 */
export async function changeProjectStatus(
  projectId: number,
  requested: unknown,
  options: { note?: string } = {}
): Promise<ChangeStatusResult> {
  const stage = parseLifecycleStage(requested);
  if (!stage) {
    throw invalidStatusError(requested, 'change the project status');
  }

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    throw new ApiError(404, 'Project not found.', undefined, {
      category: 'NOT_FOUND',
      operation: 'change the project status',
      possibleAction: 'Reload the project list and open an existing project.'
    });
  }

  const previousStatus = parseLifecycleStage(project.stage) ?? INITIAL_PROJECT_STATUS;

  if (previousStatus === stage) {
    const consistency = await statusConsistency(project);
    return {
      project,
      previousStatus,
      statusChanged: false,
      documentWritten: false,
      noChange: true,
      consistency
    };
  }

  const updated = await prisma.project.update({ where: { id: project.id }, data: { stage } });

  let documentWritten = false;
  let warning: ChangeStatusResult['warning'];

  try {
    // The status genuinely changed, so the control document is now stale and
    // this is an intentional write - not a regeneration behind the user's back.
    const written = await writeStatusDocument(updated, { overwrite: true });
    documentWritten = true;
    if (written.replaced === false) {
      warning = {
        code: 'STATUS_DOCUMENT_CREATED_ON_CHANGE',
        message: `The status is now ${stage}, and ${STATUS_DOCUMENT_FILENAME} did not exist, so it was created from the database.`,
        possibleAction: 'Nothing to do. Open STATUS.md from the project page to read it.'
      };
    }
  } catch (err) {
    const e = err as ApiError;
    warning = {
      code: String((e.details as any)?.code ?? 'STATUS_DOCUMENT_NOT_UPDATED'),
      message: `The project status is now ${stage}, but ${STATUS_DOCUMENT_FILENAME} could not be updated: ${e.message}`,
      possibleAction:
        e.possibleAction ??
        `The database is the authority and was updated. Open the project page to see the disagreement, then regenerate ${STATUS_DOCUMENT_FILENAME} once the folder is writable.`
    };
  }

  // The activity event is written after the document, and is itself guarded. A
  // missing timeline entry must not be able to skip the document write or turn
  // an already-applied status change into a bare 500: the user asked for a status
  // change, it happened, and the response says what did not.
  try {
    await logActivity({
      projectId: project.id,
      type: 'STAGE_CHANGED',
      description: `Stage changed: ${previousStatus} → ${stage}${options.note ? ` (${options.note})` : ''}`,
      metadata: {
        fromStage: previousStatus,
        toStage: stage,
        note: options.note ?? null,
        statusDocument: STATUS_DOCUMENT_FILENAME,
        statusDocumentWritten: documentWritten
      },
      relatedType: 'project',
      relatedId: project.id
    });
  } catch {
    warning = warning ?? {
      code: 'STATUS_CHANGE_NOT_LOGGED',
      message: `The project status is now ${stage} and ${STATUS_DOCUMENT_FILENAME} was updated, but the timeline entry for this change could not be written.`,
      possibleAction: 'Reload the project page. The status itself is saved and did not need to be set again.'
    };
  }

  const consistency = await statusConsistency(updated);

  return {
    project: updated,
    previousStatus,
    statusChanged: true,
    documentWritten,
    noChange: false,
    consistency,
    ...(warning ? { warning } : {})
  };
}

// ---------------------------------------------------------------------------
// Document creation helper (section 3, step 5)
// ---------------------------------------------------------------------------

export interface InitializeStatusDocumentResult {
  created: boolean;
  status: StatusDocumentStatus;
  bytes?: number;
  /** Set when the document is unavailable; the project itself is fine. */
  warning?: { code: string; message: string; possibleAction: string };
}

/**
 * Initialize STATUS.md for a newly created project.
 *
 * Never throws and never rolls anything back. At this point in project creation
 * the folder and the database row already exist and are correct; refusing the
 * whole project because one file could not be written would destroy work that
 * succeeded. A failure is reported as a warning on an otherwise successful
 * creation, and the project page offers the same action later.
 */
export async function initializeStatusDocument(project: {
  id: number;
  name: string;
  stage: string;
  folderPath: string | null;
}): Promise<InitializeStatusDocumentResult> {
  try {
    const written = await writeStatusDocument(project, { overwrite: false });
    return { created: true, status: written.status, bytes: written.bytes };
  } catch (err) {
    const e = err as ApiError;
    return {
      created: false,
      status: await statusDocumentStatus(project),
      warning: {
        code: String((e.details as any)?.code ?? 'STATUS_DOCUMENT_NOT_CREATED'),
        message: e.message,
        possibleAction:
          e.possibleAction ??
          `The project and its folder were created. Initialize ${STATUS_DOCUMENT_FILENAME} from the project page when you are ready.`
      }
    };
  }
}
