import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { api, prisma } from './helpers';
import { PROJECTS_ROOT_KEY } from '../src/lib/settings';

/**
 * Projects Root (Phase 2) settings.
 *
 * Every filesystem check in this file runs against a throwaway directory made
 * under the OS temp folder with `fs.mkdtemp`. The suite never touches the real
 * Projects Root, never creates anything in the user's project workspace, and
 * removes every directory it made.
 *
 * The suite also fingerprints every project row before and after, so the claim
 * "this feature changes no project data" is an assertion rather than a promise.
 */

const tmpRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `phub-projectsroot-${prefix}-`));
  tmpRoots.push(dir);
  return dir;
}

async function makeTempFile(): Promise<string> {
  const file = path.join(await makeTempDir('file'), 'not-a-folder.txt');
  await fsp.writeFile(file, 'this is a file, not a folder\n', 'utf8');
  return file;
}

/** A stable fingerprint of all project-owned data, used to prove nothing moved. */
async function projectFingerprint() {
  const projects = await prisma.project.findMany({ orderBy: { id: 'asc' } });
  const children = await Promise.all([
    prisma.task.count(),
    prisma.issue.count(),
    prisma.feature.count(),
    prisma.requirement.count(),
    prisma.milestone.count(),
    prisma.researchEntry.count(),
    prisma.researchQuestion.count(),
    prisma.architectureDecision.count(),
    prisma.techStackItem.count(),
    prisma.note.count(),
    prisma.activityEvent.count(),
    prisma.prompt.count(),
    prisma.deployment.count(),
    prisma.tagAssignment.count()
  ]);
  return JSON.stringify({
    projects: projects.map(p => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      stage: p.stage,
      description: p.description,
      problem: p.problem,
      v1Scope: p.v1Scope,
      originalIdea: p.originalIdea,
      repositoryUrl: p.repositoryUrl,
      isArchived: p.isArchived,
      archivedAt: p.archivedAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString()
    })),
    children
  });
}

let before: string | null = null;

/** Start every test from the documented empty state. */
async function resetSetting() {
  await prisma.appSetting.deleteMany({ where: { key: PROJECTS_ROOT_KEY } });
}

beforeAll(async () => {
  before = await projectFingerprint();
});

afterAll(async () => {
  // Leave the database exactly as this suite found it.
  await prisma.appSetting.deleteMany({ where: { key: PROJECTS_ROOT_KEY } });
  for (const dir of tmpRoots) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  expect(await projectFingerprint()).toBe(before);
});

describe('Projects Root: unconfigured state', () => {
  it('reports that no Projects Root is configured', async () => {
    await resetSetting();
    const res = await api.get('/api/settings/projects-root').expect(200);
    expect(res.body.data.configured).toBe(false);
    expect(res.body.data.path).toBeNull();
    expect(res.body.data.key).toBe(PROJECTS_ROOT_KEY);
    expect(res.body.data.usable).toBe(false);
    expect(res.body.data.problems).toEqual([]);
  });

  it('refuses to test a connection when nothing is configured', async () => {
    await resetSetting();
    const res = await api.post('/api/settings/projects-root/test').send({}).expect(400);
    expect(res.body.error.category).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.code).toBe('PATH_EMPTY');
  });

  it('refuses to create a folder when nothing is configured', async () => {
    await resetSetting();
    const res = await api.post('/api/settings/projects-root/initialize').send({}).expect(400);
    expect(res.body.error.details.code).toBe('PATH_EMPTY');
  });
});

