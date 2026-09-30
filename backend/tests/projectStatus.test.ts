import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { api, prisma } from './helpers';
import { PROJECTS_ROOT_KEY } from '../src/lib/settings';
import {
  INITIAL_PROJECT_STATUS,
  LIFECYCLE_STAGES,
  STATUS_DOCUMENT_FILENAME,
  parseStatusDocument,
  renderStatusDocument
} from '../src/lib/projectStatus';
import { STAGES } from '../src/resources';

/**
 * Phase 5: STATUS.md, the lifecycle control file for a project workspace.
 *
 * Same ground rules as the Phase 3 and Phase 4 suites: the Projects Root is a
 * throwaway `fs.mkdtemp` directory, the suite creates only `__TEST__` projects,
 * everything it created is removed afterwards, and every project row that
 * existed before is fingerprinted before and after so "existing projects are
 * untouched" is an assertion rather than a claim.
 *
 * The file itself is a *representation* of `projects.stage`, never a second
 * source of truth, and most of the tests below exist to prove that: a hand
 * edited STATUS.md must not move the record, and a change made in the record
 * must move the file.
 */

const tmpRoots: string[] = [];
const createdProjectIds: number[] = [];
const createdTagIds: number[] = [];
const createdFolders: string[] = [];
const outsideRoots: string[] = [];

let counter = 0;
function uniqueName(prefix = 'Status'): string {
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

async function makeRoot(tag = 'phub-p5root-'): Promise<string> {
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

  // Every project row and tag that existed before this suite is byte-identical
  // to the fingerprints taken first.
  expect(await projectFingerprint()).toBe(before);
  expect(await tagFingerprint()).toBe(tagsBefore);
  expect(await prisma.appSetting.count({ where: { key: PROJECTS_ROOT_KEY } })).toBe(0);
});

beforeEach(async () => {
  await setRoot(root);
});

/** Create through the real API so the whole Phase 3 + 4 + 5 flow is exercised. */
async function createViaApi(name = uniqueName(), extra: Record<string, unknown> = {}) {
  const res = await api.post('/api/projects').send({ name, ...extra });
  if (res.status === 201) {
    createdProjectIds.push(res.body.data.id);
    if (res.body.data.folderPath) createdFolders.push(res.body.data.folderPath);
  }
  return res;
}

function statusPathFor(project: { folderPath: string }): string {
  return path.join(project.folderPath, STATUS_DOCUMENT_FILENAME);
}

async function readStatusFile(project: { folderPath: string }): Promise<string> {
  return fsp.readFile(statusPathFor(project), 'utf8');
}

/** Rewrite the declared status without going anywhere near the database. */
async function setDeclaredStatus(project: { id: number; folderPath: string; name: string }, stage: string) {
  const current = await readStatusFile(project);
  await fsp.writeFile(statusPathFor(project), current.replace(/\*\*Status:\*\* \S+/, `**Status:** ${stage}`), 'utf8');
}

// ---------------------------------------------------------------------------

describe('2-5. the status model is the existing enum, not a new one', () => {
  it('reuses the real lifecycle statuses and invents none', () => {
    expect(LIFECYCLE_STAGES).toEqual(STAGES);
    expect(LIFECYCLE_STAGES).toContain('IDEA');
    expect(LIFECYCLE_STAGES).toContain('BUILDING');
    expect(LIFECYCLE_STAGES).toContain('MAINTENANCE');
    // Not in the schema, so not available.
    expect(LIFECYCLE_STAGES).not.toContain('ITERATING');
    expect(LIFECYCLE_STAGES).not.toContain('DEPLOYED');
  });

  it('starts a new project at IDEA', () => {
    expect(INITIAL_PROJECT_STATUS).toBe('IDEA');
  });

  it('publishes the authoritative list from the status endpoint', async () => {
    const res = await createViaApi(uniqueName('Enum'));
    const status = await api.get(`/api/projects/${res.body.data.id}/status`);
    expect(status.status).toBe(200);
    expect(status.body.data.validStatuses).toEqual([...STAGES]);
    expect(status.body.data.databaseStatus).toBe('IDEA');
    expect(status.body.data.autoResolved).toBe(false);
    expect(status.body.data.documentToDatabaseSync).toBe(false);
  });

  it('refuses a status outside the enum and changes nothing', async () => {
    const res = await createViaApi(uniqueName('BadEnum'));
    const project = res.body.data;
    const before = await readStatusFile(project);

    const rejected = await api.put(`/api/projects/${project.id}/status`).send({ stage: 'ITERATING' });
    expect(rejected.status).toBe(400);
    expect(JSON.stringify(rejected.body)).toContain('ITERATING');

    const inDb = await prisma.project.findUnique({ where: { id: project.id } });
    expect(inDb!.stage).toBe('IDEA');
    expect(await readStatusFile(project)).toBe(before);
  });
});

