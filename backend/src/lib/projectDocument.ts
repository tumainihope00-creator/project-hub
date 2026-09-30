import fsp from 'node:fs/promises';
import path from 'node:path';
import { prisma } from './prisma.js';
import { ApiError } from './errors.js';
import { readProjectsRootSetting } from './settings.js';
import { probeProjectsRoot } from './paths.js';
import { isInsideRoot } from './projectWorkspace.js';
import { tagsFor } from './tags.js';

/**
 * Phase 4: PROJECT.md, the human-readable document that lives at the root of a
 * project's workspace folder.
 *
 * The single rule this file exists to enforce:
 *
 *   DATABASE -> PROJECT.md      supported here
 *   PROJECT.md -> DATABASE      NOT supported, and not attempted
 *
 * Nothing in this module parses, imports, or applies anything from an existing
 * PROJECT.md. The document is written from the database and read back for human
 * inspection only. A later synchronization phase owns the other direction; if
 * this file ever grows a parser, that boundary has been crossed.
 *
 * Everything is generated from an explicit allowlist of real columns. No field
 * is invented, and `originalIdea` is deliberately excluded: it is a JSON
 * snapshot of the project, so including it would duplicate the document inside
 * itself.
 */

/** The one filename this feature owns. It is never derived from user input. */
export const PROJECT_DOCUMENT_FILENAME = 'PROJECT.md';

/**
 * Bumped only when the document's own structure changes, so a future
 * synchronizer can tell a format change from a content change. It is a constant
 * and never a build or generation timestamp.
 */
export const PROJECT_DOCUMENT_VERSION = 1;

/** Refuse to write or read a document larger than this. */
export const PROJECT_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

type ProjectRow = {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  problem: string | null;
  motivation: string | null;
  targetUsers: string | null;
  expectedValue: string | null;
  assumptions: string | null;
  initialQuestions: string | null;
  inspiration: string | null;
  v1Scope: string | null;
  stage: string;
  isArchived: boolean;
  archivedAt: Date | null;
  repositoryUrl: string | null;
  folderName: string | null;
  folderPath: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export interface ProjectDocumentData {
  project: ProjectRow;
  research: any[];
  researchQuestions: any[];
  requirements: any[];
  features: any[];
  decisions: any[];
  techStack: any[];
  tables: any[];
  endpoints: any[];
  milestones: any[];
  tasks: any[];
  issues: any[];
  notes: any[];
  deployments: any[];
  gitReferences: any[];
  developmentSessions: any[];
  tags: string[];
}

/**
 * Every list is ordered inside the query, and every order ends in a unique
 * column. Two reads of unchanged data therefore produce byte-identical
 * documents, which is what makes "regenerate and diff" a meaningful operation.
 */
const CHILD_ORDER = {
  requirements: { orderBy: { code: 'asc' as const } },
  features: { orderBy: [{ name: 'asc' as const }, { id: 'asc' as const }] },
  decisions: { orderBy: { code: 'asc' as const } },
  techStack: { orderBy: [{ category: 'asc' as const }, { technology: 'asc' as const }, { id: 'asc' as const }] },
  tables: { orderBy: [{ name: 'asc' as const }, { id: 'asc' as const }] },
  endpoints: { orderBy: [{ path: 'asc' as const }, { method: 'asc' as const }, { id: 'asc' as const }] },
  research: { orderBy: [{ date: 'desc' as const }, { id: 'asc' as const }] },
  researchQuestions: { orderBy: { id: 'asc' as const } },
  milestones: { orderBy: [{ targetDate: { sort: 'asc' as const, nulls: 'last' as const } }, { name: 'asc' as const }, { id: 'asc' as const }] },
  tasks: { orderBy: { code: 'asc' as const } },
  issues: { orderBy: { code: 'asc' as const } },
  notes: { orderBy: [{ updatedAt: 'desc' as const }, { id: 'asc' as const }] },
  deployments: { orderBy: [{ date: 'desc' as const }, { id: 'asc' as const }] },
  gitReferences: { orderBy: [{ date: 'desc' as const }, { id: 'asc' as const }] },
  developmentSessions: { orderBy: { number: 'asc' as const } }
};

export async function loadProjectDocumentData(projectId: number): Promise<ProjectDocumentData> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { ...CHILD_ORDER }
  });
  if (!project) {
    throw new ApiError(404, 'Project not found.', undefined, {
      category: 'NOT_FOUND',
      operation: 'load the project for its PROJECT.md',
      possibleAction: 'Go back to the project list and open an existing project.'
    });
  }
  const rest = project as any;
  return {
    project: rest as ProjectRow,
    ...(Object.fromEntries(Object.keys(CHILD_ORDER).map(k => [k, (rest as any)[k] ?? []])) as any),
    // Tags are polymorphic (tag_assignments has no foreign key to projects), so
    // they cannot be reached through a Prisma relation.
    tags: (await tagsFor('project', projectId)).map(t => t.name)
  };
}

