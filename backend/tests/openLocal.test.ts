import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { api, createProject, destroyProject, prisma } from './helpers';
import { resolveProjectFolderForOpening } from '../src/lib/openLocal';

/**
 * Open Folder / Open in VS Code.
 *
 * The launchers themselves (explorer.exe, Code.exe) are deliberately NOT
 * invoked here - a test run must not scatter real windows across the machine,
 * and the success path is verified manually against live projects instead.
 * What is tested is everything that decides *whether* a launch may happen and
 * *which* folder it would get, which is the security boundary: no endpoint may
 * launch a folder that is not the project's own, inside the Projects Root, and
 * still present on disk.
 */

async function setFolderPath(id: number, folderPath: string | null, folderName: string | null = null) {
  await prisma.project.update({ where: { id }, data: { folderPath, folderName } });
}

describe('open-local: folder resolution', () => {
  it('resolves the real workspace folder of a freshly created project', async () => {
    const project = await createProject('OpenLocal Resolve');
    try {
      const full = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      expect(full.folderPath).toBeTruthy();

      const resolved = await resolveProjectFolderForOpening(full);
      expect(resolved.available).toBe(true);
      if (resolved.available) {
        expect(path.resolve(resolved.folderPath)).toBe(path.resolve(full.folderPath!));
      }
    } finally {
      await destroyProject(project.id);
    }
  });

  it('resolves different folders for different projects', async () => {
    const a = await createProject('OpenLocal A');
    const b = await createProject('OpenLocal B');
    try {
      const fullA = await prisma.project.findUniqueOrThrow({ where: { id: a.id } });
      const fullB = await prisma.project.findUniqueOrThrow({ where: { id: b.id } });
      const ra = await resolveProjectFolderForOpening(fullA);
      const rb = await resolveProjectFolderForOpening(fullB);
      expect(ra.available && rb.available).toBe(true);
      if (ra.available && rb.available) {
        expect(ra.folderPath).not.toBe(rb.folderPath);
        expect(path.resolve(ra.folderPath).toLowerCase()).toBe(path.resolve(fullA.folderPath!).toLowerCase());
        expect(path.resolve(rb.folderPath).toLowerCase()).toBe(path.resolve(fullB.folderPath!).toLowerCase());
      }
    } finally {
      await destroyProject(a.id);
      await destroyProject(b.id);
    }
  });

  it('refuses a project with no folder configured', async () => {
    const project = await createProject('OpenLocal NoFolder');
    try {
      const full = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      await setFolderPath(project.id, null);
      const resolved = await resolveProjectFolderForOpening({ ...full, folderPath: null });
      expect(resolved.available).toBe(false);
      if (!resolved.available) {
        expect(resolved.reason).toBe('PROJECT_WORKSPACE_MISSING');
        expect(resolved.possibleAction).toBeTruthy();
      }
    } finally {
      await destroyProject(project.id);
    }
  });

  it('refuses a stored path outside the Projects Root', async () => {
    const project = await createProject('OpenLocal Outside');
    try {
      const full = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      const resolved = await resolveProjectFolderForOpening({
        ...full,
        folderPath: path.join(path.parse(process.cwd()).root, 'phub-should-never-open')
      });
      expect(resolved.available).toBe(false);
      if (!resolved.available) expect(resolved.reason).toBe('PROJECT_WORKSPACE_UNSAFE');
    } finally {
      await destroyProject(project.id);
    }
  });

  it('refuses a folder that no longer exists on disk, without creating it', async () => {
    const project = await createProject('OpenLocal Gone');
    try {
      const full = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      const root = path.dirname(full.folderPath!);
      const ghost = path.join(root, '__TEST__ gone folder');
      await setFolderPath(project.id, ghost, '__TEST__ gone folder');

      const resolved = await resolveProjectFolderForOpening({ ...full, folderPath: ghost });
      expect(resolved.available).toBe(false);
      if (!resolved.available) expect(resolved.reason).toBe('PROJECT_WORKSPACE_GONE');

      // The refusal must not have conjured the folder.
      await expect(api.get('/api/health')).resolves.toBeTruthy();
      const fs = await import('node:fs/promises');
      await expect(fs.lstat(ghost)).rejects.toThrow();
    } finally {
      await destroyProject(project.id);
    }
  });
});

describe('open-local: endpoints', () => {
  it('rejects project ids that do not exist', async () => {
    const res = await api.post('/api/projects/999999999/open-folder').send({});
    expect(res.status).toBe(404);
    const vscode = await api.post('/api/projects/999999999/open-vscode').send({});
    expect(vscode.status).toBe(404);
  });

  it('reports a clear message when the project has no folder', async () => {
    const project = await createProject('OpenLocal API NoFolder');
    try {
      await setFolderPath(project.id, null);
      const res = await api.post(`/api/projects/${project.id}/open-folder`).send({});
      expect(res.status).toBe(422);
      expect(res.body.error.category).toBe('DATA_MISSING');
      expect(res.body.error.message).toMatch(/no folder configured/i);
      expect(res.body.error.possibleAction).toBeTruthy();

      const vscode = await api.post(`/api/projects/${project.id}/open-vscode`).send({});
      expect(vscode.status).toBe(422);
      expect(vscode.body.error.message).toMatch(/no folder configured/i);
    } finally {
      await destroyProject(project.id);
    }
  });

  it('reports a clear message when the folder is missing from disk', async () => {
    const project = await createProject('OpenLocal API Gone');
    try {
      const full = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      const ghost = path.join(path.dirname(full.folderPath!), '__TEST__ api gone');
      await setFolderPath(project.id, ghost, '__TEST__ api gone');

      const res = await api.post(`/api/projects/${project.id}/open-folder`).send({});
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/no longer exists/i);
      expect(res.body.error.possibleAction).toMatch(/never recreates/i);
    } finally {
      await destroyProject(project.id);
    }
  });

  it('refuses a path outside the Projects Root instead of launching it', async () => {
    const project = await createProject('OpenLocal API Outside');
    try {
      await setFolderPath(project.id, path.join(path.parse(process.cwd()).root, 'Windows'), 'Windows');
      const res = await api.post(`/api/projects/${project.id}/open-folder`).send({});
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/inside the configured Projects Root/i);
    } finally {
      await destroyProject(project.id);
    }
  });

  it('accepts a key by slug as well as by id', async () => {
    const project = await createProject('OpenLocal Slug');
    try {
      const full = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      await setFolderPath(project.id, null);
      const res = await api.post(`/api/projects/${full.slug}/open-vscode`).send({});
      expect(res.status).toBe(422);
      expect(res.body.error.message).toMatch(/no folder configured/i);
    } finally {
      await destroyProject(project.id);
    }
  });
});