describe('Projects Root: rejecting bad input', () => {
  it('rejects a missing path', async () => {
    await resetSetting();
    const res = await api.put('/api/settings/projects-root').send({}).expect(400);
    expect(res.body.error.category).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.code).toBe('PATH_EMPTY');
  });

  it('rejects an empty or whitespace-only path', async () => {
    for (const path of ['', '   ', '\t']) {
      const res = await api.put('/api/settings/projects-root').send({ path }).expect(400);
      expect(res.body.error.details.code).toBe('PATH_EMPTY');
    }
  });

  it('rejects a relative path', async () => {
    const res = await api.put('/api/settings/projects-root').send({ path: 'Projects' }).expect(400);
    expect(res.body.error.details.code).toBe('PATH_RELATIVE');
    expect(res.body.error.message).toMatch(/absolute/i);
  });

  it('rejects a nested relative path', async () => {
    const res = await api.put('/api/settings/projects-root').send({ path: path.join('..', 'Projects') }).expect(400);
    expect(res.body.error.details.code).toBe('PATH_RELATIVE');
  });

  it('rejects a drive-relative Windows path such as D:Projects', async () => {
    const res = await api.put('/api/settings/projects-root').send({ path: 'D:Projects' }).expect(400);
    expect(res.body.error.details.code).toBe('PATH_RELATIVE');
  });

  it('rejects a path containing control characters', async () => {
    const res = await api.put('/api/settings/projects-root').send({ path: 'D:\\Pro\u0000jects' }).expect(400);
    expect(res.body.error.details.code).toBe('PATH_INVALID');
  });

  it('rejects an absurdly long path', async () => {
    const res = await api
      .put('/api/settings/projects-root')
      .send({ path: path.join(os.tmpdir(), 'x'.repeat(5000)) })
      .expect(400);
    expect(res.body.error.details.code).toBe('PATH_TOO_LONG');
  });

  it('rejects a Windows reserved device name as the final folder', async () => {
    const res = await api.put('/api/settings/projects-root').send({ path: path.join(os.tmpdir(), 'NUL') }).expect(400);
    expect(res.body.error.details.code).toBe('PATH_RESERVED_NAME');
  });

  it('rejects characters Windows does not allow in a folder name', async () => {
    for (const bad of ['<', '>', '"', '|', '?', '*', ':']) {
      const res = await api.put('/api/settings/projects-root').send({ path: path.join('D:\\', `Pro${bad}jects`) }).expect(400);
      expect(res.body.error.details.code, `expected ${bad} to be rejected`).toBe('PATH_INVALID');
    }
  });

  it('rejects a trailing dot or space in any folder name, not just the last', async () => {
    for (const bad of ['D:\\Projects.\\Sub', 'D:\\Projects \\Sub', 'D:\\Pro jects.']) {
      const res = await api.put('/api/settings/projects-root').send({ path: bad }).expect(400);
      expect(res.body.error.details.code, `expected ${bad} to be rejected`).toBe('PATH_TRAILING_DOT_OR_SPACE');
    }
  });

  it('still accepts a normal Windows path with spaces', async () => {
    await resetSetting();
    const dir = path.join(os.tmpdir(), 'My Projects 2026');
    tmpRoots.push(dir);
    await fsp.mkdir(dir, { recursive: true });
    const res = await api.put('/api/settings/projects-root').send({ path: dir }).expect(200);
    expect(res.body.data.path).toBe(dir);
  });

  it('rejects unknown request fields instead of ignoring them', async () => {
    const res = await api.put('/api/settings/projects-root').send({ path: os.tmpdir(), unexpected: true }).expect(400);
    expect(res.body.error.category).toBe('VALIDATION_FAILED');
  });

  it('never stored anything while rejecting input', async () => {
    await resetSetting();
    await api.put('/api/settings/projects-root').send({ path: 'relative/path' }).expect(400);
    expect(await prisma.appSetting.count({ where: { key: PROJECTS_ROOT_KEY } })).toBe(0);
  });
});

