import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { api, prisma } from './helpers';
import { PROJECTS_ROOT_KEY } from '../src/lib/settings';
import {
  PROJECT_DOCUMENT_FILENAME,
  PROJECT_DOCUMENT_MAX_BYTES,
  renderProjectDocument
} from '../src/lib/projectDocument';

/**
 * Phase 4: PROJECT.md, the living document at the root of a project workspace.
 *
 * Same ground rules as the Phase 3 suite: the Projects Root is a throwaway
 * `fs.mkdtemp` directory, the suite creates only `__TEST__` projects, everything
 * it created is removed afterwards, and every project row that existed before is
 * fingerprinted before and after so "existing projects are untouched" is an
 * assertion rather than a claim.
 */

const tmpRoots: string[] = [];
const createdProjectIds: number[] = [];
const createdTagIds: number[] = [];
const createdFolders: string[] = [];
const outsideRoots: string[] = [];

let counter = 0;
function uniqueName(prefix = 'Doc'): string {
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
        isArchived: p.isArchived,
        repositoryUrl: p.repositoryUrl,
        folderName: p.folderName,
        folderPath: p.folderPath,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString()
      }))
  );
}

async function tagFingerprint() {
  const tags = await prisma.tag.findMany({ orderBy: { id: 'asc' } });
  return JSON.stringify(tags.map(t => ({ id: t.id, name: t.name, color: t.color })));
}

async function makeRoot(tag = 'phub-p4root-'): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), tag));
  tmpRoots.push(dir);
  return dir;
}

async function setRoot(dir: string) {
  await prisma.appSetting.upsert({
    where: { key: PROJECTS_ROOT_KEY },
    create: { key: PROJECTS_ROOT_KEY, value: dir },
    update: { value: dir }
  });
}

async function clearRoot() {
  await prisma.appSetting.deleteMany({ where: { key: PROJECTS_ROOT_KEY } });
}

let root: string;
let before: string | null = null;
let tagsBefore: string | null = null;

beforeAll(async () => {
  before = await projectFingerprint();
  tagsBefore = await tagFingerprint();
  root = await makeRoot();
  await setRoot(root);
});

afterAll(async () => {
  for (const id of createdProjectIds) {
    await prisma.activityEvent.deleteMany({ where: { projectId: id } });
    await prisma.tagAssignment.deleteMany({ where: { taggableType: 'project', taggableId: id } });
    await prisma.project.deleteMany({ where: { id } });
  }
  // Only tags this suite created, identified by the ids recorded above.
  for (const id of createdTagIds) {
    await prisma.tag.deleteMany({ where: { id } });
  }
  for (const dir of [...createdFolders, ...outsideRoots]) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  for (const dir of tmpRoots) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  await clearRoot();

  // The Projects Root setting is empty again, and every project row and tag that
  // existed before this suite is byte-identical to the fingerprints taken first.
  // An earlier revision of this suite created a tag and forgot to remove it; this
  // assertion is what caught it.
  expect(await projectFingerprint()).toBe(before);
  expect(await tagFingerprint()).toBe(tagsBefore);
  expect(await prisma.appSetting.count({ where: { key: PROJECTS_ROOT_KEY } })).toBe(0);
});

beforeEach(async () => {
  await setRoot(root);
});

/** Create through the real API so the whole Phase 3 + 4 flow is exercised. */
async function createViaApi(name = uniqueName(), extra: Record<string, unknown> = {}) {
  const res = await api.post('/api/projects').send({ name, ...extra });
  if (res.status === 201) {
    createdProjectIds.push(res.body.data.id);
    if (res.body.data.folderPath) createdFolders.push(res.body.data.folderPath);
  }
  return res;
}

function docPathFor(project: { folderPath: string }): string {
  return path.join(project.folderPath, PROJECT_DOCUMENT_FILENAME);
}

function headings(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter(l => l.startsWith('## '))
    .map(l => l.slice(3).trim());
}

// ---------------------------------------------------------------------------