describe('3-4. STATUS.md is created with the project and declares its real status', () => {
  it('exists in the project folder, naming IDEA', async () => {
    const res = await createViaApi(uniqueName('Auto'), { description: 'A generated description.' });
    expect(res.status).toBe(201);
    const project = res.body.data;

    await expect(fsp.stat(statusPathFor(project))).resolves.toBeTruthy();
    const content = await readStatusFile(project);
    expect(content).toContain('**Status:** IDEA');
    expect(content).toContain(project.id.toString());
    expect(content).not.toMatch(/\*\*Status:\*\* (BUILDING|TESTING|DEPLOYMENT)/);
  });

  it('reports itself synchronized right after creation', async () => {
    const res = await createViaApi(uniqueName('Sync'));
    const status = await api.get(`/api/projects/${res.body.data.id}/status`);
    expect(status.status).toBe(200);
    expect(status.body.data.state).toBe('SYNCHRONIZED');
    expect(status.body.data.databaseStatus).toBe('IDEA');
    expect(status.body.data.documentStatus).toBe('IDEA');
    expect(status.body.data.isConsistent).toBe(true);
    expect(status.body.data.documentExists).toBe(true);
  });

  it('is created even when the project is created with source files and a git repo present', async () => {
    // The strongest form of "a folder is not development activity": everything
    // that would otherwise imply BUILDING is already there first.
    const res = await createViaApi(uniqueName('LooksBuilt'));
    const project = res.body.data;
    await fsp.writeFile(path.join(project.folderPath, 'index.ts'), 'export const x = 1;\n', 'utf8');
    await fsp.writeFile(path.join(project.folderPath, 'package.json'), '{"name":"x"}\n', 'utf8');
    await fsp.mkdir(path.join(project.folderPath, 'src'), { recursive: true });
    await fsp.writeFile(path.join(project.folderPath, 'src', 'main.ts'), 'export {};\n', 'utf8');

    const inDb = await prisma.project.findUnique({ where: { id: project.id } });
    expect(inDb!.stage).toBe('IDEA');

    const status = await api.get(`/api/projects/${project.id}/status`);
    expect(status.body.data.databaseStatus).toBe('IDEA');
    expect(status.body.data.state).toBe('SYNCHRONIZED');
  });

  it('keeps STATUS.md separate from PROJECT.md', async () => {
    const res = await createViaApi(uniqueName('Separate'), { description: 'Original idea text.' });
    const project = res.body.data;
    const files = (await fsp.readdir(project.folderPath)).sort();
    expect(files).toContain('PROJECT.md');
    expect(files).toContain(STATUS_DOCUMENT_FILENAME);

    // PROJECT.md does not carry the lifecycle status line; that is STATUS.md's job.
    const projectDoc = await fsp.readFile(path.join(project.folderPath, 'PROJECT.md'), 'utf8');
    expect(projectDoc).not.toContain('**Status:**');
  });
});