describe('Projects Root: saving and reading', () => {
  it('saves a valid absolute path', async () => {
    await resetSetting();
    const dir = await makeTempDir('save');
    const res = await api.put('/api/settings/projects-root').send({ path: dir }).expect(200);
    expect(res.body.data.configured).toBe(true);
    expect(res.body.data.path).toBe(dir);
    expect(res.body.data.exists).toBe(true);
    expect(res.body.data.isDirectory).toBe(true);
    expect(res.body.data.readable).toBe(true);
    expect(res.body.data.usable).toBe(true);
  });

  it('reads the saved path back', async () => {
    await resetSetting();
    const dir = await makeTempDir('read');
    await api.put('/api/settings/projects-root').send({ path: dir }).expect(200);
    const res = await api.get('/api/settings/projects-root').expect(200);
    expect(res.body.data.path).toBe(dir);
    expect(res.body.data.configured).toBe(true);
  });

  it('updates an existing path rather than adding a second row', async () => {
    await resetSetting();
    const first = await makeTempDir('first');
    const second = await makeTempDir('second');
    await api.put('/api/settings/projects-root').send({ path: first }).expect(200);
    const res = await api.put('/api/settings/projects-root').send({ path: second }).expect(200);
    expect(res.body.data.path).toBe(second);
    expect(await prisma.appSetting.count({ where: { key: PROJECTS_ROOT_KEY } })).toBe(1);
  });

  it('survives a restart by reading from the database, not memory', async () => {
    await resetSetting();
    const dir = await makeTempDir('persist');
    await api.put('/api/settings/projects-root').send({ path: dir }).expect(200);
    const row = await prisma.appSetting.findUnique({ where: { key: PROJECTS_ROOT_KEY } });
    expect(row?.value).toBe(dir);
  });

  it('stores one normalized form for equivalent paths', async () => {
    await resetSetting();
    const dir = await makeTempDir('normalize');
    const variants = [dir, `${dir}${path.sep}`, path.join(dir, '.', ''), path.join(dir, 'sub', '..'), `"${dir}"`];
    for (const variant of variants) {
      const res = await api.put('/api/settings/projects-root').send({ path: variant }).expect(200);
      expect(res.body.data.path).toBe(dir);
    }
    expect(await prisma.appSetting.count({ where: { key: PROJECTS_ROOT_KEY } })).toBe(1);
  });

  it('allows saving a folder that does not exist yet, and says so', async () => {
    await resetSetting();
    const dir = path.join(os.tmpdir(), `phub-projectsroot-missing-${Date.now()}`);
    const res = await api.put('/api/settings/projects-root').send({ path: dir }).expect(200);
    expect(res.body.data.path).toBe(dir);
    expect(res.body.data.exists).toBe(false);
    expect(res.body.data.usable).toBe(false);
    expect(res.body.data.problems.map((p: any) => p.code)).toContain('PATH_NOT_FOUND');
  });

  it('refuses to save a path that is a file', async () => {
    await resetSetting();
    const file = await makeTempFile();
    const res = await api.put('/api/settings/projects-root').send({ path: file }).expect(400);
    expect(res.body.error.details.code).toBe('PATH_NOT_DIRECTORY');
    expect(await prisma.appSetting.count({ where: { key: PROJECTS_ROOT_KEY } })).toBe(0);
  });
});

describe('Projects Root: testing a connection', () => {
  it('reports an existing, readable, writable folder', async () => {
    await resetSetting();
    const dir = await makeTempDir('test');
    await api.put('/api/settings/projects-root').send({ path: dir }).expect(200);
    const res = await api.post('/api/settings/projects-root/test').send({}).expect(200);
    expect(res.body.data.exists).toBe(true);
    expect(res.body.data.isDirectory).toBe(true);
    expect(res.body.data.readable).toBe(true);
    expect(res.body.data.writable).toBe(true);
    expect(res.body.data.writableTested).toBe(true);
    expect(res.body.data.usable).toBe(true);
    expect(res.body.data.problems).toEqual([]);
  });

  it('leaves no probe file behind', async () => {
    const dir = await makeTempDir('probe');
    await api.post('/api/settings/projects-root/test').send({ path: dir }).expect(200);
    expect(await fsp.readdir(dir)).toEqual([]);
  });

  it('reports that a file is not a folder', async () => {
    const file = await makeTempFile();
    const res = await api.post('/api/settings/projects-root/test').send({ path: file }).expect(200);
    expect(res.body.data.usable).toBe(false);
    expect(res.body.data.isDirectory).toBe(false);
    expect(res.body.data.problems.map((p: any) => p.code)).toContain('PATH_NOT_DIRECTORY');
  });

  it('reports a folder that does not exist yet', async () => {
    const dir = path.join(os.tmpdir(), `phub-projectsroot-absent-${Date.now()}`);
    const res = await api.post('/api/settings/projects-root/test').send({ path: dir }).expect(200);
    expect(res.body.data.exists).toBe(false);
    expect(res.body.data.usable).toBe(false);
    expect(res.body.data.problems.map((p: any) => p.code)).toContain('PATH_NOT_FOUND');
  });

  it('tests a draft path before it is saved, and saves nothing', async () => {
    await resetSetting();
    const dir = await makeTempDir('draft');
    const res = await api.post('/api/settings/projects-root/test').send({ path: dir }).expect(200);
    expect(res.body.data.path).toBe(dir);
    expect(res.body.data.usable).toBe(true);
    expect(await prisma.appSetting.count({ where: { key: PROJECTS_ROOT_KEY } })).toBe(0);
  });

  it('does not claim an unsaved path is configured', async () => {
    await resetSetting();
    const dir = await makeTempDir('honest');
    const tested = await api.post('/api/settings/projects-root/test').send({ path: dir }).expect(200);
    expect(tested.body.data.configured).toBe(false);

    const target = path.join(dir, 'not-yet');
    const created = await api.post('/api/settings/projects-root/initialize').send({ path: target }).expect(200);
    expect(created.body.data.created).toBe(true);
    expect(created.body.data.configured).toBe(false);

    // Only saving it makes it configured.
    const saved = await api.put('/api/settings/projects-root').send({ path: target }).expect(200);
    expect(saved.body.data.configured).toBe(true);
  });

  it('rejects a structurally invalid test path with a 400', async () => {
    const res = await api.post('/api/settings/projects-root/test').send({ path: 'not/absolute' }).expect(400);
    expect(res.body.error.details.code).toBe('PATH_RELATIVE');
  });

  it('always returns a structured result rather than crashing on odd input', async () => {
    const res = await api.post('/api/settings/projects-root/test').send({ path: '\u0000' });
    expect([200, 400]).toContain(res.status);
    expect(res.body.error?.category ?? res.body.data?.usable).toBeDefined();
  });
});