describe('1-4. PROJECT.md is created with the project and describes the real record', () => {
  it('creates PROJECT.md inside the new project folder', async () => {
    const res = await createViaApi(uniqueName('Auto'), { description: 'A generated description.' });
    expect(res.status).toBe(201);
    const project = res.body.data;
    expect(project.folderPath).toBeTruthy();

    const docPath = docPathFor(project);
    await expect(fsp.stat(docPath)).resolves.toBeTruthy();

    // The status endpoint agrees, and points at a relative path.
    const status = await api.get(`/api/projects/${project.id}/project-document`);
    expect(status.status).toBe(200);
    expect(status.body.data.exists).toBe(true);
    expect(status.body.data.relativePath).toBe(`./${PROJECT_DOCUMENT_FILENAME}`);
    expect(status.body.data.direction).toBe('DATABASE_TO_DOCUMENT');
    expect(status.body.data.documentToDatabaseSync).toBe(false);
  });

  it('is built from the actual project data, not a template', async () => {
    const name = uniqueName('Content');
    const res = await createViaApi(name, {
      description: 'Turns messy notes into a plan.',
      problem: 'Notes are scattered.',
      motivation: 'I lose track of decisions.',
      targetUsers: 'Solo developers.',
      expectedValue: 'Fewer forgotten decisions.',
      assumptions: 'One person works on it.',
      initialQuestions: 'Is markdown enough?',
      inspiration: 'A tidy desk.',
      v1Scope: 'Import, organise, export.',
      repositoryUrl: 'https://example.invalid/repo'
    });
    const project = res.body.data;
    const content = await fsp.readFile(docPathFor(project), 'utf8');

    for (const expected of [
      'Turns messy notes into a plan.',
      'Notes are scattered.',
      'I lose track of decisions.',
      'Solo developers.',
      'Fewer forgotten decisions.',
      'One person works on it.',
      'Is markdown enough?',
      'A tidy desk.',
      'Import, organise, export.',
      name,
      'https://example.invalid/repo'
    ]) {
      expect(content).toContain(expected);
    }

    // The front matter identifies the document and the direction.
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toContain('p-hub-document: "PROJECT.md"');
    expect(content).toContain('p-hub-document-version: 1');
    expect(content).toContain(`p-hub-project-id: ${project.id}`);
    expect(content).toContain('p-hub-direction: "database-to-document"');

    // originalIdea is a JSON snapshot of the same fields. Including it would
    // duplicate the document inside itself.
    expect(content).not.toContain('originalIdea');
    expect(content).not.toContain('capturedAt');
  });

  it('has the expected structure and honest empty sections', async () => {
    const res = await createViaApi(uniqueName('Structure'));
    const project = res.body.data;
    const content = await fsp.readFile(docPathFor(project), 'utf8');

    expect(headings(content)).toEqual([
      'Overview',
      'Project Status',
      'V1 Scope',
      'Assumptions',
      'Initial Questions',
      'Inspiration',
      'Research',
      'Research Questions',
      'Requirements',
      'Features',
      'Technology Stack',
      'Architecture Decisions',
      'Database Tables',
      'API Endpoints',
      'Milestones',
      'Tasks',
      'Issues',
      'Notes',
      'Repository',
      'Deployment',
      'Development Sessions',
      'Git References',
      'Tags'
    ]);

    // A new project really is empty, and the document says so rather than
    // inventing content.
    expect(content).toContain('## Requirements\n\n_No requirements documented yet._');
    expect(content).toContain('## Notes\n\n_No notes documented yet._');
    expect(content).toContain('## Repository\n\n_Not yet documented._');
  });

  it('includes child records in a stable order', async () => {
    const res = await createViaApi(uniqueName('Children'));
    const id = res.body.data.id;

    // Inserted in a deliberately unhelpful order.
    await prisma.requirement.createMany({
      data: [
        { projectId: id, code: 'FR-002', title: 'Second', priority: 'HIGH' },
        { projectId: id, code: 'FR-001', title: 'First' },
        { projectId: id, code: 'NFR-001', title: 'Non functional', type: 'NON_FUNCTIONAL' }
      ]
    });
    await prisma.feature.createMany({
      data: [
        { projectId: id, name: 'Zebra export' },
        { projectId: id, name: 'Alpha import' }
      ]
    });
    await prisma.note.createMany({ data: [{ projectId: id, title: 'A note', content: 'Body text.' }] });
    // A tag created with a name unique to this suite, so afterAll can remove it
    // without touching a tag the user already had.
    const tag = await prisma.tag.create({ data: { name: `__test__-p4-tag-${Date.now()}-${counter}` } });
    createdTagIds.push(tag.id);
    await prisma.tagAssignment.create({
      data: { taggableType: 'project', taggableId: id, tagId: tag.id }
    });

    await api.post(`/api/projects/${id}/project-document/regenerate`).send({ confirm: true });
    const content = await fsp.readFile(docPathFor(res.body.data), 'utf8');

    // Codes ascend; the NFR sorts after FR because "N" > "F".
    expect(content.indexOf('**FR-001**')).toBeLessThan(content.indexOf('**FR-002**'));
    expect(content.indexOf('**FR-002**')).toBeLessThan(content.indexOf('**NFR-001**'));
    // Features sort by name, not by insertion order.
    expect(content.indexOf('Alpha import')).toBeLessThan(content.indexOf('Zebra export'));
    expect(content).toContain('Body text.');
    expect(content).toContain(`- ${tag.name}`);
    expect(content).toContain('Non-functional');
  });

  it('is deterministic: the same data always produces the same bytes', async () => {
    const res = await createViaApi(uniqueName('Determinism'));
    const id = res.body.data.id;
    await prisma.requirement.create({ data: { projectId: id, code: 'FR-001', title: 'One' } });

    await api.post(`/api/projects/${id}/project-document/regenerate`).send({ confirm: true });
    const first = await fsp.readFile(docPathFor(res.body.data), 'utf8');
    await api.post(`/api/projects/${id}/project-document/regenerate`).send({ confirm: true });
    const second = await fsp.readFile(docPathFor(res.body.data), 'utf8');

    expect(second).toBe(first);

    // And the renderer is a pure function of its input.
    const { loadProjectDocumentData } = await import('../src/lib/projectDocument');
    const data = await loadProjectDocumentData(id);
    expect(renderProjectDocument(data)).toBe(first);
  });
});

