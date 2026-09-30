import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { api, prisma } from './helpers';
import { PROJECTS_ROOT_KEY } from '../src/lib/settings';
import {
  createProjectWithWorkspace,
  prepareProjectWorkspace
} from '../src/lib/projectCreation';
import { isInsideRoot, toSafeFolderName } from '../src/lib/projectWorkspace';

const WINDOWS_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

/**
 * Phase 3: project record <-> physical workspace folder.
 *
 * Every test sets the Projects Root to a throwaway directory made with
 * `fs.mkdtemp` under the OS temp folder. The user's real Projects Root is never
 * used, and no test project is ever created inside the user's actual project
 * workspace.
 *
 * Projects created here are removed in `afterAll` together with their folders,
 * and every project row that existed before the suite is fingerprinted before
 * and after so the claim "existing projects are untouched" is an assertion
 * rather than a promise.
 */

const tmpRoots: string[] = [];
const createdProjectIds: number[] = [];
const createdFolders: string[] = [];

/**
 * Fingerprint of every project that existed before this suite ran.
 * `exclude` lets the mid-suite check ignore projects this suite created, which
 * are cleaned up in afterAll anyway.
 */
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

async function makeRoot(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'phub-p3root-'));
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

beforeAll(async () => {
  before = await projectFingerprint();
  root = await makeRoot();
  await setRoot(root);
});

afterAll(async () => {
  // Remove only what this suite created.
  for (const id of createdProjectIds) {
    await prisma.activityEvent.deleteMany({ where: { projectId: id } });
    await prisma.tagAssignment.deleteMany({ where: { taggableType: 'project', taggableId: id } });
    await prisma.project.deleteMany({ where: { id } });
  }
  for (const dir of createdFolders) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  for (const dir of tmpRoots) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  await clearRoot();

  // The Projects Root setting is empty again and pre-existing projects are
  // byte-identical to the fingerprint taken before the suite.
  expect(await projectFingerprint()).toBe(before);
  expect(await prisma.appSetting.count({ where: { key: PROJECTS_ROOT_KEY } })).toBe(0);
});

beforeEach(async () => {
  await setRoot(root);
});

/** Create through the real API and clean up afterwards. */
async function createViaApi(name: string, extra: Record<string, unknown> = {}) {
  const res = await api.post('/api/projects').send({ name, ...extra });
  if (res.status === 201) {
    createdProjectIds.push(res.body.data.id);
    if (res.body.data.folderPath) createdFolders.push(res.body.data.folderPath);
  }
  return res;
}

describe('1-6. creating a project creates a matching folder', () => {
  it('creates the database record, the folder, and links them', async () => {
    const name = 'NODIA';
    const res = await createViaApi(name);

    expect(res.status).toBe(201);
    const project = res.body.data;

    // 2. the record exists
    const inDb = await prisma.project.findUnique({ where: { id: project.id } });
    expect(inDb).not.toBeNull();

    // 4. status is IDEA, not BUILDING: a folder is not development activity
    expect(project.stage).toBe('IDEA');

    // 5. the stored path is the real path
    const expected = path.join(root, name);
    expect(project.folderPath).toBe(expected);
    expect(project.folderName).toBe(name);

    // 3 and 6. the folder exists at exactly the stored path
    expect((await fsp.stat(project.folderPath)).isDirectory()).toBe(true);

    // and the folder starts empty: no PROJECT.md, no STATUS.md
    expect(await fsp.readdir(project.folderPath)).toEqual([]);
  });

  it('accepts a name with spaces and keeps it verbatim', async () => {
    const name = 'My Trading Bot V2';
    const res = await createViaApi(name);
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe(name);
    expect(res.body.data.folderName).toBe(name);
    expect((await fsp.stat(path.join(root, name))).isDirectory()).toBe(true);
  });

  it('makes each project independent', async () => {
    const a = await createViaApi('Alpha Project');
    const b = await createViaApi('Beta Project');
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.data.id).not.toBe(b.body.data.id);
    expect(a.body.data.folderPath).not.toBe(b.body.data.folderPath);
    expect((await fsp.stat(a.body.data.folderPath)).isDirectory()).toBe(true);
    expect((await fsp.stat(b.body.data.folderPath)).isDirectory()).toBe(true);
  });

  it('keeps optional fields when they are supplied', async () => {
    const res = await createViaApi('Rich Project', { description: 'Kept for later', v1Scope: 'v1 scope text' });
    expect(res.status).toBe(201);
    const p = await prisma.project.findUnique({ where: { id: res.body.data.id } });
    expect(p?.description).toBe('Kept for later');
    expect(p?.v1Scope).toBe('v1 scope text');
  });
});