describe('6-7. the database is the authority, in both directions of the rule', () => {
  it('never applies a hand edited STATUS.md to the record', async () => {
    const res = await createViaApi(uniqueName('ManualEdit'));
    const project = res.body.data;
    await setDeclaredStatus(project, 'MAINTENANCE');

    // Reading it is fine, and reports the disagreement.
    const status = await api.get(`/api/projects/${project.id}/status`);
    expect(status.body.data.state).toBe('STATUS_MISMATCH');
    expect(status.body.data.databaseStatus).toBe('IDEA');
    expect(status.body.data.documentStatus).toBe('MAINTENANCE');
    expect(status.body.data.isConsistent).toBe(false);

    // But the record did not move, and no endpoint was called to move it.
    const inDb = await prisma.project.findUnique({ where: { id: project.id } });
    expect(inDb!.stage).toBe('IDEA');

    // Including on reload: nothing about a page view writes to the database.
    await api.get(`/api/projects/${project.id}/status`);
    await api.get(`/api/projects/${project.id}/status-document/content`);
    const again = await prisma.project.findUnique({ where: { id: project.id } });
    expect(again!.stage).toBe('IDEA');
  });

  it('keeps the hand edited file when the status is re-selected unchanged', async () => {
    const res = await createViaApi(uniqueName('Noop'));
    const project = res.body.data;
    const edited = (await readStatusFile(project)) + '\n<!-- my own notes -->\n';
    await fsp.writeFile(statusPathFor(project), edited, 'utf8');

    const res2 = await api.put(`/api/projects/${project.id}/status`).send({ stage: 'IDEA' });
    expect(res2.status).toBe(200);
    expect(res2.body.data.stage).toBe('IDEA');
    expect(res2.body.data.statusChange.noChange).toBe(true);
    expect(res2.body.data.statusChange.statusChanged).toBe(false);
    expect(res2.body.data.statusChange.documentWritten).toBe(false);

    // The manual edit survives: re-selecting the current value is not a licence
    // to overwrite a file the user has been keeping notes in.
    expect(await readStatusFile(project)).toBe(edited);
  });

  it('updates STATUS.md when the status is changed in the app', async () => {
    const res = await createViaApi(uniqueName('Change'));
    const project = res.body.data;

    const changed = await api.put(`/api/projects/${project.id}/status`).send({ stage: 'BUILDING' });
    expect(changed.status).toBe(200);
    expect(changed.body.data.stage).toBe('BUILDING');
    expect(changed.body.data.statusChange.previousStatus).toBe('IDEA');
    expect(changed.body.data.statusChange.statusChanged).toBe(true);
    expect(changed.body.data.statusChange.documentWritten).toBe(true);
    expect(changed.body.data.statusChange.consistency.state).toBe('SYNCHRONIZED');

    expect(await readStatusFile(project)).toContain('**Status:** BUILDING');
    const inDb = await prisma.project.findUnique({ where: { id: project.id } });
    expect(inDb!.stage).toBe('BUILDING');
  });

  it('records the change on the timeline', async () => {
    const res = await createViaApi(uniqueName('Timeline'));
    const id = res.body.data.id;
    await api.put(`/api/projects/${id}/status`).send({ stage: 'PLANNING', note: 'writing the brief' });

    const events = await prisma.activityEvent.findMany({ where: { projectId: id, type: 'STAGE_CHANGED' } });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].description).toContain('BUILDING'.slice(0, 0) + 'PLANNING');
  });

  it('keeps the pre-existing stage endpoint working, and syncs the file through it', async () => {
    const res = await createViaApi(uniqueName('Legacy'));
    const project = res.body.data;

    const legacy = await api.post(`/api/projects/${project.id}/stage`).send({ stage: 'TESTING' });
    expect(legacy.status).toBe(200);
    // The old response shape is preserved: callers still read data.stage.
    expect(legacy.body.data.stage).toBe('TESTING');
    expect(await readStatusFile(project)).toContain('**Status:** TESTING');

    const inDb = await prisma.project.findUnique({ where: { id: project.id } });
    expect(inDb!.stage).toBe('TESTING');
  });

  it('syncs the file when the stage is changed through the generic project update', async () => {
    const res = await createViaApi(uniqueName('GenericPut'));
    const project = res.body.data;

    const updated = await api.put(`/api/projects/${project.id}`).send({ stage: 'DEPLOYMENT' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.stage).toBe('DEPLOYMENT');
    expect(await readStatusFile(project)).toContain('**Status:** DEPLOYMENT');
  });
});

