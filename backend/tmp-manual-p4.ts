import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prisma } from './src/lib/prisma.js';

/**
 * Phase 4 manual verification, run against a real server over HTTP.
 *
 * Uses a throwaway Projects Root and one throwaway project, and removes both
 * afterwards. The pre-existing database state is fingerprinted first and last.
 */

const BASE = 'http://localhost:4000/api';
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`);
}

async function call(method: string, p: string, body?: unknown) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

async function fingerprint() {
  const projects = await prisma.project.findMany({ orderBy: { id: 'asc' } });
  const tags = await prisma.tag.findMany({ orderBy: { id: 'asc' } });
  return JSON.stringify({
    projects: projects.map(p => ({ id: p.id, slug: p.slug, name: p.name, stage: p.stage, folderPath: p.folderPath, updatedAt: p.updatedAt.toISOString() })),
    tags: tags.map(t => t.name)
  });
}

const before = await fingerprint();
const rootBefore = await prisma.appSetting.findUnique({ where: { key: 'projects_root' } });

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'phub-p4manual-'));
let projectId: number | null = null;
let projectSlug = '';
let docPath = '';

try {
  // ---------------------------------------------------------------- root
  const setRoot = await call('PUT', '/settings/projects-root', { path: root });
  check('Projects Root set to a temp directory', setRoot.status === 200, `status ${setRoot.status}`);

  // ------------------------------------------------------------- create
  const name = `Manual Phase4 ${Date.now()}`;
  const created = await call('POST', '/projects', {
    name,
    description: 'A project created by the Phase 4 manual check.',
    problem: 'PROJECT.md did not exist.',
    targetUsers: 'One developer.',
    repositoryUrl: 'https://example.invalid/manual'
  });
  check('project created', created.status === 201, `status ${created.status} ${JSON.stringify(created.body?.error ?? {})}`);
  projectId = created.body?.data?.id;
  projectSlug = created.body?.data?.slug;
  check('creation response reports the document status', created.body?.data?.projectDocument?.exists === true);
  check('creation reports no warning', created.body?.warning === undefined);
  docPath = path.join(created.body.data.folderPath, 'PROJECT.md');

  // ------------------------------------------------------ on disk
  const onDisk = await fsp.readFile(docPath, 'utf8');
  check('PROJECT.md exists on disk', typeof onDisk === 'string');
  check('contains the real project data', onDisk.includes('A project created by the Phase 4 manual check.'));
  check('contains front matter', onDisk.startsWith('---\n') && onDisk.includes('p-hub-document-version: 1'));
  check('contains the project id', onDisk.includes(`p-hub-project-id: ${projectId}`));
  check('contains the repository url', onDisk.includes('https://example.invalid/manual'));
  check('has no generation timestamp', !/Generated (on|at) \d{4}/i.test(onDisk));
  console.log(`\n--- first 24 lines of PROJECT.md ---\n${onDisk.split('\n').slice(0, 24).join('\n')}\n---`);

  // ------------------------------------------------------- status API
  const status = await call('GET', `/projects/${projectId}/project-document`);
  check('status endpoint reports it exists', status.body?.data?.exists === true);
  check('status reports a relative path', status.body?.data?.relativePath === './PROJECT.md');
  check('status reports one-way direction', status.body?.data?.direction === 'DATABASE_TO_DOCUMENT' && status.body?.data?.documentToDatabaseSync === false);

  // ------------------------------------------- external edit, no sync
  await fsp.writeFile(docPath, `${onDisk}\n## My Manual Note\n\nEdited outside Project Hub.\n`, 'utf8');
  const readBack = await call('GET', `/projects/${projectId}/project-document/content`);
  check('read shows the external edit', readBack.body?.data?.content?.includes('Edited outside Project Hub.') === true);
  const afterRead = await prisma.project.findUnique({ where: { id: projectId! } });
  check('external edit did NOT change the database description', afterRead?.description === 'A project created by the Phase 4 manual check.');
  check('external edit did NOT change the project name', afterRead?.name === name);

  // ------------------------------------------------- regeneration
  const noConfirm = await call('POST', `/projects/${projectId}/project-document/regenerate`, {});
  check('regenerate without confirm is refused', noConfirm.status === 400, `status ${noConfirm.status}`);
  check('refusal left the file untouched', (await fsp.readFile(docPath, 'utf8')).includes('Edited outside Project Hub.'));

  const confirmed = await call('POST', `/projects/${projectId}/project-document/regenerate`, { confirm: true });
  check('regenerate with confirm succeeds', confirmed.status === 200, `status ${confirmed.status}`);
  check('regenerate reports a replacement', confirmed.body?.replaced === true);
  const afterRegen = await fsp.readFile(docPath, 'utf8');
  check('regenerate discarded the manual edit', !afterRegen.includes('Edited outside Project Hub.'));

  // sibling files untouched
  const sibling = path.join(created.body.data.folderPath, 'notes.md');
  await fsp.writeFile(sibling, 'sibling content', 'utf8');
  await call('POST', `/projects/${projectId}/project-document/regenerate`, { confirm: true });
  check('sibling file untouched', (await fsp.readFile(sibling, 'utf8')) === 'sibling content');

  // -------------------------------------------- generate refuses
  const generateAgain = await call('POST', `/projects/${projectId}/project-document`, {});
  check('generate refuses to overwrite', generateAgain.status === 409, `status ${generateAgain.status}`);
  check('refusal is a CONFLICT', generateAgain.body?.error?.category === 'CONFLICT');
  check('conflict suggests regenerating', String(generateAgain.body?.error?.possibleAction ?? '').includes('Regenerate'));

  // -------------------------------------------- explicit generation
  const removed = path.join(created.body.data.folderPath, 'lost.md');
  await fsp.writeFile(removed, 'x', 'utf8');
  await fsp.rm(docPath, { force: true });
  const regenerated = await call('POST', `/projects/${projectId}/project-document`, {});
  check('generate creates a missing document', regenerated.status === 201, `status ${regenerated.status}`);
  check('recreated document is complete', (await fsp.readFile(docPath, 'utf8')).includes('## Requirements'));
  check('generate did not touch the sibling', await fsp.access(removed).then(() => true, () => false));

  // ------------------------------------------------- path safety
  const traversal = await call('POST', `/projects/${projectId}/project-document/regenerate`, {
    confirm: true,
    path: 'C:/Windows/System32/drivers/etc/hosts',
    documentPath: '../../../../secrets.md',
    relativePath: './OTHER.md'
  });
  check('client-supplied paths are ignored, not obeyed', [200, 400].includes(traversal.status), `status ${traversal.status}`);
  check('document still lives in the project folder', (await fsp.readFile(docPath, 'utf8')).includes(`p-hub-project-id: ${projectId}`));
  check('no stray file was created in the root', (await fsp.readdir(root)).sort().join(',') === created.body.data.folderName);

  // -------------------------------------------------- imported-style project
  const legacy = await prisma.project.findFirst({ where: { id: { not: projectId }, folderPath: null }, orderBy: { id: 'asc' } });
  const legacyStatus = await call('GET', `/projects/${legacy!.id}/project-document`);
  check('pre-existing project reports no workspace', legacyStatus.body?.data?.available === false, JSON.stringify(legacyStatus.body?.data?.reason));
  check('pre-existing project has no document', legacyStatus.body?.data?.exists === null);
  const legacyGenerate = await call('POST', `/projects/${legacy!.id}/project-document`, {});
  check('pre-existing project cannot be given a document', legacyGenerate.status === 409, `status ${legacyGenerate.status}`);
  const legacyAfter = await prisma.project.findUnique({ where: { id: legacy!.id } });
  check('pre-existing project untouched', legacyAfter?.folderPath === null);
} finally {
  // ------------------------------------------------------------ cleanup
  if (projectId) {
    await prisma.activityEvent.deleteMany({ where: { projectId } });
    await prisma.tagAssignment.deleteMany({ where: { taggableType: 'project', taggableId: projectId } });
    await prisma.project.deleteMany({ where: { id: projectId } });
  }
  await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  if (rootBefore) {
    await prisma.appSetting.upsert({ where: { key: 'projects_root' }, create: { key: 'projects_root', value: rootBefore.value }, update: { value: rootBefore.value } });
  } else {
    await prisma.appSetting.deleteMany({ where: { key: 'projects_root' } });
  }

  const after = await fingerprint();
  check('database restored to its pre-check state', after === before);
  console.log(failures === 0 ? '\nALL MANUAL CHECKS PASSED' : `\n${failures} MANUAL CHECK(S) FAILED`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}