describe('7. a missing Projects Root is rejected', () => {
  it('refuses to create the project and creates no folder', async () => {
    await clearRoot();
    const res = await createViaApi('No Root Project');
    expect(res.status).toBe(409);
    expect(res.body.error.details.code).toBe('PROJECTS_ROOT_NOT_CONFIGURED');
    expect(res.body.error.possibleAction).toMatch(/Settings/i);

    // No project record, and nothing written anywhere.
    expect(await prisma.project.count({ where: { name: 'No Root Project' } })).toBe(0);
    expect(await fsp.readdir(root)).not.toContain('No Root Project');
  });

  it('refuses when the Projects Root folder has been deleted', async () => {
    const gone = await makeRoot();
    await setRoot(gone);
    await fsp.rm(gone, { recursive: true, force: true });

    const res = await createViaApi('Vanished Root Project');
    expect(res.status).toBe(409);
    expect(res.body.error.details.code).toBe('PROJECTS_ROOT_UNUSABLE');
    expect(await prisma.project.count({ where: { name: 'Vanished Root Project' } })).toBe(0);
  });
});

describe('8. invalid project names are rejected', () => {
  it('rejects an empty or whitespace-only name', async () => {
    const beforeDirs = (await fsp.readdir(root)).sort();
    for (const name of ['', '   ', '\t']) {
      const res = await createViaApi(name);
      expect(res.status).toBe(400);
    }
    // Nothing new appeared on disk.
    expect((await fsp.readdir(root)).sort()).toEqual(beforeDirs);
  });

  it('rejects a name made only of characters that cannot be used in a folder', async () => {
    const res = await createViaApi('///');
    expect(res.status).toBe(400);
  });
});

describe('9-10. path traversal and absolute path injection are rejected', () => {
  const hostile = [
    '..',
    '../escape',
    '..\\escape',
    '../../../../Windows',
    'C:\\Windows\\System32',
    'D:\\another-place',
    '\\\\server\\share\\evil',
    'foo/../../bar',
    '/etc/passwd'
  ];

  for (const name of hostile) {
    it(`refuses the name ${JSON.stringify(name)} and stays inside the root`, async () => {
      const res = await createViaApi(name);
      if (res.status === 201) {
        // A partly-hostile name is reduced to a safe segment that still lives
        // inside the Projects Root: the display name is kept, the folder is safe.
        const p = res.body.data;
        expect(isInsideRoot(root, p.folderPath), `${name} escaped to ${p.folderPath}`).toBe(true);
        expect(path.dirname(p.folderPath)).toBe(path.resolve(root));
        expect(p.name).toBe(name);
      } else if (res.status === 409) {
        // Two different hostile names can reduce to the same safe segment, and
        // the second one then collides with the folder the first one made. That
        // is correct: the user is told, and nothing is overwritten.
        expect(res.body.error.details.code).toBe('WORKSPACE_ALREADY_EXISTS');
      } else {
        expect(res.status).toBe(400);
      }
      // Critically: nothing was created outside the Projects Root.
      for (const probe of [path.join(os.tmpdir(), 'escape'), path.join(path.resolve(root), '..', 'escape')]) {
        expect((await fsp.stat(probe).catch(() => null)), `${probe} should not exist`).toBeNull();
      }
    });
  }

  it('cannot be tricked by a name that resolves outside the root', () => {
    expect(isInsideRoot(root, path.join(root, 'child'))).toBe(true);
    expect(isInsideRoot(root, path.join(root, 'a', 'b', 'c'))).toBe(true);
    // A sibling that merely shares a string prefix is NOT inside the root.
    expect(isInsideRoot(root, root + 'Other')).toBe(false);
    expect(isInsideRoot(root, path.join(root, '..', 'elsewhere'))).toBe(false);
    // The root itself is not "inside" the root.
    expect(isInsideRoot(root, root)).toBe(false);
    // A prefix of the root is not inside it either.
    expect(isInsideRoot(path.join(root, 'deeper'), root)).toBe(false);
  });

  it('treats Windows path comparison case-insensitively', () => {
    if (process.platform !== 'win32') return;
    expect(isInsideRoot('D:\\Projects', 'd:\\projects\\nodia')).toBe(true);
    expect(isInsideRoot('D:\\Projects', 'D:\\ProjectsOther\\nodia')).toBe(false);
  });
});