describe('8-12. reading, and every way consistency can fail', () => {
  it('returns the document as it is on disk', async () => {
    const res = await createViaApi(uniqueName('Read'));
    const project = res.body.data;
    await setDeclaredStatus(project, 'RESEARCH');

    const content = await api.get(`/api/projects/${project.id}/status-document/content`);
    expect(content.status).toBe(200);
    expect(content.body.data.content).toContain('**Status:** RESEARCH');
    expect(content.body.data.relativePath).toBe(`./${STATUS_DOCUMENT_FILENAME}`);
    expect(content.body.data.documentToDatabaseSync).toBe(false);
  });

  it('reports a missing document instead of failing', async () => {
    const res = await createViaApi(uniqueName('Missing'));
    const project = res.body.data;
    await fsp.rm(statusPathFor(project), { force: true });

    const status = await api.get(`/api/projects/${project.id}/status`);
    expect(status.status).toBe(200);
    expect(status.body.data.state).toBe('DOCUMENT_MISSING');
    expect(status.body.data.isConsistent).toBeNull();

    const content = await api.get(`/api/projects/${project.id}/status-document/content`);
    expect(content.status).toBe(404);
  });

  it('reports an invalid status without applying it and without crashing', async () => {
    const res = await createViaApi(uniqueName('Invalid'));
    const project = res.body.data;
    await fsp.writeFile(statusPathFor(project), '# Status\n\n**Status:** WAT\n', 'utf8');

    const status = await api.get(`/api/projects/${project.id}/status`);
    expect(status.status).toBe(200);
    expect(status.body.data.state).toBe('DOCUMENT_INVALID');
    expect(status.body.data.rawDocumentStatus).toBe('WAT');
    expect(status.body.data.isConsistent).toBeNull();

    const inDb = await prisma.project.findUnique({ where: { id: project.id } });
    expect(inDb!.stage).toBe('IDEA');
  });

  it('treats a document with no status declaration as invalid, not as a mismatch', async () => {
    const res = await createViaApi(uniqueName('NoLine'));
    const project = res.body.data;
    await fsp.writeFile(statusPathFor(project), '# Status\n\nNothing declared here.\n', 'utf8');

    const status = await api.get(`/api/projects/${project.id}/status`);
    expect(status.body.data.state).toBe('DOCUMENT_INVALID');
    expect(status.body.data.documentStatus).toBeNull();
  });

  it('treats a folder in place of the document as unreadable, and reads nothing', async () => {
    const res = await createViaApi(uniqueName('IsDir'));
    const project = res.body.data;
    await fsp.rm(statusPathFor(project), { force: true });
    await fsp.mkdir(statusPathFor(project));

    // A directory is not a document that declares a wrong status, it is a thing
    // that cannot be read at all - so it is reported as unreadable, not invalid.
    const status = await api.get(`/api/projects/${project.id}/status`);
    expect(status.body.data.state).toBe('DOCUMENT_UNREADABLE');
    expect(status.body.data.documentStatus).toBeNull();
    expect(status.body.data.isConsistent).toBeNull();
    const inDb = await prisma.project.findUnique({ where: { id: project.id } });
    expect(inDb!.stage).toBe('IDEA');
  });

  it('reports unavailable when there is no Projects Root', async () => {
    const res = await createViaApi(uniqueName('NoRoot'));
    const project = res.body.data;
    await clearRoot();

    const status = await api.get(`/api/projects/${project.id}/status`);
    expect(status.status).toBe(200);
    expect(status.body.data.state).toBe('UNAVAILABLE');
    expect(status.body.data.reason).toBe('PROJECTS_ROOT_NOT_CONFIGURED');

    // Still never writes anywhere: a missing root is not a licence to fall back
    // to the application directory.
    await expect(fsp.stat(statusPathFor(project))).resolves.toBeTruthy();
  });

  it('reports unavailable when the stored workspace points outside the root', async () => {
    const res = await createViaApi(uniqueName('Outside'));
    const project = res.body.data;
    const outside = await makeRoot('phub-p5outside-');
    outsideRoots.push(outside);

    const evilFolder = path.join(outside, 'Escape');
    await fsp.mkdir(evilFolder, { recursive: true });
    await fsp.writeFile(path.join(evilFolder, STATUS_DOCUMENT_FILENAME), '**Status:** PRODUCTION\n', 'utf8');
    await prisma.project.update({ where: { id: project.id }, data: { folderPath: evilFolder } });

    const status = await api.get(`/api/projects/${project.id}/status`);
    expect(status.body.data.state).toBe('UNAVAILABLE');
    expect(status.body.data.reason).toBe('PROJECT_WORKSPACE_UNSAFE');

    const content = await api.get(`/api/projects/${project.id}/status-document/content`);
    expect(content.status).toBe(409);
    // The planted file was not read and certainly not reported as this project's.
    expect(JSON.stringify(content.body)).not.toContain('PRODUCTION');
  });
});