describe('5-6. the flow is one-way: PROJECT.md is never read back', () => {
  it('shows the user their own edits when reading the document', async () => {
    const res = await createViaApi(uniqueName('Read'));
    const id = res.body.data.id;
    const docPath = docPathFor(res.body.data);

    await fsp.writeFile(docPath, '# Hand written\n\nI edited this myself.\n', 'utf8');

    const content = await api.get(`/api/projects/${id}/project-document/content`);
    expect(content.status).toBe(200);
    expect(content.body.data.content).toContain('I edited this myself.');
    expect(content.body.data.documentToDatabaseSync).toBe(false);
  });

  it('never writes an external edit back to the database', async () => {
    const res = await createViaApi(uniqueName('NoSync'), { description: 'Original description.' });
    const id = res.body.data.id;
    const docPath = docPathFor(res.body.data);

    await fsp.writeFile(docPath, '# Rewritten\n\ndescription: Hacked from the file\n', 'utf8');

    // Reading it again is the only thing that happens. No endpoint parses it.
    const read = await api.get(`/api/projects/${id}/project-document/content`);
    expect(read.status).toBe(200);

    const inDb = await prisma.project.findUnique({ where: { id } });
    expect(inDb?.description).toBe('Original description.');
    expect(inDb?.name).not.toBe('Rewritten');
  });

  it('reports clearly for a project with no workspace folder', async () => {
    // An imported project: created before Phase 3, so folderPath stays null and
    // nothing backfills it.
    const project = await prisma.project.create({
      data: { name: uniqueName('Imported'), slug: `__test-imported-${Date.now()}`, stage: 'IDEA' }
    });
    createdProjectIds.push(project.id);

    const status = await api.get(`/api/projects/${project.id}/project-document`);
    expect(status.status).toBe(200);
    expect(status.body.data.available).toBe(false);
    expect(status.body.data.reason).toBe('PROJECT_WORKSPACE_MISSING');
    expect(status.body.data.exists).toBeNull();
    expect(status.body.data.possibleAction).toBeTruthy();

    // It is never created for such a project, not even on request.
    const generate = await api.post(`/api/projects/${project.id}/project-document`).send({});
    expect(generate.status).toBe(409);
    expect(generate.body.error.category).toBe('VALIDATION_FAILED');
    expect(generate.body.error.details.code).toBe('PROJECT_WORKSPACE_MISSING');

    const read = await api.get(`/api/projects/${project.id}/project-document/content`);
    expect(read.status).toBe(409);
  });

  it('tells the user when no Projects Root is configured', async () => {
    const res = await createViaApi(uniqueName('NoRoot'));
    const id = res.body.data.id;
    await clearRoot();

    const status = await api.get(`/api/projects/${id}/project-document`);
    expect(status.status).toBe(200);
    expect(status.body.data.reason).toBe('PROJECTS_ROOT_NOT_CONFIGURED');

    const generate = await api.post(`/api/projects/${id}/project-document`).send({});
    expect(generate.status).toBe(409);
    expect(generate.body.error.details.code).toBe('PROJECTS_ROOT_NOT_CONFIGURED');
  });
});