describe('Projects Root: creating the folder', () => {
  it('creates a missing folder on explicit request', async () => {
    await resetSetting();
    const base = await makeTempDir('init');
    const target = path.join(base, 'nested', 'Projects');
    tmpRoots.push(base);

    const saved = await api.put('/api/settings/projects-root').send({ path: target }).expect(200);
    expect(saved.body.data.exists).toBe(false);
    await expect(fsp.stat(target)).rejects.toBeTruthy();

    const res = await api.post('/api/settings/projects-root/initialize').send({}).expect(200);
    expect(res.body.data.created).toBe(true);
    expect(res.body.data.exists).toBe(true);
    expect(res.body.data.isDirectory).toBe(true);
    expect((await fsp.stat(target)).isDirectory()).toBe(true);
  });

  it('does not create anything when only saving', async () => {
    await resetSetting();
    const target = path.join(os.tmpdir(), `phub-projectsroot-nocreate-${Date.now()}`);
    await api.put('/api/settings/projects-root').send({ path: target }).expect(200);
    await expect(fsp.stat(target)).rejects.toBeTruthy();
  });

  it('is idempotent and reports created:false the second time', async () => {
    await resetSetting();
    const target = path.join(os.tmpdir(), `phub-projectsroot-idem-${Date.now()}`);
    tmpRoots.push(target);
    await api.put('/api/settings/projects-root').send({ path: target }).expect(200);

    const first = await api.post('/api/settings/projects-root/initialize').send({}).expect(200);
    expect(first.body.data.created).toBe(true);
    const second = await api.post('/api/settings/projects-root/initialize').send({}).expect(200);
    expect(second.body.data.created).toBe(false);
    expect(second.body.data.isDirectory).toBe(true);
  });

  it('refuses to create over a file', async () => {
    const file = await makeTempFile();
    const res = await api.post('/api/settings/projects-root/initialize').send({ path: file }).expect(400);
    expect(res.body.error.details.code).toBe('PATH_NOT_DIRECTORY');
    expect((await fsp.stat(file)).isFile()).toBe(true);
  });

  it('never deletes an existing folder or its contents', async () => {
    await resetSetting();
    const dir = await makeTempDir('keep');
    const keeper = path.join(dir, 'important.txt');
    await fsp.writeFile(keeper, 'do not delete me', 'utf8');

    await api.put('/api/settings/projects-root').send({ path: dir }).expect(200);
    await api.post('/api/settings/projects-root/initialize').send({}).expect(200);

    expect(await fsp.readFile(keeper, 'utf8')).toBe('do not delete me');
  });
});

describe('Projects Root: clearing', () => {
  it('forgets the setting without touching the folder on disk', async () => {
    const dir = await makeTempDir('clear');
    await api.put('/api/settings/projects-root').send({ path: dir }).expect(200);

    const res = await api.delete('/api/settings/projects-root').expect(200);
    expect(res.body.data.configured).toBe(false);
    expect(res.body.data.path).toBeNull();
    expect(await prisma.appSetting.count({ where: { key: PROJECTS_ROOT_KEY } })).toBe(0);

    expect((await fsp.stat(dir)).isDirectory()).toBe(true);
  });
});

describe('Projects Root: project data is untouched', () => {
  it('changed no project and no child record', async () => {
    expect(await projectFingerprint()).toBe(before);
  });
});