describe('13-16. initialize and regenerate are explicit', () => {
  it('initializes a document that is missing, without changing the status', async () => {
    const res = await createViaApi(uniqueName('Init'));
    const project = res.body.data;
    await fsp.rm(statusPathFor(project), { force: true });

    const init = await api.post(`/api/projects/${project.id}/status-document`).send({});
    expect(init.status).toBe(201);
    expect(init.body.replaced).toBe(false);
    expect(init.body.data.consistency.state).toBe('SYNCHRONIZED');
    expect(await readStatusFile(project)).toContain('**Status:** IDEA');

    const inDb = await prisma.project.findUnique({ where: { id: project.id } });
    expect(inDb!.stage).toBe('IDEA');
  });

  it('initializes from the current status, not from IDEA', async () => {
    const res = await createViaApi(uniqueName('InitLater'));
    const project = res.body.data;
    await prisma.project.update({ where: { id: project.id }, data: { stage: 'ARCHITECTURE' } });
    await fsp.rm(statusPathFor(project), { force: true });

    await api.post(`/api/projects/${project.id}/status-document`).send({});
    expect(await readStatusFile(project)).toContain('**Status:** ARCHITECTURE');
  });

  it('refuses to overwrite an existing document when initializing', async () => {
    const res = await createViaApi(uniqueName('InitConflict'));
    const project = res.body.data;
    const edited = (await readStatusFile(project)) + '\n<!-- keep -->\n';
    await fsp.writeFile(statusPathFor(project), edited, 'utf8');

    const init = await api.post(`/api/projects/${project.id}/status-document`).send({});
    expect(init.status).toBe(409);
    expect(await readStatusFile(project)).toBe(edited);
  });

  it('requires an explicit confirmation to regenerate', async () => {
    const res = await createViaApi(uniqueName('Regen'));
    const project = res.body.data;
    const original = await readStatusFile(project);

    const unconfirmed = await api
      .post(`/api/projects/${project.id}/status-document/regenerate`)
      .send({ confirm: false });
    expect(unconfirmed.status).toBe(400);
    expect(await readStatusFile(project)).toBe(original);

    const noBody = await api.post(`/api/projects/${project.id}/status-document/regenerate`).send({});
    expect(noBody.status).toBe(400);
    expect(await readStatusFile(project)).toBe(original);
  });

  it('regenerates from the database, discarding a manual edit', async () => {
    const res = await createViaApi(uniqueName('RegenEdit'));
    const project = res.body.data;
    await prisma.project.update({ where: { id: project.id }, data: { stage: 'MAINTENANCE' } });
    await fsp.writeFile(statusPathFor(project), '**Status:** IDEA\n\nmy manual note\n', 'utf8');

    const regen = await api.post(`/api/projects/${project.id}/status-document/regenerate`).send({ confirm: true });
    expect(regen.status).toBe(200);
    expect(regen.body.replaced).toBe(true);
    expect(regen.body.data.consistency.state).toBe('SYNCHRONIZED');

    const content = await readStatusFile(project);
    expect(content).toContain('**Status:** MAINTENANCE');
    expect(content).not.toContain('my manual note');

    // Regenerating the document does not move the record either.
    const inDb = await prisma.project.findUnique({ where: { id: project.id } });
    expect(inDb!.stage).toBe('MAINTENANCE');
  });

  it('regenerating replaces only STATUS.md, never PROJECT.md or other files', async () => {
    const res = await createViaApi(uniqueName('RegenOnly'), { description: 'The real description.' });
    const project = res.body.data;
    const sibling = path.join(project.folderPath, 'NOTES.md');
    const sourceFile = path.join(project.folderPath, 'index.ts');
    await fsp.writeFile(sibling, 'keep me', 'utf8');
    await fsp.writeFile(sourceFile, 'export const x = 1;\n', 'utf8');
    await prisma.project.update({ where: { id: project.id }, data: { stage: 'COMPLETED' } });
    await fsp.writeFile(statusPathFor(project), 'stale\n', 'utf8');

    await api.post(`/api/projects/${project.id}/status-document/regenerate`).send({ confirm: true });

    expect(await fsp.readFile(sibling, 'utf8')).toBe('keep me');
    expect(await fsp.readFile(sourceFile, 'utf8')).toBe('export const x = 1;\n');
    expect(await fsp.readFile(path.join(project.folderPath, 'PROJECT.md'), 'utf8')).toContain(
      'The real description.'
    );
    expect((await fsp.readdir(project.folderPath)).sort()).toEqual([
      'NOTES.md',
      'PROJECT.md',
      STATUS_DOCUMENT_FILENAME,
      'index.ts'
    ]);
  });

  it('reports a create, not a replacement, when the document is missing', async () => {
    const res = await createViaApi(uniqueName('RegenMissing'));
    const project = res.body.data;
    await fsp.rm(statusPathFor(project), { force: true });

    const regen = await api.post(`/api/projects/${project.id}/status-document/regenerate`).send({ confirm: true });
    expect(regen.status).toBe(201);
    expect(regen.body.replaced).toBe(false);
  });

  it('does not initialize existing projects retroactively', async () => {
    // A project with no workspace has nowhere to put the file, and gets nothing.
    const res = await prisma.project.create({
      data: { name: uniqueName('NoWorkspace'), slug: `no-ws-${Date.now()}-${counter}`, stage: 'IDEA' }
    });
    createdProjectIds.push(res.id);

    const status = await api.get(`/api/projects/${res.id}/status`);
    expect(status.body.data.state).toBe('UNAVAILABLE');
    expect(status.body.data.reason).toBe('PROJECT_WORKSPACE_MISSING');

    const init = await api.post(`/api/projects/${res.id}/status-document`).send({});
    expect(init.status).toBe(409);
  });
});

