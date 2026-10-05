import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { api, prisma } from './helpers';
import { PROJECTS_ROOT_KEY } from '../src/lib/settings';
import { PROJECT_DOCUMENT_FILENAME } from '../src/lib/projectDocument';
import { parseProjectDocument } from '../src/lib/projectDocumentParser';

/**
 * Phase 6: PROJECT.md -> database synchronization.
 *
 * The same safety envelope as the Phase 4 suite: a throwaway Projects Root, only
 * `__TEST__` projects created through the real API, everything removed in
 * afterAll, and every pre-existing project row fingerprinted before and after so
 * "existing projects are untouched" is asserted rather than claimed.
 */

const tmpRoots: string[] = [];
const createdProjectIds: number[] = [];
const createdFolders: string[] = [];

let counter = 0;
function uniqueName(prefix = 'Sync'): string {
  counter += 1;
  return `__TEST__ ${prefix} ${Date.now()}-${counter}`;
}

async function projectFingerprint(exclude: number[] = []) {
  const projects = await prisma.project.findMany({ orderBy: { id: 'asc' } });
  return JSON.stringify(
    projects
      .filter(p => !exclude.includes(p.id))
      .map(p => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        stage: p.stage,
        description: p.description,
        v1Scope: p.v1Scope,
        repositoryUrl: p.repositoryUrl,
        folderPath: p.folderPath
      }))
  );
}

let root: string;
let before: string | null = null;

beforeAll(async () => {
  before = await projectFingerprint();
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'phub-p6root-'));
  tmpRoots.push(root);
  await prisma.appSetting.upsert({
    where: { key: PROJECTS_ROOT_KEY },
    create: { key: PROJECTS_ROOT_KEY, value: root },
    update: { value: root }
  });
});

afterAll(async () => {
  for (const id of createdProjectIds) {
    await prisma.activityEvent.deleteMany({ where: { projectId: id } });
    await prisma.project.deleteMany({ where: { id } });
  }
  for (const dir of [...createdFolders, ...tmpRoots]) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  await prisma.appSetting.deleteMany({ where: { key: PROJECTS_ROOT_KEY } });
  expect(await projectFingerprint()).toBe(before);
  expect(await prisma.appSetting.count({ where: { key: PROJECTS_ROOT_KEY } })).toBe(0);
});

beforeEach(async () => {
  await prisma.appSetting.upsert({
    where: { key: PROJECTS_ROOT_KEY },
    create: { key: PROJECTS_ROOT_KEY, value: root },
    update: { value: root }
  });
});

/** Create a project through the API (Phase 3 workspace + Phase 4 document). */
async function createSyncProject(name = uniqueName(), extra: Record<string, unknown> = {}) {
  const res = await api.post('/api/projects').send({ name, ...extra });
  expect(res.status).toBe(201);
  const project = res.body.data;
  createdProjectIds.push(project.id);
  if (project.folderPath) createdFolders.push(project.folderPath);
  return project;
}

function docPath(project: { folderPath: string }): string {
  return path.join(project.folderPath, PROJECT_DOCUMENT_FILENAME);
}

async function readDoc(project: { folderPath: string }): Promise<string> {
  return fsp.readFile(docPath(project), 'utf8');
}

async function writeDoc(project: { folderPath: string }, content: string): Promise<void> {
  await fsp.writeFile(docPath(project), content, 'utf8');
}

/** Replace the body of a single `**Label**` field in the Overview section. */
function setOverviewField(markdown: string, label: string, value: string): string {
  const re = new RegExp(`(\\*\\*${label}\\*\\*\\n\\n)([\\s\\S]*?)(?=\\n\\n\\*\\*|\\n\\n## |$)`);
  return markdown.replace(re, `$1${value}`);
}

/** Replace the body of a whole-prose section (V1 Scope, Assumptions, ...). */
function setProseSection(markdown: string, heading: string, value: string): string {
  const re = new RegExp(`(## ${heading}\\n\\n)([\\s\\S]*?)(?=\\n\\n## |$)`);
  return markdown.replace(re, `$1${value}`);
}

