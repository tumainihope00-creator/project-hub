/**
 * Manual end-to-end verification of Phase 3 against the REAL server
 * (http://localhost:4000) and the REAL filesystem. Nothing is mocked: the
 * Projects Root is set through the Phase 2 API, projects are created through
 * the normal POST /api/projects endpoint, and the resulting directories are
 * inspected on disk.
 *
 * Everything it creates, it removes again.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PrismaClient } from '@prisma/client';

const BASE = 'http://localhost:4000/api';
const prisma = new PrismaClient();
const created = [];

const call = async (method, url, body) => {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const step = (n, title) => console.log(`\n${'='.repeat(72)}\nSTEP ${n}. ${title}\n${'='.repeat(72)}`);
const show = (label, v) => console.log(`   ${label}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

const root = path.join(os.tmpdir(), 'ph-manual-' + Math.random().toString(36).slice(2, 10));
await fs.mkdir(root, { recursive: true });
console.log(`Projects Root under test: ${root}`);

try {
  // ---------------------------------------------------------------- 1
  step(1, 'Configure the Projects Root (Phase 2 API) and confirm the server can write there');
  const put = await call('PUT', '/settings/projects-root', { path: root });
  show('HTTP', put.status);
  show('configured', put.body.data.configured);
  show('path', put.body.data.path);
  show('exists / isDirectory / readable / writable / usable',
    [put.body.data.exists, put.body.data.isDirectory, put.body.data.readable, put.body.data.writable, put.body.data.usable].join(' / '));
  show('problems', put.body.data.problems);

  // ---------------------------------------------------------------- 2
  step(2, 'Preview a clean name and a name needing transformation');
  for (const name of ['Manual Verify Project', 'Rich: Project <v2>']) {
    const p = await call('POST', '/projects/preview-workspace', { name });
    show(`"${name}"`, `HTTP ${p.status} -> folderName=${JSON.stringify(p.body.data.folderName)} renamed=${p.body.data.renamed} folderPath=${JSON.stringify(p.body.data.folderPath)}`);
  }

  // ---------------------------------------------------------------- 3
  step(3, 'Create a project through the normal API (name only)');
  const made = await call('POST', '/projects', { name: 'Manual Verify Project' });
  show('HTTP', made.status);
  const p1 = made.body.data;
  created.push(p1.id);
  show('id / name / stage', `${p1.id} / ${p1.name} / ${p1.stage}`);
  show('folderName', p1.folderName);
  show('folderPath', p1.folderPath);

  console.log('\n   -- filesystem reality check --');
  show('folder exists on disk', await fs.stat(p1.folderPath).then(() => true, () => false));
  show('it is a directory', await fs.stat(p1.folderPath).then(s => s.isDirectory(), () => false));
  show('it is EMPTY (no PROJECT.md etc.)', JSON.stringify(await fs.readdir(p1.folderPath)));
  show('parent dir is exactly the root', path.dirname(p1.folderPath) === path.resolve(root));
  show('root listing', JSON.stringify(await fs.readdir(root)));

  // ---------------------------------------------------------------- 4
  step(4, 'Create a second project whose name needs sanitising (display name preserved)');
  const made2 = await call('POST', '/projects', { name: 'Rich: Project <v2>' });
  show('HTTP', made2.status);
  const p2 = made2.body.data;
  created.push(p2.id);
  show('display name kept as typed', p2.name);
  show('folder name (sanitised)', p2.folderName);
  show('exists on disk', await fs.stat(p2.folderPath).then(() => true, () => false));
  show('root listing', JSON.stringify(await fs.readdir(root)));

  // ---------------------------------------------------------------- 5
  step(5, 'Duplicate name -> 409 conflict, pre-existing folder NOT reused or deleted');
  const before = await fs.readdir(p2.folderPath);
  const dup = await call('POST', '/projects', { name: 'Rich: Project <v2>' });
  show('HTTP', dup.status);
  show('code', dup.body.error?.details?.code);
  show('message', dup.body.error?.message);
  show('original folder still there & unchanged', JSON.stringify(await fs.readdir(p2.folderPath)) === JSON.stringify(before));

  // ---------------------------------------------------------------- 6
  step(6, 'Hostile names -> rejected or reduced, never escaping the root');
  for (const name of ['../escape', '..\\escape', '/etc/passwd', 'C:\\Windows\\System32', 'CON', '   ']) {
    const r = await call('POST', '/projects', { name });
    if (r.status === 201) {
      created.push(r.body.data.id);
      const inside = path.dirname(r.body.data.folderPath) === path.resolve(root);
      show(`"${name}"`, `HTTP 201 -> folder=${JSON.stringify(r.body.data.folderName)} insideRoot=${inside}`);
    } else {
      show(`"${name}"`, `HTTP ${r.status} ${r.body.error?.details?.code ?? ''} ${r.body.error?.message ?? ''}`);
    }
  }
  show('nothing created in %TEMP%\\escape', !(await fs.stat(path.join(os.tmpdir(), 'escape')).then(() => true, () => false)));
  show('final root listing', JSON.stringify(await fs.readdir(root)));

  // ---------------------------------------------------------------- 7
  step(7, 'Workspace status endpoint (the UI\'s "Open folder" source of truth)');
  const st = await call('GET', `/projects/${p1.slug}/workspace`);
  show('HTTP', st.status);
  show('present / readable / folderName', [st.body.data.present, st.body.data.readable, st.body.data.folderName].join(' / '));
  show('folderPath', st.body.data.folderPath);
  console.log('\n   -- now delete the folder behind the app\'s back and re-check --');
  await fs.rmdir(p1.folderPath);
  const st2 = await call('GET', `/projects/${p1.slug}/workspace`);
  show('present after manual delete', st2.body.data.present);
  show('problems', st2.body.data.problems);

  // ---------------------------------------------------------------- 8
  step(8, 'Projects Root not configured -> creation refused, no folder written anywhere');
  const del = await call('DELETE', '/settings/projects-root');
  show('cleared', del.body.data.configured === false);
  const refused = await call('POST', '/projects', { name: 'Should Not Exist' });
  show('HTTP', refused.status);
  show('code / message', `${refused.body.error?.details?.code} ${refused.body.error?.message}`);
  const totalAfter = await prisma.project.count({ where: { name: 'Should Not Exist' } });
  show('rows written', totalAfter);
  const stray = await prisma.project.findFirst({ where: { name: 'Should Not Exist' } });
  show('stray row exists', !!stray);

  // ---------------------------------------------------------------- 9
  step(9, 'Re-configure the root so the app is left usable, then clean up');
  await call('PUT', '/settings/projects-root', { path: root });
  show('re-configured', (await call('GET', '/settings/projects-root')).body.data.configured);
} finally {
  console.log(`\n${'='.repeat(72)}\nCLEANUP\n${'='.repeat(72)}`);
  for (const id of created) {
    // remove children the creation route added, then the project itself
    await prisma.tagAssignment.deleteMany({ where: { taggableType: 'project', taggableId: id } });
    await prisma.activityEvent.deleteMany({ where: { projectId: id } });
    await prisma.project.delete({ where: { id } });
  }
  show('projects created by this run, now deleted', created.join(', ') || '(none)');
  await call('DELETE', '/settings/projects-root');
  show('Projects Root setting', 'cleared');
  await fs.rm(root, { recursive: true, force: true });
  show('temp Projects Root removed', !(await fs.stat(root).then(() => true, () => false)));
  const leftover = await prisma.project.count({ where: { name: { in: created.map(() => 'x') } } });
  show('sanity query ran', leftover === 0);
  await prisma.$disconnect();
}
