import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { api, prisma } from './helpers';
import { PROJECTS_ROOT_KEY } from '../src/lib/settings';
import { PROJECT_DOCUMENT_FILENAME } from '../src/lib/projectDocument';
import { parseProjectDocument } from '../src/lib/projectDocumentParser';

/**
 * Phase 8: AI prompt management and project context.
 *
 * The same safety envelope as the Phase 4/6/7 suites: a throwaway Projects
 * Root, only `__TEST__` projects created through the real API, everything
 * removed in afterAll, and a fingerprint of every pre-existing project, task,
 * note and prompt taken before the suite and compared both after the last test
 * and again after cleanup - so "no destructive operations" is asserted rather
 * than claimed.
 *
 * Nothing in this suite talks to an AI provider, and neither does the code
 * under test: prompts are data, the generator assembles text from records.
 */

const tmpRoots: string[] = [];
const createdProjectIds: number[] = [];
const createdFolders: string[] = [];

let counter = 0;
function uniqueName(prefix = 'P8'): string {
  counter += 1;
  return `__TEST__ ${prefix} ${Date.now()}-${counter}`;
}

/** Every row that must survive the suite untouched, hashed. */
async function safetyFingerprint(excludeProjectIds: number[] = []): Promise<string> {
  const excluded = new Set(excludeProjectIds);
  const [projects, tasks, notes, prompts] = await Promise.all([
    prisma.project.findMany({ orderBy: { id: 'asc' } }),
    prisma.task.findMany({ orderBy: { id: 'asc' } }),
    prisma.note.findMany({ orderBy: { id: 'asc' } }),
    prisma.prompt.findMany({ orderBy: { id: 'asc' } })
  ]);
  const payload = {
    projects: projects.filter(p => !excluded.has(p.id)),
    tasks: tasks.filter(t => !excluded.has(t.projectId)),
    notes: notes.filter(n => !excluded.has(n.projectId)),
    prompts: prompts.filter(p => !excluded.has(p.projectId))
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

let root: string;
let safetyBefore: string | null = null;

beforeAll(async () => {
  safetyBefore = await safetyFingerprint();
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'phub-p8root-'));
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
  expect(await safetyFingerprint()).toBe(safetyBefore);
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

async function regenerate(projectId: number) {
  const res = await api.post(`/api/projects/${projectId}/project-document/regenerate`).send({ confirm: true });
  expect(res.status).toBe(200);
  return res;
}

async function status(projectId: number) {
  return api.get(`/api/projects/${projectId}/project-document/sync/status`);
}

async function preview(projectId: number) {
  return api.post(`/api/projects/${projectId}/project-document/sync/preview`).send({});
}

async function sync(projectId: number, body: Record<string, unknown> = {}) {
  return api.post(`/api/projects/${projectId}/project-document/sync`).send(body);
}

async function resolve(
  projectId: number,
  resolutions: Record<string, unknown>[]
) {
  return api.post(`/api/projects/${projectId}/project-document/sync/resolve`).send({ resolutions });
}

async function createPrompt(projectId: number, body: Record<string, unknown>) {
  const res = await api.post(`/api/projects/${projectId}/prompts`).send(body);
  expect(res.status).toBe(201);
  return res.body.data as { id: number; code: string; content: string };
}

/** The invariant from lib/promptLibrary.ts, checked against the database. */
async function promptWithHistory(id: number) {
  const prompt = await prisma.prompt.findUnique({
    where: { id },
    include: { versions: { orderBy: { version: 'asc' } } }
  });
  expect(prompt).not.toBeNull();
  expect(prompt!.versions.length).toBeGreaterThan(0);
  expect(prompt!.content).toBe(prompt!.versions[prompt!.versions.length - 1]!.text);
  return prompt!;
}

// ---------------------------------------------------------------------------
// 1-6. The prompt library itself
// ---------------------------------------------------------------------------

describe('1. create a prompt', () => {
  it('stores the text as content with an initial version and Phase 8 defaults', async () => {
    const project = await createProject(uniqueName('Create'));
    const prompt = await createPrompt(project.id, {
      title: 'Design the sync engine',
      purpose: 'Architecture',
      category: 'Architecture',
      isReusable: true,
      status: 'READY',
      text: 'Act as a software architect. Design a synchronization engine for PROJECT.md.'
    });

    expect(prompt.code).toMatch(/^PROMPT-\d{3,}$/);
    expect(prompt.content).toContain('synchronization engine');

    const stored = await promptWithHistory(prompt.id);
    expect(stored.projectId).toBe(project.id);
    expect(stored.status).toBe('READY');
    expect(stored.isReusable).toBe(true);
    expect(stored.versions).toHaveLength(1);
    expect(stored.versions[0]!.version).toBe(1);
    expect(stored.versions[0]!.text).toBe(prompt.content);

    // Defaults when the caller says nothing.
    const bare = await createPrompt(project.id, { text: 'Bare prompt text' });
    const bareStored = await promptWithHistory(bare.id);
    expect(bareStored.status).toBe('DRAFT');
    expect(bareStored.isReusable).toBe(false);
    expect(bareStored.title).toBeNull();
  });
});

describe('2. edit a prompt', () => {
  it('appends a version instead of rewriting history, and metadata-only edits add none', async () => {
    const project = await createProject(uniqueName('Edit'));
    const prompt = await createPrompt(project.id, { title: 'First title', text: 'Original text' });

    const edited = await api
      .put(`/api/projects/${project.id}/prompts/${prompt.id}`)
      .send({ text: 'Revised text', response: 'A recorded response' });
    expect(edited.status).toBe(200);
    expect(edited.body.data.content).toBe('Revised text');

    const afterEdit = await promptWithHistory(prompt.id);
    expect(afterEdit.versions).toHaveLength(2);
    expect(afterEdit.versions[0]!.text).toBe('Original text'); // immutable history
    expect(afterEdit.versions[1]!.text).toBe('Revised text');
    expect(afterEdit.versions[1]!.response).toBe('A recorded response');

    const meta = await api
      .put(`/api/projects/${project.id}/prompts/${prompt.id}`)
      .send({ title: 'Second title', category: 'Debugging' });
    expect(meta.status).toBe(200);

    const afterMeta = await promptWithHistory(prompt.id);
    expect(afterMeta.title).toBe('Second title');
    expect(afterMeta.category).toBe('Debugging');
    expect(afterMeta.versions).toHaveLength(2); // no version for an untouched text
  });
});

describe('3. search prompts', () => {
  it('finds by title and by current content, within a project and across projects', async () => {
    const projectA = await createProject(uniqueName('SearchA'));
    const projectB = await createProject(uniqueName('SearchB'));
    const a = await createPrompt(projectA.id, {
      title: 'Zebrafish loader',
      text: 'Implement the zebrafish data loader with retries.'
    });
    await createPrompt(projectB.id, {
      title: 'Other work',
      text: 'Something about zebrafish migrations in another project.'
    });
    await createPrompt(projectA.id, { title: 'Unrelated', text: 'Nothing to see.' });

    const scoped = await api.get(`/api/projects/${projectA.id}/prompts`).query({ q: 'zebrafish' });
    expect(scoped.status).toBe(200);
    expect(scoped.body.data).toHaveLength(1);
    expect(scoped.body.data[0].id).toBe(a.id);

    // The same word inside prompt *content* matches too, not just titles.
    const byContent = await api.get(`/api/projects/${projectA.id}/prompts`).query({ q: 'retries' });
    expect(byContent.body.data.map((r: { id: number }) => r.id)).toContain(a.id);

    const global = await api.get('/api/prompts').query({ q: 'zebrafish' });
    expect(global.status).toBe(200);
    expect(global.body.meta.total).toBe(2);
    expect(global.body.data[0]).toHaveProperty('project.name');

    const everything = await api.get('/api/search').query({ q: 'zebrafish' });
    expect(everything.body.data.prompts.length).toBe(2);
  });
});

describe('4. filter by category', () => {
  it('returns only the prompts of the requested category', async () => {
    const project = await createProject(uniqueName('Category'));
    const coding = await createPrompt(project.id, { category: 'Coding', text: 'Write the parser.' });
    await createPrompt(project.id, { category: 'Research', text: 'Survey the options.' });
    await createPrompt(project.id, { text: 'No category at all.' });

    const filtered = await api.get(`/api/projects/${project.id}/prompts`).query({ category: 'Coding' });
    expect(filtered.status).toBe(200);
    expect(filtered.body.data).toHaveLength(1);
    expect(filtered.body.data[0].id).toBe(coding.id);
  });
});

describe('5. reusable prompts', () => {
  it('filters on the reusable flag and surfaces reusable prompts in the context', async () => {
    const project = await createProject(uniqueName('Reusable'));
    const template = await createPrompt(project.id, {
      title: 'Code review template',
      isReusable: true,
      text: 'Review this change against the recorded requirements.'
    });
    await createPrompt(project.id, { title: 'One-off', text: 'A one-off prompt.' });

    const reusable = await api.get(`/api/projects/${project.id}/prompts`).query({ isReusable: 'true' });
    expect(reusable.body.data).toHaveLength(1);
    expect(reusable.body.data[0].id).toBe(template.id);

    const globalReusable = await api.get('/api/prompts').query({ reusable: 'true' });
    expect(globalReusable.body.data.map((r: { id: number }) => r.id)).toContain(template.id);

    // The draft generator lists this project's reusable prompts as context.
    const generated = await api
      .post(`/api/projects/${project.id}/prompts/generate`)
      .send({ purpose: 'Documentation' });
    expect(generated.status).toBe(200);
    expect(generated.body.data.draft.content).toContain('Code review template');
  });
});

describe('6. archive a prompt', () => {
  it('changes the status, keeps the row, and takes it out of the default lists', async () => {
    const project = await createProject(uniqueName('Archive'));
    const prompt = await createPrompt(project.id, { title: 'Retired approach', status: 'READY', text: 'Old text.' });

    const archived = await api.post(`/api/projects/${project.id}/prompts/${prompt.id}/archive`).send({});
    expect(archived.status).toBe(200);
    expect(archived.body.data.status).toBe('ARCHIVED');

    const defaultList = await api.get(`/api/projects/${project.id}/prompts`);
    expect(defaultList.body.data.map((r: { id: number }) => r.id)).not.toContain(prompt.id);

    const globalDefault = await api.get('/api/prompts').query({ projectId: project.id });
    expect(globalDefault.body.data).toHaveLength(0);

    const explicit = await api.get(`/api/projects/${project.id}/prompts`).query({ status: 'ARCHIVED' });
    expect(explicit.body.data.map((r: { id: number }) => r.id)).toContain(prompt.id);

    // Nothing was deleted: the row and its history are still there, and
    // archiving twice is a no-op rather than an error.
    expect(await prisma.prompt.count({ where: { id: prompt.id } })).toBe(1);
    expect(await prisma.promptVersion.count({ where: { promptId: prompt.id } })).toBe(1);
    const again = await api.post(`/api/projects/${project.id}/prompts/${prompt.id}/archive`).send({});
    expect(again.status).toBe(200);
    expect(again.body.data.status).toBe('ARCHIVED');
  });
});

// ---------------------------------------------------------------------------
// 7. PROJECT.md
// ---------------------------------------------------------------------------

describe('7. PROJECT.md representation', () => {
  it('renders prompts with their attributes, round-trips them, and invents no titles', async () => {
    const project = await createProject(uniqueName('Doc'), { description: 'A project for document tests.' });
    const titled = await createPrompt(project.id, {
      title: 'Alpha probe',
      purpose: 'Build the API',
      category: 'Coding',
      isReusable: true,
      text: 'Implement the endpoint from the recorded requirements.'
    });
    const untitled = await createPrompt(project.id, { text: 'Untitled draft content.' });

    await regenerate(project.id);
    const doc = await readDoc(project);

    expect(doc).toContain('## AI Prompts');
    expect(doc).toContain(`- **${titled.code}** Alpha probe`);
    expect(doc).toContain('Category: Coding · Status: Draft · Reusable: Yes · Purpose: Build the API');
    expect(doc).toContain('  Implement the endpoint from the recorded requirements.');
    // A prompt with no title is rendered as its code alone - never as the code
    // twice, which would make the next synchronization write a fabricated title.
    expect(doc).toMatch(new RegExp(`^- \\*\\*${untitled.code}\\*\\*$`, 'm'));

    const parsed = parseProjectDocument(doc);
    expect(parsed.records['AI Prompts']).toHaveLength(2);
    expect(parsed.records['AI Prompts']![0]!.attributes).toContain('Category: Coding');

    // Round trip: the generated document agrees with the database, so a preview
    // finds nothing to apply and a sync is a no-op.
    const previewed = await preview(project.id);
    expect(previewed.body.data.sync.state).toBe('synchronized');
    expect(previewed.body.data.sync.conflicts).toEqual([]);

    const synced = await sync(project.id);
    expect(synced.body.data.applied).toBeNull();

    const stored = await promptWithHistory(titled.id);
    expect(stored.title).toBe('Alpha probe');
    expect(stored.versions).toHaveLength(1); // the round trip added no versions
    expect((await prisma.prompt.findUnique({ where: { id: untitled.id } }))!.title).toBeNull();
  });

  it('applies an edit made in PROJECT.md and records the version it implies', async () => {
    const project = await createProject(uniqueName('DocEdit'));
    const prompt = await createPrompt(project.id, { title: 'Doc edit', text: 'Before the hand edit.' });
    await regenerate(project.id);

    const edited = (await readDoc(project)).replace('Before the hand edit.', 'After the hand edit.');
    expect(edited).not.toBe(await readDoc(project));
    await writeDoc(project, edited);

    const applied = await sync(project.id);
    expect(applied.body.data.applied).not.toBeNull();

    const stored = await promptWithHistory(prompt.id);
    expect(stored.content).toBe('After the hand edit.');
    expect(stored.versions).toHaveLength(2);
    expect(stored.versions[1]!.text).toBe('After the hand edit.');
    expect(stored.versions[1]!.changes).toContain('PROJECT.md');
  });
});

// ---------------------------------------------------------------------------
// 8-11. Generation: readiness, missing information, proceeding, filling gaps
// ---------------------------------------------------------------------------

describe('8. generate a prompt draft', () => {
  it('builds the draft from the recorded project data and reports no AI service', async () => {
    const name = uniqueName('Gen');
    const project = await createProject(name, { description: 'Tracks study progress for biologists.' });
    const req = await api
      .post(`/api/projects/${project.id}/requirements`)
      .send({ title: 'Export sessions as CSV', description: 'Researchers need raw data.' });
    expect(req.status).toBe(201);

    const res = await api.post(`/api/projects/${project.id}/prompts/generate`).send({ purpose: 'Feature implementation' });
    expect(res.status).toBe(200);

    const { readiness, draft } = res.body.data;
    expect(readiness.purpose).toBe('Feature implementation');
    expect(readiness.ready).toBe(true);
    expect(readiness.missingRequired).toEqual([]);
    expect(draft.category).toBe('Coding');
    expect(draft.title).toBe(`Feature implementation — ${name}`);
    expect(draft.content).toContain('Tracks study progress for biologists.');
    expect(draft.content).toContain(`${req.body.data.code} ${req.body.data.title}`);
    expect(draft.content).toContain('no AI service was called');
    expect(draft.content).not.toContain('undefined');
    expect(Array.isArray(res.body.meta.failures)).toBe(true);

    const bad = await api.post(`/api/projects/${project.id}/prompts/generate`).send({ purpose: 'Cooking' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain('purpose must be one of');
  });
});

describe('9. missing information is reported, never invented', () => {
  it('returns an honest checklist and a draft that marks every gap', async () => {
    const project = await createProject(uniqueName('Missing'));

    const res = await api.post(`/api/projects/${project.id}/prompts/generate`).send({ purpose: 'Research' });
    expect(res.status).toBe(200);

    const { readiness, draft } = res.body.data;
    expect(readiness.ready).toBe(false);
    expect(readiness.missingRequired).toContain('description');
    expect(readiness.missingRequired).toContain('problem');
    const descriptionItem = readiness.items.find((i: { key: string }) => i.key === 'description');
    expect(descriptionItem).toMatchObject({ required: true, present: false });

    expect(draft.content).toContain('Not provided in Project Hub.');
    // An absent value becomes the marker line itself - never invented prose.
    expect(draft.content).toContain('- Not provided in Project Hub.');
    expect(draft.content).not.toContain('- Description:');
    expect(draft.content).not.toContain('- Problem:');
  });
});

describe('10. proceed anyway', () => {
  it('lets an unready draft be saved as a prompt without any extra approval', async () => {
    const project = await createProject(uniqueName('Proceed'));
    const generated = await api.post(`/api/projects/${project.id}/prompts/generate`).send({ purpose: 'Debugging' });
    expect(generated.body.data.readiness.ready).toBe(false);

    const { draft, readiness } = generated.body.data;
    const saved = await createPrompt(project.id, {
      title: draft.title,
      purpose: draft.purpose,
      category: draft.category,
      text: draft.content,
      status: 'DRAFT'
    });
    expect(saved.content).toBe(draft.content);

    const stored = await promptWithHistory(saved.id);
    expect(stored.purpose).toBe('Debugging');
    // Readiness is computed per request from the project's records; it is not
    // stored on the prompt, so saving an unready draft records no verdict.
    expect(readiness.missingRequired.length).toBeGreaterThan(0);
    expect(stored.status).toBe('DRAFT');
  });
});

describe('11. fill the missing information', () => {
  it('turns an unready checklist into a ready one once the project records the gap', async () => {
    const project = await createProject(uniqueName('Fill'));
    const before = await api.post(`/api/projects/${project.id}/prompts/generate`).send({ purpose: 'Research' });
    expect(before.body.data.readiness.ready).toBe(false);

    await prisma.project.update({
      where: { id: project.id },
      data: {
        description: 'A field guide that learns from what users record.',
        problem: 'Observations live in notebooks nobody can search.'
      }
    });

    const after = await api.post(`/api/projects/${project.id}/prompts/generate`).send({ purpose: 'Research' });
    expect(after.body.data.readiness.ready).toBe(true);
    expect(after.body.data.readiness.missingRequired).toEqual([]);
    expect(after.body.data.draft.content).toContain('A field guide that learns');
    expect(after.body.data.draft.content).toContain('Observations live in notebooks');
  });
});

// ---------------------------------------------------------------------------
// 12-13. Relations and reuse
// ---------------------------------------------------------------------------

describe('12. a prompt related to a task', () => {
  it('keeps the task link through reads and a copy inside the same project', async () => {
    const project = await createProject(uniqueName('Task'));
    const task = await api.post(`/api/projects/${project.id}/tasks`).send({ title: 'Wire the prompt modal' });
    expect(task.status).toBe(201);

    const prompt = await createPrompt(project.id, {
      title: 'Modal copy',
      taskId: task.body.data.id,
      text: 'Draft the modal copy from the recorded tone.'
    });

    const read = await api.get(`/api/projects/${project.id}/prompts/${prompt.id}`);
    expect(read.status).toBe(200);
    expect(read.body.data.task).toMatchObject({ id: task.body.data.id, code: task.body.data.code });

    const copy = await api.post(`/api/projects/${project.id}/prompts/${prompt.id}/copy`).send({});
    expect(copy.status).toBe(201);
    expect(copy.body.data.taskId).toBe(task.body.data.id); // same project: link kept
    expect(copy.body.data.id).not.toBe(prompt.id);
    expect(copy.body.data.status).toBe('DRAFT');

    const copyHistory = await promptWithHistory(copy.body.data.id);
    expect(copyHistory.versions).toHaveLength(1);
    expect(copyHistory.versions[0]!.changes).toBe(`Copied from ${prompt.code}`);
  });
});

describe('13. copy into another existing project', () => {
  it('moves reusable content across projects with a fresh code and safe links', async () => {
    const sourceProject = await createProject(uniqueName('Src'));
    const targetProject = await createProject(uniqueName('Tgt'));
    const task = await api.post(`/api/projects/${sourceProject.id}/tasks`).send({ title: 'Source task' });
    const prompt = await createPrompt(sourceProject.id, {
      title: 'Reusable investigation',
      purpose: 'Debugging',
      category: 'Troubleshooting',
      isReusable: true,
      taskId: task.body.data.id,
      text: 'Investigate using only recorded issues and notes.'
    });

    const copied = await api
      .post(`/api/projects/${sourceProject.id}/prompts/${prompt.id}/copy`)
      .send({ targetProjectId: targetProject.id });
    expect(copied.status).toBe(201);
    expect(copied.body.data.projectId).toBe(targetProject.id);
    expect(copied.body.data.code).toMatch(/^PROMPT-\d{3,}$/);
    expect(copied.body.data.content).toBe(prompt.content);
    expect(copied.body.data.purpose).toBe('Debugging');
    expect(copied.body.data.status).toBe('DRAFT');
    // A task id of the source project would dangle in the target.
    expect(copied.body.data.taskId).toBeNull();

    const history = await promptWithHistory(copied.body.data.id);
    expect(history.versions).toHaveLength(1);
    expect(history.versions[0]!.text).toBe(prompt.content);

    const missing = await api
      .post(`/api/projects/${sourceProject.id}/prompts/${prompt.id}/copy`)
      .send({ targetProjectId: 999999999 });
    expect(missing.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 14. Synchronization conflict on a prompt field
// ---------------------------------------------------------------------------

describe('14. synchronization conflict', () => {
  it('holds a prompt both sides changed until it is resolved, then keeps the invariant', async () => {
    const project = await createProject(uniqueName('Conflict'), { description: 'Start.' });
    const prompt = await createPrompt(project.id, { title: 'Conflict subject', text: 'Baseline text' });
    await regenerate(project.id); // document, record and baseline all agree

    // Both sides move: the app edits the prompt, the document edits the detail.
    const edited = await api
      .put(`/api/projects/${project.id}/prompts/${prompt.id}`)
      .send({ text: 'Database text' });
    expect(edited.status).toBe(200);
    await writeDoc(project, (await readDoc(project)).replace('Baseline text', 'Document text'));

    const st = await status(project.id);
    expect(st.status).toBe(200);
    const conflictName = `prompts:${prompt.code}.content`;
    expect(st.body.data.sync.conflictFields).toEqual([conflictName]);
    expect(st.body.data.sync.conflicts[0]).toMatchObject({
      scope: 'record',
      entity: 'prompts',
      key: prompt.code,
      field: 'content',
      baseline: 'Baseline text',
      databaseValue: 'Database text',
      markdownValue: 'Document text'
    });

    // Synchronizing while the conflict stands writes nothing.
    const refused = await sync(project.id);
    expect(refused.body.data.applied).toBeNull();
    expect((await prisma.prompt.findUnique({ where: { id: prompt.id } }))!.content).toBe('Database text');

    // Keep PROJECT.md: the document's value is written and versioned.
    const kept = await resolve(project.id, [
      { scope: 'record', entity: 'prompts', key: prompt.code, field: 'content', choice: 'markdown' }
    ]);
    expect(kept.status).toBe(200);

    const stored = await promptWithHistory(prompt.id);
    expect(stored.content).toBe('Document text');
    expect(stored.versions).toHaveLength(3); // create, app edit, resolution
    expect(stored.versions[2]!.text).toBe('Document text');

    const settled = await status(project.id);
    expect(settled.body.data.sync.conflicts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 15. Database safety
// ---------------------------------------------------------------------------

describe('15. database safety', () => {
  it('leaves every pre-existing project, task, note and prompt byte-identical', async () => {
    // The same hash taken in beforeAll, recomputed with only this suite's own
    // fixtures removed: any edit, deletion or reordering of pre-existing data
    // anywhere in the suite would change it. afterAll compares it once more
    // after the fixtures are cleaned up.
    const during = await safetyFingerprint(createdProjectIds);
    expect(during).toBe(safetyBefore);
    expect(createdProjectIds.length).toBeGreaterThan(0);
  });
});