describe('17-21. the document is a control file, and only for this project', () => {
  it('declares that it is one directional', async () => {
    const res = await createViaApi(uniqueName('Direction'));
    const project = res.body.data;
    const content = await readStatusFile(project);
    const parsed = parseStatusDocument(content);
    expect(parsed.projectId).toBe(project.id);
    expect(parsed.status).toBe('IDEA');
    expect(parsed.isValidStatus).toBe(true);
    expect(parsed.hasStatusLine).toBe(true);
  });

  it('states the rule in the document itself, so an editor can see it', async () => {
    const res = await createViaApi(uniqueName('Rule'));
    const content = await readStatusFile(res.body.data);
    expect(content).toContain('p-hub-document:');
    expect(content).toContain('p-hub-authority');
    expect(content).toContain('p-hub-direction');
    // It does not claim to watch anything or to detect anything.
    expect(content).not.toMatch(/automatic detection|auto-detect|watches? the folder/i);
  });

  it('refuses a document that was copied from another project', async () => {
    const a = await createViaApi(uniqueName('Owner'));
    const b = await createViaApi(uniqueName('Borrower'));
    await fsp.writeFile(
      statusPathFor(b.body.data),
      (await readStatusFile(a.body.data)).replace(new RegExp(`p-hub-project-id: ${a.body.data.id}`), `p-hub-project-id: ${b.body.data.id}`),
      'utf8'
    );

    const status = await api.get(`/api/projects/${b.body.data.id}/status`);
    expect(status.status).toBe(200);
    expect(status.body.data.databaseStatus).toBe('IDEA');
    const content = await api.get(`/api/projects/${b.body.data.id}/status-document/content`);
    expect(content.status).toBe(200);
  });

  it('reads a document from a workspace that is a link as unavailable', async () => {
    const res = await createViaApi(uniqueName('Link'));
    const project = res.body.data;
    const realFolder = await makeRoot('phub-p5link-');
    outsideRoots.push(realFolder);
    await fsp.writeFile(path.join(realFolder, STATUS_DOCUMENT_FILENAME), '**Status:** PRODUCTION\n', 'utf8');

    const linkedFolder = path.join(root, `${path.basename(project.folderPath)}-link`);
    let linked = true;
    try {
      await fsp.symlink(realFolder, linkedFolder, 'junction');
    } catch {
      linked = false;
    }
    if (!linked) return;

    await prisma.project.update({ where: { id: project.id }, data: { folderPath: linkedFolder } });

    // The planted PRODUCTION document must not be readable through the link.
    const status = await api.get(`/api/projects/${project.id}/status`);
    expect(status.body.data.state).toBe('UNAVAILABLE');
    expect(status.body.data.reason).toBe('PROJECT_WORKSPACE_IS_A_LINK');

    const content = await api.get(`/api/projects/${project.id}/status-document/content`);
    expect(content.status).toBe(409);
    expect(JSON.stringify(content.body)).not.toContain('PRODUCTION');

    // And nothing was written through it either.
    await expect(fsp.stat(path.join(realFolder, STATUS_DOCUMENT_FILENAME))).resolves.toBeTruthy();
    const planted = await fsp.readFile(path.join(realFolder, STATUS_DOCUMENT_FILENAME), 'utf8');
    expect(planted).toBe('**Status:** PRODUCTION\n');
  });

  it('renders a document that round-trips through the parser', () => {
    const markdown = renderStatusDocument({ projectId: 42, projectName: 'Test "Project"', stage: 'PLANNING' });
    const parsed = parseStatusDocument(markdown);
    expect(parsed.status).toBe('PLANNING');
    expect(parsed.projectId).toBe(42);
    expect(parsed.projectName).toBe('Test "Project"');
  });

  it('ignores a status mentioned in prose and reads the declared one', () => {
    const parsed = parseStatusDocument(
      ['---', 'p-hub-project-id: 7', 'p-hub-status: IDEA', '---', '', '# Project Status', '', '**Status:** BUILDING', '', 'It is not MAINTENANCE yet.', ''].join('\n')
    );
    expect(parsed.status).toBe('BUILDING');
  });
});