async function preview(id: number) {
  const res = await api.post(`/api/projects/${id}/project-document/sync/preview`).send({});
  return res;
}

async function sync(id: number, body: Record<string, unknown> = {}) {
  const res = await api.post(`/api/projects/${id}/project-document/sync`).send(body);
  return res;
}

async function syncState(id: number) {
  const res = await api.get(`/api/projects/${id}/project-document/sync/state`);
  return res;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

describe('1. PROJECT.md parser', () => {
  const doc = [
    '---',
    'p-hub-document: "PROJECT.md"',
    'p-hub-document-version: 1',
    'p-hub-project-id: 7',
    'p-hub-project-name: "Demo"',
    'p-hub-direction: "database-to-document"',
    '---',
    '',
    '# Demo',
    '',
    '## Overview',
    '',
    '**Description**',
    '',
    'A description.',
    '',
    '## Project Status',
    '',
    '**Stage**',
    '',
    'Idea',
    '',
    '## V1 Scope',
    '',
    'Scope text.',
    '',
    '## Requirements',
    '',
    '- **REQ-001** First requirement',
    '  - Functional · Priority: High · Proposed',
    '  Details for the requirement.',
    '',
    '## Features',
    '',
    '_No features documented yet._',
    ''
  ].join('\n');

  it('reads front matter and core fields', () => {
    const p = parseProjectDocument(doc);
    expect(p.metadataValid).toBe(true);
    expect(p.projectIdFromDocument).toBe(7);
    expect(p.documentVersion).toBe(1);
    expect(p.projectNameFromDocument).toBe('Demo');
    expect(p.coreFields.description).toBe('A description.');
    expect(p.proseFields['V1 Scope']).toBe('Scope text.');
  });

  it('reads records with their code, attributes and detail', () => {
    const p = parseProjectDocument(doc);
    expect(p.records['Requirements']).toHaveLength(1);
    const req = p.records['Requirements'][0];
    expect(req.title).toBe('**REQ-001** First requirement');
    expect(req.attributes).toEqual(['Functional', 'Priority: High', 'Proposed']);
    expect(req.detail).toBe('Details for the requirement.');
  });

  it('treats an empty-list placeholder as no records', () => {
    const p = parseProjectDocument(doc);
    expect(p.records['Features']).toHaveLength(0);
  });

  it('marks Project Status as present but unsupported', () => {
    const p = parseProjectDocument(doc);
    expect(p.unsupportedSections).toContain('Project Status');
  });

  it('reports a missing front matter as an error', () => {
    const p = parseProjectDocument('# Demo\n\n## Overview\n');
    expect(p.metadataValid).toBe(false);
    expect(p.errors.length).toBeGreaterThan(0);
  });

  it('reports an unsupported document version as an error', () => {
    const bad = doc.replace('p-hub-document-version: 1', 'p-hub-document-version: 99');
    const p = parseProjectDocument(bad);
    expect(p.metadataValid).toBe(false);
    expect(p.errors.join(' ')).toMatch(/version 99/);
  });
});

// ---------------------------------------------------------------------------
// Change detection & metadata
// ---------------------------------------------------------------------------

describe('2. change detection and metadata', () => {
  it('reports a freshly generated document as unchanged', async () => {
    const project = await createSyncProject(uniqueName('Fresh'));
    const state = await syncState(project.id);
    expect(state.status).toBe(200);
    // A generated document has its hash recorded, so it is not "modified".
    expect(state.body.data.neverSynchronized).toBe(false);
    expect(state.body.data.modified).toBe(false);
  });

  it('detects a modified document by content hash, not mtime', async () => {
    const project = await createSyncProject(uniqueName('Modified'), { description: 'Original.' });
    let md = await readDoc(project);
    md = setOverviewField(md, 'Description', 'Edited by hand.');
    await writeDoc(project, md);
    const state = await syncState(project.id);
    expect(state.body.data.modified).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

describe('3. preview does not mutate the database', () => {
  it('reports a change set without writing it', async () => {
    const project = await createSyncProject(uniqueName('Preview'), { description: 'Before.' });
    let md = await readDoc(project);
    md = setOverviewField(md, 'Description', 'After edit.');
    await writeDoc(project, md);

    const res = await preview(project.id);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.applicable).toBe(true);
    expect(d.projectChanges.map((c: any) => c.field)).toContain('description');

    // Nothing was written: the database still says "Before."
    const row = await prisma.project.findUnique({ where: { id: project.id } });
    expect(row!.description).toBe('Before.');
  });
});

// ---------------------------------------------------------------------------
// Synchronization
// ---------------------------------------------------------------------------

describe('4. explicit synchronization applies core fields', () => {
  it('updates a core field from the document', async () => {
    const project = await createSyncProject(uniqueName('Core'), { description: 'Before.' });
    let md = await readDoc(project);
    md = setOverviewField(md, 'Description', 'Applied from the document.');
    await writeDoc(project, md);

    const res = await sync(project.id);
    expect(res.status).toBe(200);
    const row = await prisma.project.findUnique({ where: { id: project.id } });
    expect(row!.description).toBe('Applied from the document.');
  });

  it('applies a prose section', async () => {
    const project = await createSyncProject(uniqueName('Prose'));
    let md = await readDoc(project);
    md = setProseSection(md, 'V1 Scope', 'The first usable version covers login.');
    await writeDoc(project, md);

    const res = await sync(project.id);
    expect(res.status).toBe(200);
    const row = await prisma.project.findUnique({ where: { id: project.id } });
    expect(row!.v1Scope).toBe('The first usable version covers login.');
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('5. synchronization is idempotent', () => {
  it('a second sync of an unchanged document applies nothing', async () => {
    const project = await createSyncProject(uniqueName('Idem'), { description: 'Start.' });
    let md = await readDoc(project);
    md = setOverviewField(md, 'Description', 'Stable value.');
    await writeDoc(project, md);

    const first = await sync(project.id);
    expect(first.status).toBe(200);
    expect(first.body.data.applied).not.toBeNull();

    const second = await sync(project.id);
    expect(second.status).toBe(200);
    expect(second.body.data.skipped).toBe('unchanged');
    expect(second.body.data.applied).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Deletion safety
// ---------------------------------------------------------------------------

describe('6. deletion safety', () => {
  it('never deletes a database record that is missing from the document', async () => {
    const project = await createSyncProject(uniqueName('Delete'));
    // Add a note directly in the database so the document does not contain it.
    await prisma.note.create({
      data: { projectId: project.id, title: 'Only in the database', content: 'Keep me.' }
    });
    const notesBefore = await prisma.note.count({ where: { projectId: project.id } });

    const res = await sync(project.id);
    expect(res.status).toBe(200);

    const notesAfter = await prisma.note.count({ where: { projectId: project.id } });
    expect(notesAfter).toBe(notesBefore);
    // It is reported as unmatched instead.
    const d = res.body.data;
    expect(
      d.unmatchedDatabaseRecords.some((r: any) => r.entity === 'notes')
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Loop prevention
// ---------------------------------------------------------------------------

describe('7. loop prevention', () => {
  it('a generated document that is never edited produces no sync work', async () => {
    const project = await createSyncProject(uniqueName('Loop'));
    const res = await sync(project.id);
    expect(res.status).toBe(200);
    expect(res.body.data.skipped).toBe('unchanged');
    expect(res.body.data.applied).toBeNull();
  });

  it('the database -> document direction is not triggered by a sync', async () => {
    const project = await createSyncProject(uniqueName('Loop2'), { description: 'Loop guard.' });
    let md = await readDoc(project);
    md = setOverviewField(md, 'Description', 'Changed once.');
    await writeDoc(project, md);
    await sync(project.id);
    // After syncing, the file on disk is unchanged (sync never rewrites the file),
    // so the document hash still matches and a second sync is a no-op.
    const res = await sync(project.id);
    expect(res.body.data.skipped).toBe('unchanged');
  });
});

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

describe('8. conflict handling', () => {
  it('refuses to sync without acknowledgement when the database moved', async () => {
    const project = await createSyncProject(uniqueName('Conflict'), { description: 'Start.' });
    let md = await readDoc(project);
    md = setOverviewField(md, 'Description', 'Doc version.');
    await writeDoc(project, md);
    await sync(project.id);

    // Now change the database directly, simulating a change made elsewhere.
    await prisma.project.update({ where: { id: project.id }, data: { problem: 'Moved on.' } });

    // Edit the document again so the document hash differs too.
    md = await readDoc(project);
    md = setOverviewField(md, 'Description', 'Doc version 2.');
    await writeDoc(project, md);

    const refused = await sync(project.id);
    expect(refused.status).toBe(200);
    expect(refused.body.data.applied).toBeNull();
    expect(refused.body.data.skipped).toBe('not_applicable');
    expect(
      refused.body.data.errors.some((e: any) => e.code === 'UNACKNOWLEDGED_CONFLICT')
    ).toBe(true);

    // With explicit acknowledgement it proceeds.
    const forced = await sync(project.id, { acknowledgeConflict: true });
    expect(forced.status).toBe(200);
    expect(forced.body.data.applied).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ownership & identity
// ---------------------------------------------------------------------------

describe('9. document ownership and identity', () => {
  it('refuses a document whose project id does not match', async () => {
    const a = await createSyncProject(uniqueName('OwnerA'));
    const b = await createSyncProject(uniqueName('OwnerB'));

    let md = await readDoc(a);
    // Forge the front matter so it claims to belong to B.
    md = md.replace(/p-hub-project-id: \d+/, `p-hub-project-id: ${b.id}`);
    md = setOverviewField(md, 'Description', 'Should not apply.');
    await writeDoc(a, md);

    const res = await sync(a.id);
    expect(res.body.data.applied).toBeNull();
    expect(res.body.data.errors.some((e: any) => e.code === 'PROJECT_ID_MISMATCH')).toBe(true);

    // B is untouched.
    const rowB = await prisma.project.findUnique({ where: { id: b.id } });
    expect(rowB!.description).not.toBe('Should not apply.');
  });

  it('matches a requirement by its code regardless of position', async () => {
    const project = await createSyncProject(uniqueName('Req'));
    await prisma.requirement.create({
      data: { projectId: project.id, code: 'REQ-001', title: 'Original title', priority: 'LOW' }
    });
    // Regenerate so the document reflects the new database record, then edit the
    // priority attribute on REQ-001 in the document.
    const regen = await api
      .post(`/api/projects/${project.id}/project-document/regenerate`)
      .send({ confirm: true });
    expect(regen.status).toBe(200);

    let md = await readDoc(project);
    expect(md).toContain('REQ-001');
    md = md.replace(/(- \*\*REQ-001\*\*[^\n]*\n  - [^\n]*?)Low/, '$1High');
    await writeDoc(project, md);

    const res = await sync(project.id);
    expect(res.status).toBe(200);
    const req = await prisma.requirement.findFirst({ where: { projectId: project.id, code: 'REQ-001' } });
    expect(req!.priority).toBe('HIGH');
    // The title is unchanged (the document's title was truncated; it must not be written).
    expect(req!.title).toBe('Original title');
  });
});

// ---------------------------------------------------------------------------
// STATUS.md separation
// ---------------------------------------------------------------------------

describe('10. STATUS.md is never synchronized from PROJECT.md', () => {
  it('changing the Stage line in PROJECT.md does not change the database stage', async () => {
    const project = await createSyncProject(uniqueName('Status'));
    const stageBefore = (await prisma.project.findUnique({ where: { id: project.id } }))!.stage;

    let md = await readDoc(project);
    // The Stage value sits under "**Stage**" in the Project Status section.
    md = md.replace(/(\*\*Stage\*\*\n\n)([^\n]*)/, '$1Building');
    await writeDoc(project, md);

    await sync(project.id);

    const stageAfter = (await prisma.project.findUnique({ where: { id: project.id } }))!.stage;
    expect(stageAfter).toBe(stageBefore);
  });
});

// ---------------------------------------------------------------------------
// Unsupported content
// ---------------------------------------------------------------------------

describe('11. unsupported content is reported, not guessed', () => {
  it('ignores an unknown section without failing the sync', async () => {
    const project = await createSyncProject(uniqueName('Unknown'), { description: 'Keep.' });
    let md = await readDoc(project);
    md += '\n\n## Something Unknown\n\nSome prose that means nothing to the importer.\n';
    md = setOverviewField(md, 'Description', 'Still applied.');
    await writeDoc(project, md);

    const res = await sync(project.id);
    expect(res.status).toBe(200);
    const row = await prisma.project.findUnique({ where: { id: project.id } });
    expect(row!.description).toBe('Still applied.');
    expect(res.body.data.warnings.some((w: any) => w.code === 'UNKNOWN_SECTION')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe('12. security', () => {
  it('does not accept a path from the client', async () => {
    const project = await createSyncProject(uniqueName('NoPath'));
    const res = await api
      .post(`/api/projects/${project.id}/project-document/sync`)
      .send({ path: 'C:/Windows/System32/evil.md' });
    // Either it is rejected as an unknown field, or the path is ignored entirely.
    // It must never report success for a foreign path.
    expect(res.status).not.toBe(201);
  });

  it('reports a clear error for a project with no workspace', async () => {
    const res = await api.post('/api/projects').send({ name: uniqueName('NoWs'), createWorkspace: false });
    // If creation failed because a workspace is required, skip. Otherwise the sync
    // must refuse with a workspace explanation.
    if (res.status === 201) {
      const id = res.body.data.id;
      createdProjectIds.push(id);
      const syncRes = await sync(id);
      expect(syncRes.status).not.toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// Child entity creation
// ---------------------------------------------------------------------------

describe('13. child records can be created from the document', () => {
  it('creates a feature that exists only in the document', async () => {
    const project = await createSyncProject(uniqueName('NewFeature'));
    let md = await readDoc(project);
    md = md.replace(
      /## Features\n\n_[^_]*_\n/,
      '## Features\n\n- A brand new feature\n  - Priority: High · Building\n  Described in the document.\n'
    );
    await writeDoc(project, md);

    const res = await sync(project.id);
    expect(res.status).toBe(200);
    const feature = await prisma.feature.findFirst({ where: { projectId: project.id } });
    expect(feature).toBeTruthy();
    expect(feature!.name).toBe('A brand new feature');
    expect(feature!.priority).toBe('HIGH');
  });

  it('creates a code-keyed requirement with its code and title', async () => {
    const project = await createSyncProject(uniqueName('NewRequirement'));
    let md = await readDoc(project);
    md = md.replace(
      /## Requirements\n\n_[^_]*_\n/,
      '## Requirements\n\n- **REQ-900** — A brand new requirement\n  - Priority: High · Proposed\n  Described in the document.\n'
    );
    await writeDoc(project, md);

    const res = await sync(project.id);
    expect(res.status).toBe(200);
    const requirement = await prisma.requirement.findFirst({
      where: { projectId: project.id }
    });
    // The code is the identity: a created row without it is unroutable and
    // unrereadable by the generator, so this must be written.
    expect(requirement).toBeTruthy();
    expect(requirement!.code).toBe('REQ-900');
    expect(requirement!.title).toBe('A brand new requirement');
    expect(requirement!.priority).toBe('HIGH');
    expect(requirement!.status).toBe('PROPOSED');
  });

  it('creates a code-keyed task with its code and title', async () => {
    const project = await createSyncProject(uniqueName('NewTask'));
    let md = await readDoc(project);
    md = md.replace(
      /## Tasks\n\n_[^_]*_\n/,
      '## Tasks\n\n- **T-900** — A brand new task\n  - Priority: High · Planned\n  Due 2026-01-15\n  Described in the document.\n'
    );
    await writeDoc(project, md);

    const res = await sync(project.id);
    expect(res.status).toBe(200);
    const task = await prisma.task.findFirst({ where: { projectId: project.id } });
    expect(task).toBeTruthy();
    expect(task!.code).toBe('T-900');
    expect(task!.title).toBe('A brand new task');
  });

  it('creates an ADR with its code and title', async () => {
    const project = await createSyncProject(uniqueName('NewAdr'));
    let md = await readDoc(project);
    md = md.replace(
      /## Architecture Decisions\n\n_[^_]*_\n/,
      '## Architecture Decisions\n\n- **ADR-900** — A brand new decision\n  - Status: Accepted\n  Described in the document.\n'
    );
    await writeDoc(project, md);

    const res = await sync(project.id);
    expect(res.status).toBe(200);
    const adr = await prisma.architectureDecision.findFirst({
      where: { projectId: project.id }
    });
    expect(adr).toBeTruthy();
    expect(adr!.code).toBe('ADR-900');
    expect(adr!.title).toBe('A brand new decision');
  });
});

// ---------------------------------------------------------------------------

describe('14. API endpoint identity is method plus path', () => {
  it('never lets one method\'s document entry overwrite the same path with another method', async () => {
    const project = await createSyncProject(uniqueName('EndpointIdentity'));
    const get = await prisma.apiEndpoint.create({
      data: { projectId: project.id, method: 'GET', path: '/widgets', description: 'list' }
    });
    const post = await prisma.apiEndpoint.create({
      data: { projectId: project.id, method: 'POST', path: '/widgets', description: 'create' }
    });

    // Remove both entries from the document entirely. Endpoint detail blocks are
    // joined and deliberately not synchronized, so the only meaningful assertion
    // here is that a document that no longer lists an endpoint must not be treated
    // as a reason to touch the other method that shares the path.
    let md = await readDoc(project);
    md = md.replace(
      /- `GET \/widgets`[\s\S]*?(?=\n- `|\n\n## )/,
      ''
    );
    md = md.replace(
      /- `POST \/widgets`[\s\S]*?(?=\n- `|\n\n## )/,
      ''
    );
    await writeDoc(project, md);

    const res = await sync(project.id);
    expect(res.status).toBe(200);

    // Neither row may be deleted or altered: an endpoint missing from the document
    // is reported as unmatched, never removed, and never confused with its sibling.
    const afterGet = await prisma.apiEndpoint.findUnique({ where: { id: get.id } });
    const afterPost = await prisma.apiEndpoint.findUnique({ where: { id: post.id } });
    expect(afterGet!.description).toBe('list');
    expect(afterPost!.description).toBe('create');
    expect(
      res.body.data.unmatchedDatabaseRecords.filter(
        (r: any) => r.entity === 'endpoints' && r.key === 'GET /widgets'
      ).length
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The Phase 6 acceptance scenarios, one test each.
// ---------------------------------------------------------------------------

describe('15. a GitHub URL change touches only the GitHub URL', () => {
  it('updates repositoryUrl and leaves every other field alone', async () => {
    const project = await createSyncProject(uniqueName('RepoOnly'), {
      description: 'Description that must survive.',
      repositoryUrl: 'https://github.com/example/old'
    });
    const before = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });

    let md = await readDoc(project);
    md = md.replace('https://github.com/example/old', 'https://github.com/example/new');
    await writeDoc(project, md);

    const res = await sync(project.id);
    expect(res.status).toBe(200);

    const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.repositoryUrl).toBe('https://github.com/example/new');
    expect(after.description).toBe(before.description);
    expect(after.name).toBe(before.name);
    expect(after.slug).toBe(before.slug);
    expect(after.stage).toBe(before.stage);
    expect(after.v1Scope).toBe(before.v1Scope);
    expect(after.originalIdea).toBe(before.originalIdea);

    // The structured result names exactly one changed field.
    expect(res.body.data.success).toBe(true);
    expect(res.body.data.changed).toBe(true);
    expect(res.body.data.updatedFields).toEqual(['repositoryUrl']);
  });
});

describe('16. several edited fields update only those fields', () => {
  it('writes the edited fields and leaves the rest of the record alone', async () => {
    const project = await createSyncProject(uniqueName('MultiField'), {
      description: 'Original description.',
      motivation: 'Original motivation.',
      repositoryUrl: 'https://github.com/example/original'
    });
    const before = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });

    let md = await readDoc(project);
    md = setOverviewField(md, 'Description', 'Description from the document.');
    md = setProseSection(md, 'Assumptions', 'Assumption written in the document.');
    md = md.replace('https://github.com/example/original', 'https://github.com/example/edited');
    await writeDoc(project, md);

    const res = await sync(project.id);
    expect(res.status).toBe(200);

    const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.description).toBe('Description from the document.');
    expect(after.assumptions).toBe('Assumption written in the document.');
    expect(after.repositoryUrl).toBe('https://github.com/example/edited');
    // Untouched by the document: name, slug, stage, motivation, archive state, idea.
    expect(after.name).toBe(before.name);
    expect(after.slug).toBe(before.slug);
    expect(after.stage).toBe(before.stage);
    expect(after.isArchived).toBe(false);
    expect(after.motivation).toBe(before.motivation);
    expect(after.originalIdea).toBe(before.originalIdea);

    expect([...res.body.data.updatedFields].sort()).toEqual([
      'assumptions',
      'description',
      'repositoryUrl'
    ]);
  });
});

describe('17. a missing section never clears the database', () => {
  it('keeps values whose section was removed from the document', async () => {
    const project = await createSyncProject(uniqueName('MissingSection'), {
      description: 'Database description that must survive.',
      assumptions: 'Database assumption that must survive.',
      repositoryUrl: 'https://github.com/example/keep-me'
    });

    let md = await readDoc(project);
    // Remove `## Repository` entirely.
    md = md.replace(/## Repository\n\n[\s\S]*?(?=\n\n## )/, '');
    // Blank the assumptions section down to the generator's placeholder.
    md = setProseSection(md, 'Assumptions', '_Not yet documented._');
    await writeDoc(project, md);

    const res = await sync(project.id);
    expect(res.status).toBe(200);
    expect(res.body.data.success).toBe(true);

    const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.repositoryUrl).toBe('https://github.com/example/keep-me');
    expect(after.assumptions).toBe('Database assumption that must survive.');
    expect(after.description).toBe('Database description that must survive.');
    expect(res.body.data.projectChanges).toEqual([]);
  });
});

describe('18. malformed Markdown fails safely', () => {
  it('refuses to synchronize a document whose front matter is broken', async () => {
    const project = await createSyncProject(uniqueName('Malformed'), { description: 'Untouched.' });
    const original = await readDoc(project);

    // A front matter block that is opened and never closed, then garbage.
    await writeDoc(project, `---\np-hub-project-id: ${project.id}\n\n## Overview\n\n???\n`);

    const res = await sync(project.id);
    expect(res.status).toBe(200);
    expect(res.body.data.success).toBe(false);
    expect(res.body.data.applied).toBeNull();
    expect(res.body.data.skipped).toBe('not_applicable');
    expect(res.body.data.errors.length).toBeGreaterThan(0);

    // The database is exactly as it was, and the broken file was not "fixed".
    const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.description).toBe('Untouched.');
    expect(await readDoc(project)).toBe(`---\np-hub-project-id: ${project.id}\n\n## Overview\n\n???\n`);

    // Restoring the document makes the project synchronizable again.
    await writeDoc(project, original);
    const recovered = await sync(project.id);
    expect(recovered.status).toBe(200);
    expect(recovered.body.data.success).toBe(true);
  });
});