describe('11-12. collisions are handled and nothing pre-existing is ever deleted', () => {
  it('refuses to overwrite an existing folder and leaves it untouched', async () => {
    const name = 'Collision Project';
    const target = path.join(root, name);
    await fsp.mkdir(target);
    const keeper = path.join(target, 'precious.txt');
    await fsp.writeFile(keeper, 'do not delete me', 'utf8');

    const res = await createViaApi(name);
    expect(res.status).toBe(409);
    expect(res.body.error.details.code).toBe('WORKSPACE_ALREADY_EXISTS');
    expect(res.body.error.category).toBe('CONFLICT');
    expect(res.body.error.possibleAction).toBeTruthy();

    // 12. the pre-existing folder and its contents survive untouched
    expect((await fsp.stat(target)).isDirectory()).toBe(true);
    expect(await fsp.readFile(keeper, 'utf8')).toBe('do not delete me');
    expect(await fsp.readdir(target)).toEqual(['precious.txt']);

    // and no project record was created
    expect(await prisma.project.count({ where: { name } })).toBe(0);
  });

  it('refuses to claim an existing empty folder', async () => {
    const name = 'Empty But Existing';
    await fsp.mkdir(path.join(root, name));
    const res = await createViaApi(name);
    expect(res.status).toBe(409);
    expect((await fsp.stat(path.join(root, name))).isDirectory()).toBe(true);
  });

  it('refuses when a file occupies the target path', async () => {
    const name = 'File In The Way';
    await fsp.writeFile(path.join(root, name), 'a file', 'utf8');
    const res = await createViaApi(name);
    expect(res.status).toBe(409);
    expect(res.body.error.details.kind).toBe('file');
    expect(await fsp.readFile(path.join(root, name), 'utf8')).toBe('a file');
  });

  it('refuses when a symlink occupies the target path', async () => {
    const name = 'Linked Folder';
    const real = await makeRoot();
    try {
      await fsp.symlink(real, path.join(root, name), 'junction');
    } catch {
      return; // symlink creation not permitted here; nothing to assert
    }
    const res = await createViaApi(name);
    expect(res.status).toBe(409);
    expect(res.body.error.details.kind).toBe('symlink');
    // the link target is still there and still empty
    expect(await fsp.readdir(real)).toEqual([]);
  });

  it('does not silently invent a NODIA2 style name', async () => {
    const name = 'No Suffix Please';
    await fsp.mkdir(path.join(root, name));
    const res = await createViaApi(name);
    expect(res.status).toBe(409);
    // No alternative folder was created next to it.
    const entries = await fsp.readdir(root);
    expect(entries.filter(e => e.toLowerCase().startsWith('no suffix'))).toEqual([name]);
  });
});

