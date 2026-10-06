import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { api, prisma } from './helpers';
import { PROJECTS_ROOT_KEY } from '../src/lib/settings';
import { PROJECT_DOCUMENT_FILENAME } from '../src/lib/projectDocument';
import { parseProjectDocument } from '../src/lib/projectDocumentParser';

/**
 * Phase 7: change-aware PROJECT.md synchronization.
 *
 * The same safety envelope as the Phase 4 and Phase 6 suites: a throwaway Projects
 * Root, only `__TEST__` projects created through the real API, everything removed in
 * afterAll, and every pre-existing project row fingerprinted before and after, so
 * "existing projects are untouched" is asserted rather than claimed.
 *
 * Every project here is created through the API, which generates PROJECT.md and -
 * as of this phase - captures the baseline from that generated file. So each test
 * starts where a real user's project starts: the document and the record agree.
 */

const tmpRoots: string[] = [];
const createdProjectIds: number[] = [];
const createdFolders: string[] = [];

let counter = 0;
function uniqueName(prefix = 'P7'): string {
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
        problem: p.problem,
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
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'phub-p7root-'));
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

async function createProject(name = uniqueName(), extra: Record<string, unknown> = {}) {
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

async function status(id: number) {
  const res = await api.get(`/api/projects/${id}/project-document/sync/status`);
  return res;
}

async function resolve(
  id: number,
  resolutions: Record<string, unknown>[]
) {
  const res = await api.post(`/api/projects/${id}/project-document/sync/resolve`).send({ resolutions });
  return res;
}

async function row(id: number) {
  return prisma.project.findUnique({ where: { id } });
}

// ---------------------------------------------------------------------------
// 1-7. Classification: which side moved, and per field
// ---------------------------------------------------------------------------

describe('1. nothing changed', () => {
  it('reports the document as synchronized and applies nothing', async () => {
    const project = await createProject(uniqueName('Same'), { description: 'Start.' });

    const previewed = await preview(project.id);
    expect(previewed.status).toBe(200);
    expect(previewed.body.data.sync.state).toBe('synchronized');
    expect(previewed.body.data.sync.conflicts).toEqual([]);
    expect(previewed.body.data.sync.markdownChanged).toEqual([]);
    expect(previewed.body.data.sync.databaseChanged).toEqual([]);
    expect(previewed.body.data.sync.baseline.available).toBe(true);

    const res = await sync(project.id);
    expect(res.body.data.skipped).toBe('unchanged');
    expect(res.body.data.applied).toBeNull();
  });
});

describe('2. only PROJECT.md changed', () => {
  it('applies the document value and records the new agreement', async () => {
    const project = await createProject(uniqueName('MdOnly'), { description: 'Start.' });

    const md = setOverviewField(await readDoc(project), 'Description', 'Written in the document.');
    await writeDoc(project, md);

    const previewed = await preview(project.id);
    expect(previewed.body.data.sync.state).toBe('markdown_changed');
    expect(previewed.body.data.sync.markdownChanged).toEqual(['description']);
    expect(previewed.body.data.sync.databaseChanged).toEqual([]);
    expect(previewed.body.data.sync.conflicts).toEqual([]);

    const res = await sync(project.id);
    expect(res.body.data.applied).not.toBeNull();
    expect((await row(project.id))!.description).toBe('Written in the document.');

    // The agreement moved with the write, so the same document is now in step.
    const after = await preview(project.id);
    expect(after.body.data.sync.state).toBe('synchronized');
  });
});

describe('3. only the database changed', () => {
  it('keeps the database value, reports it, and writes nothing', async () => {
    const project = await createProject(uniqueName('DbOnly'), { description: 'Start.' });

    await prisma.project.update({ where: { id: project.id }, data: { description: 'Changed in the app.' } });

    const previewed = await preview(project.id);
    expect(previewed.body.data.sync.state).toBe('database_changed');
    expect(previewed.body.data.sync.databaseChanged).toEqual(['description']);
    expect(previewed.body.data.sync.markdownChanged).toEqual([]);
    expect(previewed.body.data.sync.conflicts).toEqual([]);

    const res = await sync(project.id);
    expect(res.body.data.applied).toBeNull();
    expect((await row(project.id))!.description).toBe('Changed in the app.');

    // The file was not rewritten to match: a sync never pushes data the other way.
    const doc = parseProjectDocument(await readDoc(project));
    expect(doc.coreFields.description).toBe('Start.');
  });
});

describe('4. both sides changed to the same value', () => {
  it('is not a conflict and needs no write', async () => {
    const project = await createProject(uniqueName('SameValue'), { description: 'Start.' });

    await prisma.project.update({ where: { id: project.id }, data: { description: 'Agreed.' } });
    const md = setOverviewField(await readDoc(project), 'Description', 'Agreed.');
    await writeDoc(project, md);

    const previewed = await preview(project.id);
    expect(previewed.body.data.sync.state).toBe('both_changed');
    expect(previewed.body.data.sync.conflicts).toEqual([]);
    // Nothing to write: the values already match.
    expect(previewed.body.data.sync.markdownChanged).toEqual([]);

    const res = await sync(project.id);
    expect(res.body.data.applied).toBeNull();
    expect((await row(project.id))!.description).toBe('Agreed.');

    // Both sides moved together, so this is an agreement, not a pending change.
    const after = await preview(project.id);
    expect(after.body.data.sync.state).toBe('synchronized');
  });
});

describe('5. the same field changed differently', () => {
  it('reports the conflict with both values and writes nothing until it is resolved', async () => {
    const project = await createProject(uniqueName('SameField'), { description: 'Start.' });

    await prisma.project.update({ where: { id: project.id }, data: { description: 'Database version.' } });
    const md = setOverviewField(await readDoc(project), 'Description', 'Document version.');
    await writeDoc(project, md);

    const st = await status(project.id);
    expect(st.status).toBe(200);
    expect(st.body.data.sync.state).toBe('conflict');
    expect(st.body.data.sync.conflictFields).toEqual(['description']);
    expect(st.body.data.sync.conflicts[0]).toMatchObject({
      field: 'description',
      scope: 'project',
      baseline: 'Start.',
      databaseValue: 'Database version.',
      markdownValue: 'Document version.'
    });

    // Synchronizing is refused rather than guessing.
    const refused = await sync(project.id);
    expect(refused.body.data.applied).toBeNull();
    expect(refused.body.data.skipped).toBe('not_applicable');
    expect((await row(project.id))!.description).toBe('Database version.');

    // Keep PROJECT.md.
    const kept = await resolve(project.id, [
      { field: 'description', scope: 'project', choice: 'markdown' }
    ]);
    expect(kept.status).toBe(200);
    expect((await row(project.id))!.description).toBe('Document version.');

    const settled = await status(project.id);
    expect(settled.body.data.sync.conflicts).toEqual([]);
    expect(settled.body.data.sync.state).toBe('synchronized');
  });
});

describe('6. different fields changed', () => {
  it('combines both changes safely in one synchronization', async () => {
    const project = await createProject(uniqueName('Split'), {
      description: 'Start.',
      problem: 'Original problem.'
    });

    // The database moves one field, the document another.
    await prisma.project.update({ where: { id: project.id }, data: { description: 'From the app.' } });
    const md = setOverviewField(await readDoc(project), 'Problem', 'From the document.');
    await writeDoc(project, md);

    const previewed = await preview(project.id);
    expect(previewed.body.data.sync.conflicts).toEqual([]);
    expect(previewed.body.data.sync.markdownChanged).toEqual(['problem']);
    expect(previewed.body.data.sync.databaseChanged).toEqual(['description']);
    expect(previewed.body.data.sync.state).toBe('both_changed');

    const res = await sync(project.id);
    expect(res.body.data.applied).not.toBeNull();

    const after = await row(project.id);
    // The document's change landed, and the database's change was left alone.
    expect(after!.problem).toBe('From the document.');
    expect(after!.description).toBe('From the app.');

    const settled = await preview(project.id);
    expect(settled.body.data.sync.conflicts).toEqual([]);
  });
});

describe('7. several fields conflict', () => {
  it('identifies each one separately and resolves them independently', async () => {
    const project = await createProject(uniqueName('Multi'), {
      description: 'Start.',
      problem: 'Original problem.'
    });

    await prisma.project.update({
      where: { id: project.id },
      data: { description: 'Database description.', problem: 'Database problem.' }
    });
    let md = await readDoc(project);
    md = setOverviewField(md, 'Description', 'Document description.');
    md = setOverviewField(md, 'Problem', 'Document problem.');
    await writeDoc(project, md);

    const st = await status(project.id);
    expect([...st.body.data.sync.conflictFields].sort()).toEqual(['description', 'problem']);
    expect(st.body.data.sync.conflicts).toHaveLength(2);

    // Resolve one; the other stays in conflict and is reported again.
    const partial = await resolve(project.id, [
      { field: 'problem', scope: 'project', choice: 'database' }
    ]);
    expect(partial.status).toBe(200);
    expect((await row(project.id))!.problem).toBe('Database problem.');

    const midway = await status(project.id);
    expect(midway.body.data.sync.conflictFields).toEqual(['description']);
    expect(midway.body.data.sync.state).toBe('conflict');

    // Resolve the second one with a value neither side has.
    const manual = await resolve(project.id, [
      { field: 'description', scope: 'project', choice: 'manual', value: 'Merged by hand.' }
    ]);
    expect(manual.status).toBe(200);
    expect((await row(project.id))!.description).toBe('Merged by hand.');

    const settled = await status(project.id);
    expect(settled.body.data.sync.conflicts).toEqual([]);
    // Nothing is in conflict any more. What remains is honest and specific: the
    // document still holds the `problem` text that lost, and it still holds the
    // `description` text that the manual value replaced. The record holds the values
    // that were chosen. Regenerating is how the file is brought back in line.
    expect(settled.body.data.sync.databaseChanged).toEqual(['problem']);
    expect(settled.body.data.sync.markdownChanged).toEqual(['description']);
    expect(settled.body.data.sync.state).toBe('both_changed');
  });
});

// ---------------------------------------------------------------------------
// 8-12. Generated documents, AI edits, existing projects, failures, races
// ---------------------------------------------------------------------------

describe('8. Project Hub generated the document', () => {
  it('captures the baseline so a generated file is not reported as a change', async () => {
    const project = await createProject(uniqueName('Generated'), { description: 'Start.' });

    // Creating the project generated PROJECT.md, so the agreement already exists.
    const created = await status(project.id);
    expect(created.body.data.sync.baseline.available).toBe(true);
    expect(created.body.data.sync.state).toBe('synchronized');
    expect(created.body.data.sync.conflicts).toEqual([]);

    // Move the database, then regenerate: the document catches up and agrees again,
    // rather than every regenerated line showing up as a conflict.
    await prisma.project.update({ where: { id: project.id }, data: { description: 'Moved in the app.' } });
    const regenerated = await api
      .post(`/api/projects/${project.id}/project-document/regenerate`)
      .send({ confirm: true });
    expect(regenerated.status).toBe(200);

    const afterRegen = await status(project.id);
    expect(afterRegen.body.data.sync.state).toBe('synchronized');
    expect(afterRegen.body.data.sync.conflicts).toEqual([]);
    expect(afterRegen.body.data.sync.baseline.available).toBe(true);

    // The first real edit is then recognised as the user's change.
    const md = setOverviewField(await readDoc(project), 'Description', 'A human edit.');
    await writeDoc(project, md);
    const edited = await preview(project.id);
    expect(edited.body.data.sync.markdownChanged).toEqual(['description']);
    expect(edited.body.data.sync.conflicts).toEqual([]);
  });
});

describe('9. an AI rewrote the document', () => {
  it('reports the values that actually changed, not the rewriting', async () => {
    const project = await createProject(uniqueName('AiEdit'), {
      description: 'Start.',
      problem: 'Original problem.'
    });

    // An AI-style pass: collapsed blank lines, a provenance comment below the front
    // matter, a rewritten value, and a heading whose contents express no field.
    let md = await readDoc(project);
    md = md.replace(/\n{3,}/g, '\n\n');
    md = md.replace(/^---\n/, '---\n');
    md = md.replace(/(p-hub-project-id: \d+\n)/, `$1\n<!-- rewritten by an assistant -->\n`);
    md = setOverviewField(md, 'Description', 'Rewritten by the assistant.');
    md = setProseSection(md, 'Inspiration', 'Notes added by the assistant.');
    await writeDoc(project, md);

    const previewed = await preview(project.id);
    expect(previewed.body.data.applicable).toBe(true);
    // The reformatting is invisible; only the values that changed are reported.
    expect([...previewed.body.data.sync.markdownChanged].sort()).toEqual([
      'description',
      'inspiration'
    ]);
    expect(previewed.body.data.sync.conflicts).toEqual([]);

    const res = await sync(project.id);
    expect(res.body.data.applied).not.toBeNull();
    const after = await row(project.id);
    expect(after!.description).toBe('Rewritten by the assistant.');
    expect(after!.inspiration).toBe('Notes added by the assistant.');

    const settled = await preview(project.id);
    expect(settled.body.data.sync.state).toBe('synchronized');
  });
});

describe('10. a project that predates this phase', () => {
  it('reports the missing baseline and refuses to guess', async () => {
    const project = await createProject(uniqueName('Legacy'), { description: 'Start.' });

    // Exactly the state of every project that existed before the baseline column:
    // a document on disk, a synchronized hash, and no record of the agreement.
    await prisma.project.update({
      where: { id: project.id },
      data: { projectDocumentBaseline: null, projectDocumentConflictFields: [] }
    });

    const st = await status(project.id);
    expect(st.body.data.sync.baseline.available).toBe(false);

    // The file and the record still agree, so there is nothing to do and no conflict.
    expect(st.body.data.sync.state).toBe('synchronized');
    expect(st.body.data.sync.conflicts).toEqual([]);

    // Now make them disagree with no baseline to arbitrate: that is a conflict, not
    // a licence to overwrite one side with the other.
    await prisma.project.update({ where: { id: project.id }, data: { description: 'Moved in the app.' } });
    const md = setOverviewField(await readDoc(project), 'Description', 'Edited in the document.');
    await writeDoc(project, md);

    const blind = await preview(project.id);
    expect(blind.body.data.sync.state).toBe('conflict');
    expect(blind.body.data.sync.conflictFields).toEqual(['description']);

    const refused = await sync(project.id);
    expect(refused.body.data.applied).toBeNull();
    expect((await row(project.id))!.description).toBe('Moved in the app.');

    // Deciding it - or acknowledging it - establishes the baseline for next time.
    const decided = await sync(project.id, { acknowledgeConflict: true });
    expect(decided.body.data.applied).not.toBeNull();
    const established = await status(project.id);
    expect(established.body.data.sync.baseline.available).toBe(true);
    expect(established.body.data.sync.state).toBe('synchronized');
  });
});

describe('11. a synchronization that cannot be completed', () => {
  it('writes nothing at all, rather than part of the document', async () => {
    const project = await createProject(uniqueName('Broken'), { description: 'Start.' });

    // One valid change and one document that lists the same record key twice: the
    // whole set is refused, so the valid change must not land on its own.
    let md = await readDoc(project);
    md = setOverviewField(md, 'Description', 'This change must not land.');
    md = md.replace(
      /## Requirements\n\n[\s\S]*?(?=\n\n## )/,
      [
        '## Requirements',
        '',
        '- **REQ-001** First requirement',
        '  - Priority: High',
        '',
        '- **REQ-001** The same key again',
        '  - Priority: Low'
      ].join('\n')
    );
    await writeDoc(project, md);

    const previewed = await preview(project.id);
    expect(previewed.body.data.applicable).toBe(false);
    expect(
      previewed.body.data.errors.some((e: any) => e.code === 'DUPLICATE_DOCUMENT_IDENTITY')
    ).toBe(true);

    const res = await sync(project.id);
    expect(res.body.data.applied).toBeNull();
    expect((await row(project.id))!.description).toBe('Start.');
    expect(await prisma.requirement.count({ where: { projectId: project.id } })).toBe(0);

    // Resolving a conflict is refused for the same reason: an unparseable document
    // cannot be arbitrated field by field, because the fields are not trustworthy.
    const conflictProject = await createProject(uniqueName('BrokenConflict'), {
      description: 'Start.'
    });
    await prisma.project.update({
      where: { id: conflictProject.id },
      data: { description: 'Database version.' }
    });
    const conflictMd = setOverviewField(
      await readDoc(conflictProject),
      'Description',
      'Document version.'
    );
    await writeDoc(
      conflictProject,
      conflictMd.replace(
        /## Requirements\n\n[\s\S]*?(?=\n\n## )/,
        ['## Requirements', '', '- **REQ-001** A', '', '- **REQ-001** B'].join('\n')
      )
    );

    const refused = await resolve(conflictProject.id, [
      { field: 'description', scope: 'project', choice: 'markdown' }
    ]);
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.code).toBe('CHANGE_SET_HAS_ERRORS');
    expect((await row(conflictProject.id))!.description).toBe('Database version.');
  });
});