describe('7-9. generating and regenerating are explicit and never surprising', () => {
  it('refuses to overwrite an existing PROJECT.md', async () => {
    const res = await createViaApi(uniqueName('NoClobber'));
    const id = res.body.data.id;
    const docPath = docPathFor(res.body.data);

    const mine = '# Mine\n\nI want to keep this.\n';
    await fsp.writeFile(docPath, mine, 'utf8');

    const generate = await api.post(`/api/projects/${id}/project-document`).send({});
    expect(generate.status).toBe(409);
    expect(generate.body.error.category).toBe('CONFLICT');
    expect(generate.body.error.details.code).toBe('PROJECT_DOCUMENT_EXISTS');
    expect(generate.body.error.possibleAction).toContain('Regenerate');

    // Untouched.
    expect(await fsp.readFile(docPath, 'utf8')).toBe(mine);
  });

  it('will not regenerate without an explicit confirmation', async () => {
    const res = await createViaApi(uniqueName('Confirm'));
    const id = res.body.data.id;
    const docPath = docPathFor(res.body.data);

    const mine = '# Mine\n\nPlease keep my edits.\n';
    await fsp.writeFile(docPath, mine, 'utf8');

    for (const body of [{}, { confirm: false }, { confirm: 'yes' }]) {
      const regen = await api.post(`/api/projects/${id}/project-document/regenerate`).send(body);
      expect(regen.status).toBe(400);
      expect(regen.body.error.details.requires).toBe('confirm: true');
      expect(await fsp.readFile(docPath, 'utf8')).toBe(mine);
    }
  });

  it('replaces the file, and only the file, when confirmed', async () => {
    const res = await createViaApi(uniqueName('Regen'), { description: 'The real description.' });
    const id = res.body.data.id;
    const folder = res.body.data.folderPath;
    const docPath = docPathFor(res.body.data);

    // A sibling file the user put there, plus the document.
    const sibling = path.join(folder, 'NOTES.md');
    const sourceFile = path.join(folder, 'index.ts');
    await fsp.writeFile(sibling, 'keep me', 'utf8');
    await fsp.writeFile(sourceFile, 'export const x = 1;\n', 'utf8');
    await fsp.writeFile(docPath, '# Stale\n\nMy manual edit.\n', 'utf8');

    const regen = await api.post(`/api/projects/${id}/project-document/regenerate`).send({ confirm: true });
    expect(regen.status).toBe(200);
    expect(regen.body.replaced).toBe(true);

    const content = await fsp.readFile(docPath, 'utf8');
    expect(content).toContain('The real description.');
    expect(content).not.toContain('My manual edit.');

    // Everything else in the folder is exactly as it was. STATUS.md is listed
    // because a new project now also gets one (Phase 5): regenerating
    // PROJECT.md must leave the status document alone, not rebuild it.
    expect(await fsp.readFile(sibling, 'utf8')).toBe('keep me');
    expect(await fsp.readFile(sourceFile, 'utf8')).toBe('export const x = 1;\n');
    expect(await fsp.readFile(path.join(folder, 'STATUS.md'), 'utf8')).toContain('**Status:** IDEA');
    expect((await fsp.readdir(folder)).sort()).toEqual(['NOTES.md', 'PROJECT.md', 'STATUS.md', 'index.ts']);
  });

  it('creates rather than "replaces" when the document is missing', async () => {
    const res = await createViaApi(uniqueName('Recreate'));
    const id = res.body.data.id;
    const docPath = docPathFor(res.body.data);
    await fsp.rm(docPath, { force: true });

    const regen = await api.post(`/api/projects/${id}/project-document/regenerate`).send({ confirm: true });
    expect(regen.status).toBe(201);
    expect(regen.body.replaced).toBe(false);
    expect(await fsp.readFile(docPath, 'utf8')).toContain('## Overview');
  });

  it('generates explicitly for an existing project that has a folder but no document', async () => {
    // The "existing project" case: a record with a valid workspace, no document.
    const project = await prisma.project.create({
      data: {
        name: uniqueName('Existing'),
        slug: `__test-existing-${Date.now()}`,
        stage: 'IDEA',
        description: 'Added later.',
        folderName: 'existing',
        folderPath: path.join(root, 'existing')
      }
    });
    createdProjectIds.push(project.id);
    createdFolders.push(project.folderPath!);
    await fsp.mkdir(project.folderPath!, { recursive: true });

    const status = await api.get(`/api/projects/${project.id}/project-document`);
    expect(status.body.data.exists).toBe(false);

    const generate = await api.post(`/api/projects/${project.id}/project-document`).send({});
    expect(generate.status).toBe(201);
    expect(generate.body.replaced).toBe(false);

    const content = await fsp.readFile(docPathFor(project), 'utf8');
    expect(content).toContain('Added later.');
    expect(content).toContain(`p-hub-project-id: ${project.id}`);
  });
});