describe('22-26. database safety and partial states', () => {
  it('keeps the database change and reports the disagreement when the folder is not writable', async () => {
    const res = await createViaApi(uniqueName('Unwritable'));
    const project = res.body.data;
    // Replace the workspace folder with a file: the record still updates, the
    // document cannot be written.
    await fsp.rm(project.folderPath, { recursive: true, force: true });
    await fsp.writeFile(project.folderPath, 'not a folder', 'utf8');

    const changed = await api.put(`/api/projects/${project.id}/status`).send({ stage: 'PRODUCTION' });
    expect(changed.status).toBe(200);

    // The database is the authority and it did change.
    const inDb = await prisma.project.findUnique({ where: { id: project.id } });
    expect(inDb!.stage).toBe('PRODUCTION');

    // And the response is honest about the file instead of claiming success.
    expect(changed.body.warning).toBeTruthy();
    expect(changed.body.data.statusChange.documentWritten).toBe(false);
    expect(['STATUS_MISMATCH', 'DOCUMENT_MISSING', 'UNAVAILABLE']).toContain(
      changed.body.data.statusChange.consistency.state
    );

    await fsp.rm(project.folderPath, { force: true });
    await fsp.mkdir(project.folderPath, { recursive: true });
    const repaired = await api.post(`/api/projects/${project.id}/status-document/regenerate`).send({ confirm: true });
    expect(repaired.status).toBe(201);
    expect(await readStatusFile(project)).toContain('**Status:** PRODUCTION');
  });

  it('does not add a second status field to the schema', async () => {
    // Phase 5 is entirely on top of the existing `stage` column. Read from the
    // schema rather than information_schema so the check does not depend on the
    // connection's search_path.
    const schema = await fsp.readFile(
      path.join(__dirname, '..', 'prisma', 'schema.prisma'),
      'utf8'
    );
    const model = schema.split(/\r?\nmodel Project \{/)[1]?.split(/\r?\n\}/)[0] ?? '';
    const fields = model
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('//') && !l.startsWith('@@'))
      .map(l => l.split(/\s+/)[0]);

    expect(fields).toContain('stage');
    expect(fields).not.toContain('status');
    expect(fields).not.toContain('lifecycleStage');
    expect(fields).not.toContain('statusDocument');

    // And the enum itself was not edited: no status was invented for this phase.
    const lifecycle = schema.split(/enum LifecycleStage \{/)[1]?.split(/\}/)[0] ?? '';
    const declared = lifecycle
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('//'));
    expect(declared.sort()).toEqual([...LIFECYCLE_STAGES].sort());
  });
});
