/**
 * Manual verification for Phase 5, over the real HTTP API.
 *
 * Starts the real server, points the Projects Root at a throwaway directory,
 * creates one __MANUAL__ project, walks every Phase 5 behaviour against it, then
 * deletes the project it created and restores the original Projects Root.
 *
 * Nothing here writes to the real Projects Root. The script asserts, at the end,
 * that the Projects Root setting and every pre-existing project row are exactly
 * as they were before it started.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './src/server.js';
import { prisma } from './src/lib/prisma.js';
import { PROJECTS_ROOT_KEY } from './src/lib/settings.js';

const PORT = 4781;
const BASE = `http://127.0.0.1:${PORT}/api`;

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -> ${detail}` : ''}`);
}

async function apiCall(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function fingerprint() {
  const projects = await prisma.project.findMany({ orderBy: { id: 'asc' } });
  return JSON.stringify(
    projects.map(p => ({ id: p.id, slug: p.slug, name: p.name, stage: p.stage, folderPath: p.folderPath, isArchived: p.isArchived, updatedAt: p.updatedAt.toISOString() }))
  );
}

async function main() {
  const projectsBefore = await fingerprint();
  const settingBefore = await prisma.appSetting.findUnique({ where: { key: PROJECTS_ROOT_KEY } });
  console.log(`Original Projects Root: ${settingBefore ? JSON.stringify(settingBefore.value) : '(not set)'}`);
  console.log(`Pre-existing project rows: ${JSON.parse(projectsBefore).length}\n`);

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'phub-p5-manual-'));
  const server = startServer(PORT);
  await new Promise(r => setTimeout(r, 800));

  const name = `__MANUAL__ STATUS.md check ${Date.now()}`;
  let projectId = null;

  try {
    // ---- 1. a temp Projects Root, and a project created through the API ----
    const rootSet = await apiCall('PUT', '/settings/projects-root', { path: tmpRoot });
    check('Projects Root can be pointed at a temporary directory', rootSet.status === 200, rootSet.status.toString());

    const created = await apiCall('POST', '/projects', { name, description: 'Manual Phase 5 verification.' });
    projectId = created.body?.data?.id;
    const folder = created.body?.data?.folderPath;
    check('project created', created.status === 201 && !!projectId, `id=${projectId}`);

    // ---- 2. STATUS.md exists and declares IDEA ----
    const files = await fsp.readdir(folder);
    check('STATUS.md is created with the project', files.includes('STATUS.md'), files.join(', '));
    const statusFile = path.join(folder, 'STATUS.md');
    const initial = await fsp.readFile(statusFile, 'utf8');
    check('STATUS.md declares IDEA', /\*\*Status:\*\*\s+IDEA/.test(initial));
    check('STATUS.md names its project id', initial.includes(`p-hub-project-id: ${projectId}`));

    // ---- 3. a folder full of source files is still IDEA ----
    await fsp.writeFile(path.join(folder, 'index.ts'), 'export const x = 1;\n', 'utf8');
    await fsp.writeFile(path.join(folder, 'package.json'), '{"name":"manual"}\n', 'utf8');
    await fsp.mkdir(path.join(folder, 'src'), { recursive: true });
    await fsp.writeFile(path.join(folder, 'src', 'main.ts'), 'export {};\n', 'utf8');
    const afterFiles = await apiCall('GET', `/projects/${projectId}/status`);
    check(
      'source files in the folder do not change the status',
      afterFiles.body?.data?.databaseStatus === 'IDEA',
      afterFiles.body?.data?.databaseStatus
    );

    // ---- 4. changing the status updates the file ----
    const changed = await apiCall('PUT', `/projects/${projectId}/status`, { stage: 'BUILDING' });
    check('PUT /status changes the status', changed.status === 200 && changed.body?.data?.stage === 'BUILDING');
    const afterChange = await fsp.readFile(statusFile, 'utf8');
    check('STATUS.md now declares BUILDING', /\*\*Status:\*\*\s+BUILDING/.test(afterChange));
    check(
      'the response reports a synchronized state',
      changed.body?.data?.statusChange?.consistency?.state === 'SYNCHRONIZED',
      changed.body?.data?.statusChange?.consistency?.state
    );

    // ---- 5. the pre-existing stage endpoint still works and syncs ----
    const legacy = await apiCall('POST', `/projects/${projectId}/stage`, { stage: 'TESTING' });
    check('POST /stage still works', legacy.status === 200 && legacy.body?.data?.stage === 'TESTING');
    check('POST /stage updates STATUS.md too', /\*\*Status:\*\*\s+TESTING/.test(await fsp.readFile(statusFile, 'utf8')));

    // ---- 6. a hand edited file is reported, never applied ----
    await fsp.writeFile(statusFile, (await fsp.readFile(statusFile, 'utf8')).replace(/\*\*Status:\*\*\s+\S+/, '**Status:** PRODUCTION'), 'utf8');
    const mismatch = await apiCall('GET', `/projects/${projectId}/status`);
    check('a hand edited STATUS.md is reported as a mismatch', mismatch.body?.data?.state === 'STATUS_MISMATCH', mismatch.body?.data?.state);
    check('the database did not follow the file', mismatch.body?.data?.databaseStatus === 'TESTING');
    const reread = await prisma.project.findUnique({ where: { id: projectId } });
    check('the stored status is still TESTING after re-reading', reread.stage === 'TESTING');

    // ---- 7. re-selecting the current status does not clobber the edit ----
    const manual = await fsp.readFile(statusFile, 'utf8');
    const noop = await apiCall('PUT', `/projects/${projectId}/status`, { stage: 'TESTING' });
    check('re-selecting the current status is a no-op', noop.body?.data?.statusChange?.noChange === true);
    check('the manual edit survives the no-op', (await fsp.readFile(statusFile, 'utf8')) === manual);

    // ---- 8. an invalid declared status is reported, not applied ----
    await fsp.writeFile(statusFile, '**Status:** WAT\n', 'utf8');
    const invalid = await apiCall('GET', `/projects/${projectId}/status`);
    check('an invalid declared status is reported as invalid', invalid.body?.data?.state === 'DOCUMENT_INVALID', invalid.body?.data?.state);
    const content = await apiCall('GET', `/projects/${projectId}/status-document/content`);
    check('an invalid status in the file is a 422 on read', content.status === 422, content.status.toString());
    check('the database is still TESTING', (await prisma.project.findUnique({ where: { id: projectId } })).stage === 'TESTING');

    // ---- 9. regenerate needs confirmation, and only touches STATUS.md ----
    const unconfirmed = await apiCall('POST', `/projects/${projectId}/status-document/regenerate`, {});
    check('regenerate without confirmation is refused', unconfirmed.status === 400, unconfirmed.status.toString());
    check('the file was not touched by the refusal', (await fsp.readFile(statusFile, 'utf8')) === '**Status:** WAT\n');

    const confirmed = await apiCall('POST', `/projects/${projectId}/status-document/regenerate`, { confirm: true });
    check('regenerate with confirmation succeeds', confirmed.status === 200 && confirmed.body?.replaced === true);
    check('STATUS.md now agrees with the database', /\*\*Status:\*\*\s+TESTING/.test(await fsp.readFile(statusFile, 'utf8')));
    check('PROJECT.md was not regenerated', (await fsp.readFile(path.join(folder, 'PROJECT.md'), 'utf8')).includes('Manual Phase 5 verification'));
    check('the source file was not touched', (await fsp.readFile(path.join(folder, 'index.ts'), 'utf8')) === 'export const x = 1;\n');
    check('the package manifest was not touched', (await fsp.readFile(path.join(folder, 'package.json'), 'utf8')) === '{"name":"manual"}\n');

    // ---- 10. initialize when the document is missing ----
    await fsp.rm(statusFile, { force: true });
    const missing = await apiCall('GET', `/projects/${projectId}/status`);
    check('a missing document is reported as missing', missing.body?.data?.state === 'DOCUMENT_MISSING', missing.body?.data?.state);
    const init = await apiCall('POST', `/projects/${projectId}/status-document`, {});
    check('initialize creates the document', init.status === 201 && init.body?.replaced === false);
    check('initialize uses the current status, not IDEA', /\*\*Status:\*\*\s+TESTING/.test(await fsp.readFile(statusFile, 'utf8')));
    check('initialize did not change the status', (await prisma.project.findUnique({ where: { id: projectId } })).stage === 'TESTING');

    // ---- 11. an invalid status is refused by the API ----
    const bad = await apiCall('PUT', `/projects/${projectId}/status`, { stage: 'ITERATING' });
    check('a status outside the enum is refused', bad.status === 400, bad.status.toString());
    check('the refused request changed nothing', (await prisma.project.findUnique({ where: { id: projectId } })).stage === 'TESTING');

    // ---- 12. a database change that cannot reach the file is reported ----
    const realFolder = folder;
    await fsp.rm(realFolder, { recursive: true, force: true });
    await fsp.writeFile(realFolder, 'not a folder', 'utf8');
    const partial = await apiCall('PUT', `/projects/${projectId}/status`, { stage: 'ARCHIVED' });
    check('the database update still succeeds when the folder is broken', (await prisma.project.findUnique({ where: { id: projectId } })).stage === 'ARCHIVED');
    check('the response carries a warning instead of claiming success', !!partial.body?.warning || !!partial.body?.data?.statusChange?.warning);
    check(
      'the response states the disagreement',
      ['STATUS_MISMATCH', 'DOCUMENT_MISSING', 'UNAVAILABLE', 'DOCUMENT_UNREADABLE'].includes(partial.body?.data?.statusChange?.consistency?.state),
      partial.body?.data?.statusChange?.consistency?.state
    );

    // ---- 13. and it can be repaired explicitly afterwards ----
    await fsp.rm(realFolder, { force: true });
    await fsp.mkdir(realFolder, { recursive: true });
    const repaired = await apiCall('POST', `/projects/${projectId}/status-document/regenerate`, { confirm: true });
    check('regenerate repairs the file after the fault is fixed', repaired.status === 201 && /\*\*Status:\*\*\s+ARCHIVED/.test(await fsp.readFile(statusFile, 'utf8')));

    // ---- 14. the timeline recorded the changes ----
    const events = await prisma.activityEvent.findMany({ where: { projectId, type: 'STAGE_CHANGED' } });
    check('status changes are recorded on the timeline', events.length >= 3, `${events.length} events`);

    console.log('\n--- cleanup ---');
  } finally {
    if (projectId) {
      await prisma.activityEvent.deleteMany({ where: { projectId } });
      await prisma.tagAssignment.deleteMany({ where: { taggableType: 'project', taggableId: projectId } });
      const gone = await prisma.project.deleteMany({ where: { id: projectId } });
      console.log(`deleted the manual project row: ${gone.count}`);
    }
    // Restore the Projects Root exactly as it was found, by writing the row back
    // rather than by "fixing" it: unset before means unset after, and any other
    // value means that value again.
    if (settingBefore) {
      await prisma.appSetting.update({ where: { key: PROJECTS_ROOT_KEY }, data: { value: settingBefore.value } });
    } else {
      await prisma.appSetting.deleteMany({ where: { key: PROJECTS_ROOT_KEY } });
    }
    const settingNow = await prisma.appSetting.findUnique({ where: { key: PROJECTS_ROOT_KEY } });
    const restored = settingBefore
      ? settingNow && JSON.stringify(settingNow.value) === JSON.stringify(settingBefore.value)
      : !settingNow;
    check('the Projects Root setting is exactly as it was before', restored, settingNow ? JSON.stringify(settingNow.value) : '(not set)');
    console.log(`Projects Root setting now: ${settingNow ? JSON.stringify(settingNow.value) : '(not set)'}`);

    server.close();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
    console.log('temporary Projects Root removed');
    await prisma.$disconnect();
  }

  const projectsAfter = await fingerprint();
  check('every pre-existing project row is byte-identical afterwards', projectsAfter === projectsBefore);

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.label} ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