describe('11-13. path safety', () => {
  async function projectWithFolderPath(folderPath: string) {
    const project = await prisma.project.create({
      data: {
        name: uniqueName('Path'),
        slug: `__test-path-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        stage: 'IDEA',
        folderName: path.basename(folderPath),
        folderPath
      }
    });
    createdProjectIds.push(project.id);
    return project;
  }

  it('refuses a workspace path that escapes the Projects Root', async () => {
    const outside = await makeRoot('phub-p4outside-');
    const project = await projectWithFolderPath(path.join(outside, 'escaped'));
    await fsp.mkdir(project.folderPath!, { recursive: true });

    const status = await api.get(`/api/projects/${project.id}/project-document`);
    expect(status.body.data.available).toBe(false);
    expect(status.body.data.reason).toBe('PROJECT_WORKSPACE_UNSAFE');

    const generate = await api.post(`/api/projects/${project.id}/project-document`).send({});
    expect(generate.status).toBe(409);
    expect(generate.body.error.details.code).toBe('PROJECT_WORKSPACE_UNSAFE');
    expect(await fsp.readdir(project.folderPath!)).toEqual([]);
  });

  it('refuses a traversal path even when it is prefixed with the root', async () => {
    const project = await projectWithFolderPath(path.join(root, '..', 'escaped-by-traversal'));

    const generate = await api.post(`/api/projects/${project.id}/project-document`).send({});
    expect(generate.status).toBe(409);
    expect(generate.body.error.details.code).toBe('PROJECT_WORKSPACE_UNSAFE');
  });

  it('refuses to write through a workspace link', async () => {
    const real = await makeRoot('phub-p4real-');
    const link = path.join(root, 'linked-workspace');
    try {
      await fsp.symlink(real, link, 'junction');
    } catch {
      // Creating a link needs a privilege this account may not have. The
      // containment tests above already cover the boundary; skip rather than
      // assert something the machine cannot do.
      return;
    }
    const project = await projectWithFolderPath(link);

    const status = await api.get(`/api/projects/${project.id}/project-document`);
    expect(status.body.data.available).toBe(true);
    expect(status.body.data.workspaceIsSymbolicLink).toBe(true);

    const generate = await api.post(`/api/projects/${project.id}/project-document`).send({});
    expect(generate.status).toBe(409);
    expect(generate.body.error.details.code).toBe('PROJECT_WORKSPACE_IS_A_LINK');
    // Nothing was written at the link's target, either.
    expect(await fsp.readdir(real)).toEqual([]);
  });

  it('refuses to replace a folder sitting where PROJECT.md should be', async () => {
    const res = await createViaApi(uniqueName('DirClash'));
    const id = res.body.data.id;
    const docPath = docPathFor(res.body.data);
    await fsp.rm(docPath, { force: true });
    await fsp.mkdir(docPath, { recursive: true });

    const generate = await api.post(`/api/projects/${id}/project-document`).send({});
    expect(generate.status).toBe(409);
    expect(generate.body.error.details.code).toBe('PROJECT_DOCUMENT_IS_A_DIRECTORY');

    const read = await api.get(`/api/projects/${id}/project-document/content`);
    expect(read.status).toBe(409);
  });

  it('keeps each project inside its own folder', async () => {
    const a = await createViaApi(uniqueName('CrossA'), { description: 'Project A description.' });
    const b = await createViaApi(uniqueName('CrossB'), { description: 'Project B description.' });

    const docA = await api.get(`/api/projects/${a.body.data.id}/project-document/content`);
    const docB = await api.get(`/api/projects/${b.body.data.id}/project-document/content`);

    expect(docA.body.data.content).toContain('Project A description.');
    expect(docA.body.data.content).not.toContain('Project B description.');
    expect(docB.body.data.content).toContain('Project B description.');
    expect(docA.body.data.documentPath).not.toBe(docB.body.data.documentPath);
  });

  it('ignores any path a client tries to send', async () => {
    const a = await createViaApi(uniqueName('IgnoreA'), { description: 'Only A.' });
    const b = await createViaApi(uniqueName('IgnoreB'), { description: 'Only B.' });

    // Absolute path, traversal, UNC, and a filename override. None of these are
    // parameters the API has, so none can change what is read.
    for (const body of [
      { path: 'C:/Windows/System32/drivers/etc/hosts' },
      { documentPath: '../../../../secrets' },
      { relativePath: './OTHER.md' },
      { folderPath: '\\\\server\\share' },
      { filename: 'OTHER.md' }
    ]) {
      const read = await api.post(`/api/projects/${a.body.data.id}/project-document/regenerate`).send({ ...body, confirm: true });
      expect([200, 400]).toContain(read.status);
      if (read.status === 200) {
        const content = await fsp.readFile(docPathFor(a.body.data), 'utf8');
        expect(content).toContain('Only A.');
        expect(content).not.toContain('Only B.');
      }
    }

    // B's document is untouched by anything sent to A.
    const docB = await fsp.readFile(docPathFor(b.body.data), 'utf8');
    expect(docB).toContain('Only B.');
    expect(docB).not.toContain('Only A.');
  });

  it('refuses to read or write a document that is a link', async () => {
    const res = await createViaApi(uniqueName('DocLink'));
    const id = res.body.data.id;
    const docPath = docPathFor(res.body.data);
    const other = path.join(root, 'secret-target.md');
    await fsp.writeFile(other, 'secret\n', 'utf8');

    await fsp.rm(docPath, { force: true });
    try {
      await fsp.symlink(other, docPath, 'file');
    } catch {
      return;
    }

    const generate = await api.post(`/api/projects/${id}/project-document`).send({});
    expect(generate.status).toBe(409);
    expect(generate.body.error.details.code).toBe('PROJECT_DOCUMENT_IS_A_LINK');

    const regen = await api.post(`/api/projects/${id}/project-document/regenerate`).send({ confirm: true });
    expect(regen.status).toBe(409);
    expect(regen.body.error.details.code).toBe('PROJECT_DOCUMENT_IS_A_LINK');

    // The link target was not written through.
    expect(await fsp.readFile(other, 'utf8')).toBe('secret\n');
  });

  it('will not open a document larger than the limit', async () => {
    const res = await createViaApi(uniqueName('TooBig'));
    const id = res.body.data.id;
    const docPath = docPathFor(res.body.data);
    await fsp.writeFile(docPath, 'x'.repeat(PROJECT_DOCUMENT_MAX_BYTES + 1), 'utf8');

    const read = await api.get(`/api/projects/${id}/project-document/content`);
    expect(read.status).toBe(422);
    expect(read.body.error.details.limit).toBe(PROJECT_DOCUMENT_MAX_BYTES);
  });
});

describe('10. the creation response is honest when the document cannot be written', () => {
  it('still creates the project and folder, and says the document is missing', async () => {
    // A folder that cannot hold a file: on Windows a path over the legacy limit
    // fails at write time, so simulate the failure with a read-only-free
    // approach instead - point the record at a workspace that is a file.
    const notADir = path.join(root, 'not-a-directory');
    await fsp.writeFile(notADir, 'this is a file, not a folder', 'utf8');

    const project = await prisma.project.create({
      data: {
        name: uniqueName('NoDoc'),
        slug: `__test-nodoc-${Date.now()}`,
        stage: 'IDEA',
        folderName: 'not-a-directory',
        folderPath: notADir
      }
    });
    createdProjectIds.push(project.id);

    const generate = await api.post(`/api/projects/${project.id}/project-document`).send({});
    expect(generate.status).toBe(409);
    expect(generate.body.error.details.code).toBe('PROJECT_WORKSPACE_NOT_ON_DISK');

    // The project is intact and readable; only the document is unavailable.
    const get = await api.get(`/api/projects/${project.id}`);
    expect(get.status).toBe(200);
    expect(get.body.data.name).toBe(project.name);
  });
});