// ---------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------

/** `NON_FUNCTIONAL` -> `Non-functional`. For human-facing labels only. */
function label(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  return String(value)
    .replace(/_/g, '-')
    .toLowerCase()
    .replace(/^./, c => c.toUpperCase());
}

/** A YAML double-quoted scalar. A project name may contain quotes or colons. */
function yamlScalar(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()}"`;
}

const STRUCTURAL_LINE =
  /^(?:#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s|\||```|~~~|={3,}\s*$|-{3,}\s*$|\*{3,}\s*$)/;

/**
 * Make a free-text value safe to drop into the document as prose.
 *
 * A description is user text and may legitimately contain `#`, `-` or a fenced
 * block. Left alone, a line like `## Requirements` inside a description would
 * forge a section heading, and the document would claim structure the project
 * does not have. Escaping the leading character keeps the text readable and
 * stops it from being read as structure.
 */
function prose(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => {
      const trimmed = line.replace(/\s+$/, '');
      return STRUCTURAL_LINE.test(trimmed) ? `\\${trimmed}` : trimmed;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Collapse a value to a single line, for use inside a bullet. */
function oneLine(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/\s+/g, ' ').trim();
}

function isoDate(value: Date | null | undefined): string {
  return value ? value.toISOString().slice(0, 10) : '';
}

function section(heading: string, body: string): string {
  return `## ${heading}\n\n${body}`;
}

const NOT_DOCUMENTED = '_Not yet documented._';

/** A narrative field rendered as a bold label and its text. */
function field(labelText: string, value: string | null | undefined): string | null {
  const text = prose(value);
  if (!text) return null;
  return `**${labelText}**\n\n${text}`;
}

function fieldGroup(fields: { label: string; value: string | null | undefined }[]): string {
  const present = fields.map(f => field(f.label, f.value)).filter((x): x is string => !!x);
  return present.length ? present.join('\n\n') : NOT_DOCUMENTED;
}

/**
 * One record as a bullet, with its detail lines indented beneath it.
 *
 * A leading `- ` line is the shape the existing importer reads most reliably,
 * so the generated document stays something the current importer can already
 * understand (Phase 4 does not use that, but Phase 6 will).
 */
function record(title: string, attributes: string[], detail?: string | null): string {
  const lines = [`- ${title}`];
  if (attributes.length) lines.push(`  - ${attributes.join(' · ')}`);
  const text = prose(detail);
  if (text) {
    for (const line of text.split('\n')) lines.push(line ? `  ${line}` : '');
  }
  return lines.join('\n');
}

function recordList(items: string[], emptyMessage: string): string {
  return items.length ? items.join('\n') : `_${emptyMessage}_`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Build the document. Pure: same data in, same bytes out, no clock, no
 * randomness, no filesystem, no database.
 */
export function renderProjectDocument(data: ProjectDocumentData): string {
  const p = data.project;
  const out: string[] = [];

  out.push(
    [
      '---',
      `p-hub-document: ${yamlScalar(PROJECT_DOCUMENT_FILENAME)}`,
      `p-hub-document-version: ${PROJECT_DOCUMENT_VERSION}`,
      `p-hub-project-id: ${p.id}`,
      `p-hub-project-name: ${yamlScalar(p.name)}`,
      `p-hub-project-slug: ${yamlScalar(p.slug)}`,
      'p-hub-direction: "database-to-document"',
      '---'
    ].join('\n')
  );
  out.push(`# ${oneLine(p.name) || 'Untitled project'}`);
  out.push(
    [
      '> Written by Project Hub from the project record. Project Hub writes this file and',
      '> does not read it back: edits you make here are **not** applied to Project Hub, and',
      '> regenerating the document replaces them. To change this document, change the',
      '> project in Project Hub and regenerate.'
    ].join('\n')
  );

  out.push(
    section(
      'Overview',
      fieldGroup([
        { label: 'Description', value: p.description },
        { label: 'Problem', value: p.problem },
        { label: 'Motivation', value: p.motivation },
        { label: 'Target Users', value: p.targetUsers },
        { label: 'Expected Value', value: p.expectedValue }
      ])
    )
  );

  out.push(
    section(
      'Project Status',
      fieldGroup([
        { label: 'Stage', value: label(p.stage) },
        { label: 'Archived', value: p.isArchived ? `Yes, since ${isoDate(p.archivedAt) || 'an unrecorded date'}` : 'No' },
        { label: 'Created', value: isoDate(p.createdAt) },
        { label: 'Last Updated', value: isoDate(p.updatedAt) }
      ])
    )
  );

  out.push(section('V1 Scope', prose(p.v1Scope) || NOT_DOCUMENTED));
  out.push(section('Assumptions', prose(p.assumptions) || NOT_DOCUMENTED));
  out.push(section('Initial Questions', prose(p.initialQuestions) || NOT_DOCUMENTED));
  out.push(section('Inspiration', prose(p.inspiration) || NOT_DOCUMENTED));

  out.push(
    section(
      'Research',
      recordList(
        data.research.map(r =>
          record(
            oneLine(r.title) || 'Untitled research entry',
            [label(r.type), r.date ? isoDate(r.date) : ''].filter(Boolean),
            r.summary || r.findings
          )
        ),
        'No research documented yet.'
      )
    )
  );

  out.push(
    section(
      'Research Questions',
      recordList(
        data.researchQuestions.map(q =>
          record(
            oneLine(q.question) || 'Untitled question',
            [label(q.status), q.category ? label(q.category) : ''].filter(Boolean),
            q.answer
          )
        ),
        'No research questions documented yet.'
      )
    )
  );

  out.push(
    section(
      'Requirements',
      recordList(
        data.requirements.map(r =>
          record(
            `**${oneLine(r.code)}** ${oneLine(r.title) || 'Untitled requirement'}`,
            [label(r.type), `Priority: ${label(r.priority)}`, label(r.status)],
            r.description
          )
        ),
        'No requirements documented yet.'
      )
    )
  );

  out.push(
    section(
      'Features',
      recordList(
        data.features.map(f =>
          record(
            oneLine(f.name) || 'Untitled feature',
            [`Priority: ${label(f.priority)}`, label(f.status)],
            f.description
          )
        ),
        'No features documented yet.'
      )
    )
  );

  out.push(
    section(
      'Technology Stack',
      recordList(
        data.techStack.map(t =>
          record(
            oneLine(t.technology) || 'Unnamed technology',
            [label(t.category), t.version ? oneLine(t.version) : ''].filter(Boolean),
            t.notes
          )
        ),
        'No technology stack documented yet.'
      )
    )
  );

  out.push(
    section(
      'Architecture Decisions',
      recordList(
        data.decisions.map(d =>
          record(
            `**${oneLine(d.code)}** ${oneLine(d.title) || 'Untitled decision'}`,
            [label(d.status)],
            [d.decision, d.context, d.reasoning, d.consequences].filter(Boolean).join('\n\n') || null
          )
        ),
        'No architecture decisions documented yet.'
      )
    )
  );

  out.push(
    section(
      'Database Tables',
      recordList(
        data.tables.map(t => record(oneLine(t.name) || 'Untitled table', [], t.purpose)),
        'No database tables documented yet.'
      )
    )
  );

  out.push(
    section(
      'API Endpoints',
      recordList(
        data.endpoints.map(e =>
          record(`\`${oneLine(e.method)} ${oneLine(e.path)}\``, [], [e.description, e.requestBody, e.response, e.notes].filter(Boolean).join('\n\n') || null)
        ),
        'No API endpoints documented yet.'
      )
    )
  );

  out.push(
    section(
      'Milestones',
      recordList(
        data.milestones.map(m =>
          record(
            oneLine(m.name) || 'Untitled milestone',
            [label(m.status), m.targetDate ? `Target: ${isoDate(m.targetDate)}` : ''].filter(Boolean),
            m.description
          )
        ),
        'No milestones documented yet.'
      )
    )
  );

  out.push(
    section(
      'Tasks',
      recordList(
        data.tasks.map(t =>
          record(
            `**${oneLine(t.code)}** ${oneLine(t.title) || 'Untitled task'}`,
            [label(t.status), `Priority: ${label(t.priority)}`, t.dueDate ? `Due: ${isoDate(t.dueDate)}` : ''].filter(Boolean),
            t.description
          )
        ),
        'No tasks documented yet.'
      )
    )
  );

  out.push(
    section(
      'Issues',
      recordList(
        data.issues.map(i =>
          record(
            `**${oneLine(i.code)}** ${oneLine(i.title) || 'Untitled issue'}`,
            [label(i.status), `Severity: ${label(i.severity)}`],
            [i.description, i.expectedBehavior, i.actualBehavior, i.solution].filter(Boolean).join('\n\n') || null
          )
        ),
        'No issues documented yet.'
      )
    )
  );

  out.push(
    section(
      'Notes',
      recordList(
        data.notes.map(n => record(oneLine(n.title) || 'Untitled note', [], n.content)),
        'No notes documented yet.'
      )
    )
  );

  out.push(section('Repository', p.repositoryUrl ? `<${oneLine(p.repositoryUrl)}>` : NOT_DOCUMENTED));

  out.push(
    section(
      'Deployment',
      recordList(
        data.deployments.map(d =>
          record(
            `${label(d.environment)} — ${label(d.status)}`,
            [d.version ? `Version: ${oneLine(d.version)}` : '', d.date ? isoDate(d.date) : ''].filter(Boolean),
            [d.url ? `<${oneLine(d.url)}>` : '', d.platform, d.branch, d.commitHash, d.notes].filter(Boolean).join('\n\n') || null
          )
        ),
        'No deployments recorded yet.'
      )
    )
  );

  out.push(
    section(
      'Development Sessions',
      recordList(
        data.developmentSessions.map(s =>
          record(
            `Session ${s.number} — ${isoDate(s.date)}`,
            [s.durationMinutes ? `${s.durationMinutes} min` : ''].filter(Boolean),
            [s.goal, s.workedOn, s.completed, s.problems, s.learned, s.nextStep].filter(Boolean).join('\n\n') || null
          )
        ),
        'No development sessions recorded yet.'
      )
    )
  );

  out.push(
    section(
      'Git References',
      recordList(
        data.gitReferences.map(g =>
          record(
            label(g.kind),
            [g.date ? isoDate(g.date) : '', g.branch, g.commitHash, g.release, g.pullRequest]
              .map(oneLine)
              .filter(Boolean),
            [g.repositoryUrl ? `<${oneLine(g.repositoryUrl)}>` : '', g.commitMessage, g.notes].filter(Boolean).join('\n\n') || null
          )
        ),
        'No git references recorded yet.'
      )
    )
  );

  out.push(
    section(
      'Tags',
      recordList(
        data.tags.map(t => `- ${oneLine(t)}`),
        'No tags.'
      )
    )
  );

  // Blocks are joined with a blank line between them, so the document is a
  // sequence of complete blocks rather than a concatenation that depends on
  // every block remembering its own trailing newline.
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// ---------------------------------------------------------------------------
// Path resolution and safety
// ---------------------------------------------------------------------------

export type UnavailableReason =
  | 'PROJECTS_ROOT_NOT_CONFIGURED'
  | 'PROJECT_WORKSPACE_MISSING'
  | 'PROJECT_WORKSPACE_UNSAFE'
  | 'PROJECT_WORKSPACE_NOT_ON_DISK';

export interface ResolvedProjectDocumentPath {
  root: string;
  folderPath: string;
  documentPath: string;
  relativePath: string;
}

export type DocumentPathResult =
  | { available: true; path: ResolvedProjectDocumentPath }
  | { available: false; reason: UnavailableReason; message: string; possibleAction: string };

/**
 * Work out where this project's PROJECT.md must be, from the database alone.
 *
 * The frontend never supplies a path. The only inputs are the project row and
 * the configured Projects Root, and the result is proven to be
 * `<Projects Root>/<project folder>/PROJECT.md` three separate ways before any
 * filesystem call is made.
 */
export async function resolveProjectDocumentPath(project: {
  folderPath: string | null;
}): Promise<DocumentPathResult> {
  const stored = await readProjectsRootSetting();
  if (!stored) {
    return {
      available: false,
      reason: 'PROJECTS_ROOT_NOT_CONFIGURED',
      message: 'No Projects Root is configured, so PROJECT.md has nowhere to live.',
      possibleAction: 'Open Settings and set a Projects Root, then try again.'
    };
  }
  if (!project.folderPath) {
    return {
      available: false,
      reason: 'PROJECT_WORKSPACE_MISSING',
      message: 'This project has no workspace folder, so it cannot have a PROJECT.md.',
      possibleAction:
        'Only projects created with a workspace folder have one. Create the project from the New Project dialog, or create a workspace folder in a later phase.'
    };
  }

  const root = path.resolve(stored.value);
  const folderPath = path.resolve(project.folderPath);
  const documentPath = path.resolve(folderPath, PROJECT_DOCUMENT_FILENAME);

  const insideRoot = isInsideRoot(root, folderPath) && isInsideRoot(root, documentPath);
  const parentIsTheFolder = path.dirname(documentPath) === folderPath;

  if (!insideRoot || !parentIsTheFolder) {
    return {
      available: false,
      reason: 'PROJECT_WORKSPACE_UNSAFE',
      message: 'The stored workspace path for this project does not resolve to a folder inside the configured Projects Root.',
      possibleAction:
        'Project Hub will not read or write outside the Projects Root. Check the Projects Root in Settings, or recreate the project so its workspace is recorded correctly.'
    };
  }

  return {
    available: true,
    path: { root, folderPath, documentPath, relativePath: `./${PROJECT_DOCUMENT_FILENAME}` }
  };
}

/** The same check, but as an error. Used by every endpoint that acts. */
async function requireProjectDocumentPath(project: {
  folderPath: string | null;
}): Promise<ResolvedProjectDocumentPath> {
  const result = await resolveProjectDocumentPath(project);
  if (result.available) return result.path;
  throw new ApiError(
    409,
    result.message,
    { code: result.reason, relativePath: `./${PROJECT_DOCUMENT_FILENAME}` },
    {
      category: 'VALIDATION_FAILED',
      operation: 'resolve the PROJECT.md path for this project',
      possibleAction: result.possibleAction
    }
  );
}

// ---------------------------------------------------------------------------
// Status, read, write
// ---------------------------------------------------------------------------

export interface ProjectDocumentStatus {
  projectId: number;
  projectName: string;
  available: boolean;
  reason?: UnavailableReason;
  message?: string;
  possibleAction?: string;
  relativePath: string;
  documentPath?: string;
  exists: boolean | null;
  isDirectory: boolean;
  sizeBytes: number | null;
  modifiedAt: string | null;
  workspaceExists: boolean | null;
  workspaceIsSymbolicLink: boolean;
  documentVersion: number;
  direction: 'DATABASE_TO_DOCUMENT';
  documentToDatabaseSync: false;
}

export async function projectDocumentStatus(project: {
  id: number;
  name: string;
  folderPath: string | null;
}): Promise<ProjectDocumentStatus> {
  const base = {
    projectId: project.id,
    projectName: project.name,
    relativePath: `./${PROJECT_DOCUMENT_FILENAME}`,
    isDirectory: false,
    sizeBytes: null,
    modifiedAt: null,
    workspaceExists: null,
    workspaceIsSymbolicLink: false,
    documentVersion: PROJECT_DOCUMENT_VERSION,
    direction: 'DATABASE_TO_DOCUMENT' as const,
    documentToDatabaseSync: false as const
  };

  const resolved = await resolveProjectDocumentPath(project);
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
  let exists: boolean | null = null;
  let sizeBytes: number | null = null;
  let modifiedAt: string | null = null;
  let isDirectory = false;

  try {
    const stat = await fsp.lstat(resolved.path.documentPath);
    exists = true;
    isDirectory = stat.isDirectory();
    if (!isDirectory && !stat.isSymbolicLink()) {
      sizeBytes = stat.size;
      modifiedAt = stat.mtime.toISOString();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      exists = null;
    } else {
      exists = false;
    }
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
    workspaceIsSymbolicLink: probe.isSymbolicLink
  };
}

/** Render the document without writing anything. Used by the tests and preview. */
export async function previewProjectDocument(projectId: number): Promise<{ markdown: string; status: ProjectDocumentStatus }> {
  const data = await loadProjectDocumentData(projectId);
  const markdown = renderProjectDocument(data);
  return { markdown, status: await projectDocumentStatus(data.project) };
}

export interface WriteProjectDocumentResult {
  status: ProjectDocumentStatus;
  replaced: boolean;
  bytes: number;
}

/**
 * Write PROJECT.md for a project.
 *
 * `overwrite: false` (the "generate" action) writes with the `wx` flag, so the
 * write itself fails if the file appeared in the meantime - the check and the
 * write cannot disagree. `overwrite: true` (the "regenerate" action) replaces
 * exactly this one file and touches nothing else in the folder.
 */
export async function writeProjectDocument(
  project: { id: number; name: string; folderPath: string | null },
  options: { overwrite: boolean }
): Promise<WriteProjectDocumentResult> {
  const resolved = await requireProjectDocumentPath(project);

  const probe = await probeProjectsRoot(resolved.folderPath, { testWrite: false });
  if (probe.isSymbolicLink) {
    // Writing through a link would place the file at the link's target, which is
    // exactly the escape the Projects Root boundary exists to prevent. This is
    // checked before the directory check because a link reports itself as "not a
    // directory", and "it is a link" is the more useful thing to tell the user.
    throw new ApiError(
      409,
      'The workspace folder for this project is a link, so Project Hub will not write through it.',
      { code: 'PROJECT_WORKSPACE_IS_A_LINK', folderPath: resolved.folderPath },
      {
        category: 'VALIDATION_FAILED',
        operation: 'write PROJECT.md',
        possibleAction:
          'Replace the link with a real folder, or point the project at a different workspace in a later phase.'
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
        operation: 'write PROJECT.md',
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
      'A link already exists where PROJECT.md should be, so Project Hub will not write through it.',
      { code: 'PROJECT_DOCUMENT_IS_A_LINK', documentPath: resolved.documentPath },
      {
        category: 'CONFLICT',
        operation: 'write PROJECT.md',
        possibleAction: 'Remove the link yourself, or choose a different project name and create it again.'
      }
    );
  }
  if (isDirectory) {
    throw new ApiError(
      409,
      'A folder exists where PROJECT.md should be.',
      { code: 'PROJECT_DOCUMENT_IS_A_DIRECTORY', documentPath: resolved.documentPath },
      {
        category: 'CONFLICT',
        operation: 'write PROJECT.md',
        possibleAction: 'Remove or rename that folder yourself, then try again.'
      }
    );
  }
  if (exists && !options.overwrite) {
    throw new ApiError(
      409,
      'PROJECT.md already exists for this project.',
      { code: 'PROJECT_DOCUMENT_EXISTS', documentPath: resolved.documentPath, modifiedAt: null },
      {
        category: 'CONFLICT',
        operation: 'write PROJECT.md',
        possibleAction:
          'Use "Regenerate PROJECT.md" if you want to replace it with the version built from the project record. Regenerating discards any edits made to the file.'
      }
    );
  }

  const data = await loadProjectDocumentData(project.id);
  const markdown = renderProjectDocument(data);
  const bytes = Buffer.byteLength(markdown, 'utf8');
  if (bytes > PROJECT_DOCUMENT_MAX_BYTES) {
    throw new ApiError(
      422,
      `PROJECT.md would be ${bytes} bytes, over the ${PROJECT_DOCUMENT_MAX_BYTES} byte limit, so it was not written.`,
      { code: 'PROJECT_DOCUMENT_TOO_LARGE', bytes, limit: PROJECT_DOCUMENT_MAX_BYTES },
      {
        category: 'VALIDATION_FAILED',
        operation: 'write PROJECT.md',
        possibleAction: 'Shorten the longest notes or descriptions in Project Hub, then generate the document again.'
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
        'PROJECT.md already exists for this project.',
        { code: 'PROJECT_DOCUMENT_EXISTS', documentPath: resolved.documentPath },
        {
          category: 'CONFLICT',
          operation: 'write PROJECT.md',
          possibleAction: 'Use "Regenerate PROJECT.md" to replace it with the version built from the project record.'
        }
      );
    }
    throw new ApiError(
      500,
      `Project Hub could not write PROJECT.md (${e.code ?? 'unknown error'}).`,
      { code: 'PROJECT_DOCUMENT_WRITE_FAILED', documentPath: resolved.documentPath, errno: e.code ?? null },
      {
        category: 'FILESYSTEM_ERROR',
        operation: 'write PROJECT.md',
        possibleAction: 'Check that the workspace folder is writable, then try again. Nothing else in the folder was changed.'
      }
    );
  }

  return {
    status: await projectDocumentStatus(project),
    replaced: exists,
    bytes
  };
}

export interface ReadProjectDocumentResult {
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

export async function readProjectDocument(project: {
  id: number;
  name: string;
  folderPath: string | null;
}): Promise<ReadProjectDocumentResult> {
  const resolved = await requireProjectDocumentPath(project);

  let stat: import('node:fs').Stats;
  try {
    stat = await fsp.lstat(resolved.documentPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new ApiError(
        404,
        'This project does not have a PROJECT.md yet.',
        { code: 'PROJECT_DOCUMENT_MISSING', relativePath: resolved.relativePath },
        {
          category: 'NOT_FOUND',
          operation: 'read PROJECT.md',
          possibleAction: 'Generate PROJECT.md from the project record to create it.'
        }
      );
    }
    throw new ApiError(
      500,
      `Project Hub could not read PROJECT.md (${(err as NodeJS.ErrnoException)?.code ?? 'unknown error'}).`,
      { code: 'PROJECT_DOCUMENT_READ_FAILED', documentPath: resolved.documentPath },
      {
        category: 'FILESYSTEM_ERROR',
        operation: 'read PROJECT.md',
        possibleAction: 'Check that the workspace folder still exists and is readable.'
      }
    );
  }

  if (stat.isDirectory()) {
    throw new ApiError(
      409,
      'A folder exists where PROJECT.md should be, so there is no document to show.',
      { code: 'PROJECT_DOCUMENT_IS_A_DIRECTORY', documentPath: resolved.documentPath },
      {
        category: 'CONFLICT',
        operation: 'read PROJECT.md',
        possibleAction: 'Remove or rename that folder yourself, then try again.'
      }
    );
  }
  if (stat.size > PROJECT_DOCUMENT_MAX_BYTES) {
    throw new ApiError(
      422,
      `PROJECT.md is ${stat.size} bytes, over the ${PROJECT_DOCUMENT_MAX_BYTES} byte limit, so it was not opened.`,
      { code: 'PROJECT_DOCUMENT_TOO_LARGE', sizeBytes: stat.size, limit: PROJECT_DOCUMENT_MAX_BYTES },
      {
        category: 'VALIDATION_FAILED',
        operation: 'read PROJECT.md',
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
      `Project Hub could not read PROJECT.md (${(err as NodeJS.ErrnoException)?.code ?? 'unknown error'}).`,
      { code: 'PROJECT_DOCUMENT_READ_FAILED', documentPath: resolved.documentPath },
      {
        category: 'FILESYSTEM_ERROR',
        operation: 'read PROJECT.md',
        possibleAction: 'Check the permissions on the workspace folder.'
      }
    );
  }

  return {
    projectId: project.id,
    projectName: project.name,
    relativePath: resolved.relativePath,
    documentPath: resolved.documentPath,
    content,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    documentVersion: PROJECT_DOCUMENT_VERSION,
    direction: 'DATABASE_TO_DOCUMENT',
    documentToDatabaseSync: false
  };
}