describe('13-14. partial failure and rollback', () => {
  it('removes the folder it created when the database write fails', async () => {
    const name = 'Rollback Clean';
    const target = path.join(root, name);

    await expect(
      createProjectWithWorkspace({ name }, async () => {
        throw new Error('simulated database failure');
      })
    ).rejects.toThrow('simulated database failure');

    // The folder this call created is gone again.
    expect(await fsp.stat(target).catch(() => null)).toBeNull();
    // And nothing was recorded.
    expect(await prisma.project.count({ where: { name } })).toBe(0);
  });

  it('never removes a folder it did not create', async () => {
    const name = 'Preexisting Survivor';
    const target = path.join(root, name);
    await fsp.mkdir(target);
    const keeper = path.join(target, 'user-file.txt');
    await fsp.writeFile(keeper, 'mine', 'utf8');

    // Force the collision check to be bypassed by pointing at the pre-existing
    // folder directly: createProjectWithWorkspace must still refuse rather than
    // treating a pre-existing folder as its own.
    await expect(
      createProjectWithWorkspace({ name }, async () => {
        throw new Error('should never be called');
      })
    ).rejects.toMatchObject({ status: 409 });

    expect(await fsp.readFile(keeper, 'utf8')).toBe('mine');
    expect(await fsp.readdir(target)).toEqual(['user-file.txt']);
  });

  it('reports the partial state when cleanup cannot finish', async () => {
    const name = 'Rollback Blocked';
    const target = path.join(root, name);

    // The folder is created, then something appears inside it before the
    // database write fails. rmdir refuses a non-empty folder, which is exactly
    // the situation where deleting recursively would destroy a user's file.
    const cleanup = await (async () => {
      const { createWorkspaceFolder } = await import('../src/lib/projectWorkspace');
      const created = await createWorkspaceFolder(target);
      expect(created.createdByUs).toBe(true);
      await fsp.writeFile(path.join(target, 'appeared.txt'), 'not ours', 'utf8');
      const { removeEmptyCreatedFolder } = await import('../src/lib/projectWorkspace');
      return removeEmptyCreatedFolder(target);
    })();

    expect(cleanup.removed).toBe(false);
    expect(cleanup.reason).toBe('the folder is no longer empty');

    // The user is told the folder is still there rather than being told all is well.
    const err = await createProjectWithWorkspace({ name: 'Rollback Blocked 2' }, async () => {
      const dir = path.join(root, 'Rollback Blocked 2');
      await fsp.writeFile(path.join(dir, 'intruder.txt'), 'x', 'utf8');
      throw new Error('simulated database failure');
    }).catch(e => e as { status?: number; details?: Record<string, unknown>; category?: string });

    expect(err.category).toBe('FILESYSTEM_ERROR');
    expect(err.details?.code).toBe('PARTIAL_STATE_FOLDER_LEFT');
    expect(err.details?.cleanupReason).toBe('the folder is no longer empty');
    // the folder and its contents are still there, unharmed
    expect(await fsp.readFile(path.join(target, 'appeared.txt'), 'utf8')).toBe('not ours');
    await fsp.rm(path.join(root, 'Rollback Blocked 2'), { recursive: true, force: true });
  });
});

describe('15. existing projects are untouched', () => {
  it('left every pre-existing project exactly as it was', async () => {
    expect(await projectFingerprint(createdProjectIds)).toBe(before);
  });

  it('left existing projects without a folder and did not backfill any', async () => {
    const legacy = await prisma.project.findMany({ where: { id: { notIn: createdProjectIds } } });
    expect(legacy.length).toBeGreaterThan(0);
    for (const p of legacy) {
      expect(p.folderPath).toBeNull();
      expect(p.folderName).toBeNull();
    }
  });
});

describe('16-20. naming', () => {
  it('produces a safe folder name and documents the difference', () => {
    // Windows-invalid characters become hyphens; the display name is untouched.
    expect(toSafeFolderName('My Trading Bot: V2')).toBe('My Trading Bot- V2');
    expect(toSafeFolderName('a<b>c|d?e*f"g')).toBe('a-b-c-d-e-f-g');
    expect(toSafeFolderName('Phase 3 Test Project')).toBe('Phase 3 Test Project');
  });

  it('keeps spaces and hyphens, because they are legal and readable', () => {
    expect(toSafeFolderName('two words')).toBe('two words');
    expect(toSafeFolderName('well-named-project')).toBe('well-named-project');
  });

  it('escapes reserved Windows device names', () => {
    for (const name of ['CON', 'nul', 'Com1', 'aux', 'LPT9', 'NUL.txt']) {
      const safe = toSafeFolderName(name);
      expect(safe, `${name} must change`).not.toBe(name);
      // The stem before the first dot must no longer be a device name, which
      // is why the suffix goes before the extension.
      expect(WINDOWS_DEVICE_NAMES.has(safe.split('.')[0].toLowerCase())).toBe(false);
    }
    // The display name is never rewritten; only the folder is.
    expect(toSafeFolderName('NUL.txt')).toBe('NUL-project.txt');
  });

  it('trims trailing dots and spaces Windows would strip', () => {
    expect(toSafeFolderName('trailing dots...')).toBe('trailing dots');
    expect(toSafeFolderName('trailing space   ')).toBe('trailing space');
  });

  it('handles an excessively long name without breaking', () => {
    const long = 'Very Long Project Name '.repeat(20).trim();
    const safe = toSafeFolderName(long);
    expect(safe.length).toBeLessThanOrEqual(100);
    expect(safe.length).toBeGreaterThan(0);
    expect(safe).not.toMatch(/[. ]$/);
  });

  it('rejects a name with no usable characters', () => {
    expect(() => toSafeFolderName('   ')).toThrow();
    expect(() => toSafeFolderName('')).toThrow();
    expect(() => toSafeFolderName('///')).toThrow();
  });

  it('creates the folder under a transformed name while keeping the display name', async () => {
    const name = 'Bot: V2 (final)';
    const res = await createViaApi(name);
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe(name);
    expect(res.body.data.folderName).not.toBe(name);
    expect(path.dirname(res.body.data.folderPath)).toBe(path.resolve(root));
    expect((await fsp.stat(res.body.data.folderPath)).isDirectory()).toBe(true);
  });
});

