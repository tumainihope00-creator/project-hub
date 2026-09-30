import 'dotenv/config';
import { afterAll, beforeAll } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import { PROJECTS_ROOT_KEY } from '../src/lib/settings';

process.env.NODE_ENV = 'test';

/**
 * Every test file gets a throwaway Projects Root.
 *
 * Phase 3 made `POST /api/projects` require a usable Projects Root, because a
 * project record and its workspace folder are now created together. Without
 * this, `createProject()` in `tests/helpers.ts` returned 409 and the `api` and
 * `promptGenerator` suites could not run at all.
 *
 * The root is a `fs.mkdtemp` directory under the OS temp folder, so no test can
 * ever create a workspace folder inside the user's real project workspace. It
 * is removed, and the previous setting restored, when the file finishes.
 *
 * This is still not test-database isolation: the suites below continue to run
 * against the live `projecthub` database, and `import.test.ts` in particular
 * creates and hard-deletes real project rows. A disposable test schema remains
 * open work.
 */

let testRoot: string | null = null;
let previousValue: string | null = null;
let hadPrevious = false;

beforeAll(async () => {
  const existing = await prisma.appSetting.findUnique({ where: { key: PROJECTS_ROOT_KEY } });
  hadPrevious = existing !== null;
  previousValue = existing?.value ?? null;

  testRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'phub-testroot-'));
  await prisma.appSetting.upsert({
    where: { key: PROJECTS_ROOT_KEY },
    create: { key: PROJECTS_ROOT_KEY, value: testRoot },
    update: { value: testRoot }
  });
});

afterAll(async () => {
  // Restore whatever was configured before, rather than assuming it was empty.
  if (hadPrevious && previousValue) {
    await prisma.appSetting.upsert({
      where: { key: PROJECTS_ROOT_KEY },
      create: { key: PROJECTS_ROOT_KEY, value: previousValue },
      update: { value: previousValue }
    });
  } else {
    await prisma.appSetting.deleteMany({ where: { key: PROJECTS_ROOT_KEY } });
  }

  if (testRoot) {
    await fsp.rm(testRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});