describe('12. rapid consecutive modification', () => {
  it('ends on the newest version with no partial state', async () => {
    const project = await createProject(uniqueName('Rapid'), { description: 'Start.' });

    // Three saves in quick succession, the way an editor or an assistant writes.
    for (const value of ['First.', 'Second.', 'Third and final.']) {
      const md = setOverviewField(await readDoc(project), 'Description', value);
      await writeDoc(project, md);
    }

    const res = await sync(project.id);
    expect(res.body.data.applied).not.toBeNull();
    expect((await row(project.id))!.description).toBe('Third and final.');

    // Two synchronizations racing each other: the per-project lock serializes them,
    // so the second sees the first's result rather than a stale read.
    const md = setOverviewField(await readDoc(project), 'Description', 'Fourth.');
    await writeDoc(project, md);
    const racing = await Promise.all([sync(project.id), sync(project.id)]);
    for (const r of racing) expect(r.status).toBe(200);
    expect((await row(project.id))!.description).toBe('Fourth.');

    // Whatever the interleaving, the record ends up matching the file exactly and a
    // further synchronization has nothing to do.
    const settled = await preview(project.id);
    expect(settled.body.data.sync.conflicts).toEqual([]);
    expect(settled.body.data.sync.state).toBe('synchronized');
    const final = await sync(project.id);
    expect(final.body.data.applied).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Resolution choices and history
// ---------------------------------------------------------------------------

describe('13. conflict resolution', () => {
  it('keeps the database, the document, or a value of the user\'s choosing', async () => {
    const project = await createProject(uniqueName('Resolve'), { description: 'Start.' });
    await prisma.project.update({ where: { id: project.id }, data: { description: 'Database version.' } });
    await writeDoc(
      project,
      setOverviewField(await readDoc(project), 'Description', 'Document version.')
    );

    // Keep the database: nothing is written, and the document is left as the user
    // wrote it. The record keeps its value, so what remains is a document that is
    // behind the database - reported, not silently resolved.
    const kept = await resolve(project.id, [
      { field: 'description', scope: 'project', choice: 'database' }
    ]);
    expect(kept.status).toBe(200);
    expect(kept.body.data.updatedFields).toEqual([]);
    expect((await row(project.id))!.description).toBe('Database version.');
    const behind = await status(project.id);
    expect(behind.body.data.sync.conflicts).toEqual([]);
    expect(behind.body.data.sync.databaseChanged).toEqual(['description']);

    // Regenerating is the explicit way to bring the document back in line.
    const regenerated = await api
      .post(`/api/projects/${project.id}/project-document/regenerate`)
      .send({ confirm: true });
    expect(regenerated.status).toBe(200);
    const caughtUp = await status(project.id);
    expect(caughtUp.body.data.sync.state).toBe('synchronized');
    expect(parseProjectDocument(await readDoc(project)).coreFields.description).toBe(
      'Database version.'
    );

    // Break it again and keep the document.
    await prisma.project.update({ where: { id: project.id }, data: { description: 'Second database.' } });
    await writeDoc(
      project,
      setOverviewField(await readDoc(project), 'Description', 'Document version.')
    );
    const again = await resolve(project.id, [
      { field: 'description', scope: 'project', choice: 'markdown' }
    ]);
    expect(again.status).toBe(200);
    expect((await row(project.id))!.description).toBe('Document version.');
    expect((await status(project.id)).body.data.sync.state).toBe('synchronized');
  });

  it('refuses a resolution for a field that is not in conflict', async () => {
    const project = await createProject(uniqueName('StaleResolve'), { description: 'Start.' });

    const res = await resolve(project.id, [
      { field: 'description', scope: 'project', choice: 'markdown' }
    ]);
    expect(res.status).toBe(409);
    expect(res.body.error.details.code).toBe('NOT_A_CURRENT_CONFLICT');
    expect((await row(project.id))!.description).toBe('Start.');
  });

  it('requires a value when the choice is manual', async () => {
    const project = await createProject(uniqueName('NoValue'), { description: 'Start.' });
    await prisma.project.update({ where: { id: project.id }, data: { description: 'Database version.' } });
    await writeDoc(
      project,
      setOverviewField(await readDoc(project), 'Description', 'Document version.')
    );

    const res = await resolve(project.id, [
      { field: 'description', scope: 'project', choice: 'manual' }
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error.details.code).toBe('MANUAL_VALUE_REQUIRED');
    expect((await row(project.id))!.description).toBe('Database version.');
  });
});

describe('14. synchronization history', () => {
  it('records each run with its direction and decisions', async () => {
    const project = await createProject(uniqueName('History'), { description: 'Start.' });

    const md = setOverviewField(await readDoc(project), 'Description', 'A change.');
    await writeDoc(project, md);
    await sync(project.id);

    await prisma.project.update({ where: { id: project.id }, data: { description: 'Moved in the app.' } });
    await writeDoc(
      project,
      setOverviewField(await readDoc(project), 'Description', 'The document wins.')
    );
    await resolve(project.id, [{ field: 'description', scope: 'project', choice: 'markdown' }]);

    const st = await status(project.id);
    expect(st.body.data.history.length).toBeGreaterThanOrEqual(2);
    const latest = st.body.data.history[0];
    expect(latest.direction).toBe('CONFLICT_RESOLUTION');
    expect(latest.resolutions).toEqual([{ target: 'description', choice: 'markdown' }]);
    expect(latest.applied).toContain('description');

    const first = st.body.data.history[st.body.data.history.length - 1];
    expect(first.direction).toBe('MARKDOWN_TO_DATABASE');

    // And it is on the project timeline, where the rest of the activity is.
    const events = await prisma.activityEvent.findMany({
      where: { projectId: project.id, relatedType: 'ProjectDocumentSync' },
      orderBy: { createdAt: 'asc' }
    });
    expect(events.length).toBeGreaterThanOrEqual(2);
  });
});