describe('workspace preview endpoint', () => {
  it('reports the resolved path without creating anything', async () => {
    const res = await api
      .post('/api/projects/preview-workspace')
      .send({ name: 'Preview Only Project' })
      .expect(200);
    expect(res.body.data.folderPath).toBe(path.join(root, 'Preview Only Project'));
    expect(res.body.data.willCreate).toBe(true);
    // nothing was created
    expect(await fsp.stat(path.join(root, 'Preview Only Project')).catch(() => null)).toBeNull();
    expect(await prisma.project.count({ where: { name: 'Preview Only Project' } })).toBe(0);
  });

  it('reports the collision before the user commits', async () => {
    const name = 'Preview Collision';
    await fsp.mkdir(path.join(root, name));
    const res = await api.post('/api/projects/preview-workspace').send({ name }).expect(409);
    expect(res.body.error.details.code).toBe('WORKSPACE_ALREADY_EXISTS');
  });

  it('surfaces a bad name before the user commits', async () => {
    await api.post('/api/projects/preview-workspace').send({ name: '   ' }).expect(400);
  });
});

describe('workspace status endpoint', () => {
  it('reports the stored workspace and whether it still exists', async () => {
    const res = await createViaApi('Status Project');
    const id = res.body.data.id;
    const status = await api.get(`/api/projects/${id}/workspace`).expect(200);
    expect(status.body.data.hasWorkspace).toBe(true);
    expect(status.body.data.folderPath).toBe(res.body.data.folderPath);
    expect(status.body.data.exists).toBe(true);
    expect(status.body.data.isDirectory).toBe(true);
  });

  it('reports a workspace that has since been deleted from disk', async () => {
    const res = await createViaApi('Vanished Workspace');
    const id = res.body.data.id;
    await fsp.rm(res.body.data.folderPath, { recursive: true, force: true });
    const status = await api.get(`/api/projects/${id}/workspace`).expect(200);
    expect(status.body.data.hasWorkspace).toBe(true);
    expect(status.body.data.exists).toBe(false);
  });

  it('explains a vanished folder in project terms, not Projects Root terms', async () => {
    const res = await createViaApi('Explaining Workspace');
    await fsp.rmdir(res.body.data.folderPath);
    const status = await api.get(`/api/projects/${res.body.data.id}/workspace`).expect(200);
    const notFound = status.body.data.problems.find((x: { code: string }) => x.code === 'PATH_NOT_FOUND');
    expect(notFound).toBeDefined();
    // The Settings page owns the "Create folder" button for the Projects Root.
    // A project workspace has no such control, so pointing at it is a dead end.
    expect(notFound.possibleAction).not.toMatch(/Create folder/i);
    expect(notFound.possibleAction).toMatch(/outside Project Hub/i);
  });

  it('reports no workspace for a project that never had one', async () => {
    const legacy = await prisma.project.findFirst({ where: { id: { notIn: createdProjectIds } } });
    expect(legacy).not.toBeNull();
    const status = await api.get(`/api/projects/${legacy!.id}/workspace`).expect(200);
    expect(status.body.data.hasWorkspace).toBe(false);
    expect(status.body.data.folderPath).toBeNull();
  });
});

describe('preview helper parity', () => {
  it('resolves the same path the API resolves', async () => {
    const preview = await prepareProjectWorkspace('Parity Check');
    expect(preview.folderPath).toBe(path.join(root, 'Parity Check'));
    expect(isInsideRoot(root, preview.folderPath)).toBe(true);
  });
});
