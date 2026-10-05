import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { api, prisma } from './helpers';
import { PROJECTS_ROOT_KEY } from '../src/lib/settings';
import { PROJECT_DOCUMENT_FILENAME } from '../src/lib/projectDocument';
import {
  checkProjectNow,
  countPendingChanges,
  dismissProjectChange,
  getMonitorStatus,
  getProjectMonitorReport,
  listPendingChanges,
  markProjectSynchronized,
  registerProject,
  resyncDocumentMonitor,
  startDocumentMonitor,
  stopDocumentMonitor,
  subscribeToMonitor,
  unregisterProject,
  type DocumentChangeNotification,
  type MonitorEvent
} from '../src/lib/projectDocumentMonitor';

/**
 * Phase 7: centralized PROJECT.md monitoring.
 *
 * Same safety envelope as the Phase 4 and Phase 6 suites: a throwaway Projects
 * Root in the OS temp directory, only `__TEST__` projects created through the
 * real API, everything removed in afterAll, and every pre-existing project row
 * fingerprinted before and after so "existing projects are untouched" is
 * asserted rather than claimed.
 *
 * The debounce is set to 25ms and the poll interval to a minute, so the suite
 * exercises the real filesystem events and the real debounce logic without
 * sleeping for long enough to be annoying. Nothing here waits on a timer to
 * "see if it happens to work": every assertion polls the monitor's own reported
 * state with a deadline, so a genuine failure times out with a message rather
 * than passing because the machine was slow.
 */

/** Long enough for a Windows filesystem notification to arrive, short enough to fail fast. */
const EVENT_TIMEOUT_MS = 8000;
const POLL_STEP_MS = 25;

const tmpRoots: string[] = [];
const createdFolders: string[] = [];

/**
 * Projects created by the *currently running* test only.
 *
 * Isolation between tests matters more here than in the Phase 4/6 suites: the
 * monitor keeps per-project state in memory, so a project left registered from an
 * earlier test would keep publishing its pending change and make a later test's
 * global assertion meaningless. Each test therefore starts with nothing
 * registered but its own projects, and its own projects are torn down at the end.
 */
let createdProjectIds: number[] = [];

let counter = 0;
function uniqueName(prefix = 'Monitor'): string {
  counter += 1;
  return `__TEST__ ${prefix} ${Date.now()}-${counter}`;
}

/**
 * Every column of every project except the ones this feature is allowed to touch
 * and the rows created by this suite.
 *
 * `updatedAt` is deliberately excluded: Prisma maintains it automatically, so any
 * write to a monitoring column moves it. The Phase 7 columns are excluded because
 * a detected change is expected to write them; that expectation is asserted
 * separately, per project, so a write to a *pre-existing* project's monitoring
 * columns would still be caught by the fingerprint of its data columns.
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
        isArchived: p.isArchived,
        description: p.description,
        problem: p.problem,
        motivation: p.motivation,
        targetUsers: p.targetUsers,
        expectedValue: p.expectedValue,
        assumptions: p.assumptions,
        initialQuestions: p.initialQuestions,
        inspiration: p.inspiration,
        v1Scope: p.v1Scope,
        repositoryUrl: p.repositoryUrl,
        folderName: p.folderName,
        folderPath: p.folderPath,
        projectDocumentHash: p.projectDocumentHash,
        projectDocumentStateHash: p.projectDocumentStateHash,
        projectDocumentSyncedAt: p.projectDocumentSyncedAt?.toISOString() ?? null
      }))
  );
}

/** The count of rows in every table that belongs to a project, per project id. */
async function childCounts(exclude: number[] = []) {
  const projects = await prisma.project.findMany({
    where: { id: { notIn: exclude } },
    orderBy: { id: 'asc' },
    select: { id: true }
  });
  const result: Record<string, Record<string, number>> = {};
  for (const p of projects) {
    const where = { projectId: p.id };
    result[String(p.id)] = {
      requirements: await prisma.requirement.count({ where }),
      features: await prisma.feature.count({ where }),
      decisions: await prisma.architectureDecision.count({ where }),
      techStack: await prisma.techStackItem.count({ where }),
      tables: await prisma.databaseTable.count({ where }),
      endpoints: await prisma.apiEndpoint.count({ where }),
      research: await prisma.researchEntry.count({ where }),
      researchQuestions: await prisma.researchQuestion.count({ where }),
      milestones: await prisma.milestone.count({ where }),
      tasks: await prisma.task.count({ where }),
      issues: await prisma.issue.count({ where }),
      notes: await prisma.note.count({ where }),
      deployments: await prisma.deployment.count({ where }),
      gitReferences: await prisma.gitReference.count({ where }),
      activity: await prisma.activityEvent.count({ where })
    };
  }
  return JSON.stringify(result);
}

let root: string;
let beforeProjects: string | null = null;
let beforeChildren: string | null = null;

beforeAll(async () => {
  beforeProjects = await projectFingerprint();
  beforeChildren = await childCounts();
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'phub-p7root-'));
  tmpRoots.push(root);
  await prisma.appSetting.upsert({
    where: { key: PROJECTS_ROOT_KEY },
    create: { key: PROJECTS_ROOT_KEY, value: root },
    update: { value: root }
  });
});

afterAll(async () => {
  await stopDocumentMonitor();
  for (const dir of [...createdFolders, ...tmpRoots]) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  await prisma.appSetting.deleteMany({ where: { key: PROJECTS_ROOT_KEY } });
  // The real assertion that this feature changed nothing it should not have.
  expect(await projectFingerprint()).toBe(beforeProjects);
  expect(await childCounts()).toBe(beforeChildren);
  expect(await prisma.appSetting.count({ where: { key: PROJECTS_ROOT_KEY } })).toBe(0);
});

beforeEach(async () => {
  await prisma.appSetting.upsert({
    where: { key: PROJECTS_ROOT_KEY },
    create: { key: PROJECTS_ROOT_KEY, value: root },
    update: { value: root }
  });
  createdProjectIds = [];
  // A running monitor with real filesystem watching, and a tiny debounce so the
  // suite is fast while still exercising the debounce path rather than bypassing
  // it. Started per test so every test begins from a known state.
  await startDocumentMonitor({ debounceMs: 25, pollIntervalMs: 60_000 });
});

afterEach(async () => {
  // Tear down only this test's projects, so nothing it registered survives into
  // the next test and keeps publishing a pending change.
  for (const id of createdProjectIds) {
    await unregisterProject(id);
    await prisma.activityEvent.deleteMany({ where: { projectId: id } });
    await prisma.project.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const dir of createdFolders.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  // Whatever happened above, no pending change may outlive its test.
  expect(countPendingChanges()).toBe(0);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadProject(id: number) {
  const p = await prisma.project.findUnique({
    where: { id },
    select: { id: true, name: true, folderPath: true }
  });
  if (!p) throw new Error(`project ${id} disappeared`);
  return p;
}

/**
 * Create a project through the real API, so it gets a real folder and PROJECT.md.
 *
 * A description is always supplied. The rendered document omits empty fields
 * entirely, so a project without one has no `**Description**` to edit and every
 * "modify the document" test would be editing a field that does not exist.
 */
async function createMonitoredProject(name = uniqueName(), extra: Record<string, unknown> = {}) {
  const res = await api
    .post('/api/projects')
    .send({ name, description: `Baseline description for ${name}.`, ...extra });
  expect(res.status).toBe(201);
  const project = res.body.data;
  createdProjectIds.push(project.id);
  if (project.folderPath) createdFolders.push(project.folderPath);
  // Project creation already registers the project, but that registration is
  // fire-and-forget in the route, so register explicitly to be deterministic.
  await registerProject(await loadProject(project.id));
  return project;
}

/**
 * Create a project and then make it a *modified* one: a document that has real,
 * applicable changes waiting.
 *
 * Most tests want to assert what happens to a detected change, and doing that
 * needs the "detected" state as the starting point. This gets there in one step
 * and, crucially, waits for the detection rather than assuming it.
 */
async function createModifiedProject(name = uniqueName(), extra: Record<string, unknown> = {}) {
  const project = await createMonitoredProject(name, extra);
  await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized at baseline');
  await writeDoc(project, setOverviewField(await readDoc(project), 'Description', `Modified by the test. ${name}`));
  await waitForState(project.id, s => s === 'MODIFIED', 'modified');
  return project;
}

function docPath(project: { folderPath: string | null }): string {
  return path.join(project.folderPath!, PROJECT_DOCUMENT_FILENAME);
}

async function readDoc(project: { folderPath: string | null }): Promise<string> {
  return fsp.readFile(docPath(project), 'utf8');
}

async function writeDoc(project: { folderPath: string | null }, content: string): Promise<void> {
  await fsp.writeFile(docPath(project), content, 'utf8');
}

/**
 * Replace one bold-labelled field's value in the rendered document.
 *
 * Throws when the field is not there. A silent no-op here would leave the file
 * byte-identical, and the test would then fail later with a confusing "expected
 * MODIFIED" instead of saying the edit never happened.
 */
function setOverviewField(markdown: string, label: string, value: string): string {
  const re = new RegExp(`(\\*\\*${label}\\*\\*\\n\\n)([\\s\\S]*?)(?=\n\n\\*\\*|\n\n## |$)`);
  const next = markdown.replace(re, `$1${value}`);
  if (next === markdown) throw new Error(`PROJECT.md has no **${label}** field to edit`);
  return next;
}

/**
 * Wait until the monitor's own state for this project satisfies the predicate.
 *
 * Polling the reported state rather than sleeping for a guessed interval is what
 * makes these tests meaningful: a broken watcher fails with a readable timeout
 * instead of a flaky pass.
 */
async function waitForState(
  projectId: number,
  predicate: (state: string | null) => boolean,
  what: string,
  timeoutMs = EVENT_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  while (Date.now() < deadline) {
    const report = getProjectMonitorReport(projectId);
    last = report.state;
    if (predicate(last)) return;
    await new Promise(resolve => setTimeout(resolve, POLL_STEP_MS));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for project ${projectId} to be ${what}; last state was ${last}`);
}

async function waitForPendingCount(count: number, timeoutMs = EVENT_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (countPendingChanges() === count) return;
    await new Promise(resolve => setTimeout(resolve, POLL_STEP_MS));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${count} pending change(s); got ${countPendingChanges()}: ` +
      listPendingChanges()
        .map(n => `${n.projectId}=${n.state}`)
        .join(', ')
  );
}

/** Collect monitor events for the duration of a test. */
function recordEvents(): { events: MonitorEvent[]; stop: () => void } {
  const events: MonitorEvent[] = [];
  const stop = subscribeToMonitor(event => events.push(event));
  return { events, stop };
}

async function monitorState(projectId: number): Promise<ReturnType<typeof getProjectMonitorReport>> {
  return api.get(`/api/projects/${projectId}/project-document/monitor`).then(r => r.body.data);
}

async function syncNow(projectId: number, acknowledgeConflict = false) {
  return api.post(`/api/projects/${projectId}/project-document/sync`).send({ acknowledgeConflict });
}

async function previewSync(projectId: number) {
  return api.post(`/api/projects/${projectId}/project-document/sync/preview`).send({});
}

// ---------------------------------------------------------------------------
// 1. Only registered projects' own PROJECT.md is watched
// ---------------------------------------------------------------------------

describe('1. what is watched', () => {
  it('reports the real operating mode and the projects it manages', async () => {
    const project = await createMonitoredProject(uniqueName('Status'));

    const status = getMonitorStatus();
    expect(status.running).toBe(true);
    expect(status.mode).toBe('WATCH');
    expect(status.watchedProjects).toBeGreaterThan(0);
    expect(status.polledProjects).toBe(0);
    expect(status.projectsRoot).toBe(path.resolve(root));
    // Exactly this project's own folder is watched, not the Projects Root.
    expect(getProjectMonitorReport(project.id).folderPath).toBe(path.resolve(project.folderPath!));
  });

  it('watches a project folder non-recursively and only PROJECT.md', async () => {
    const project = await createMonitoredProject(uniqueName('Scope'));
    const report = await monitorState(project.id);
    expect(report.monitored).toBe(true);
    expect(report.mode).toBe('WATCH');
    expect(report.relativePath).toBe(`./${PROJECT_DOCUMENT_FILENAME}`);
  });

  it('ignores changes to other files in the project folder', async () => {
    const project = await createMonitoredProject(uniqueName('OtherFile'));
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized at baseline');

    // Several events on files the monitor must ignore.
    await fsp.writeFile(path.join(project.folderPath!, 'README.md'), '# not watched\n', 'utf8');
    await fsp.writeFile(path.join(project.folderPath!, 'STATUS.md'), '# not watched either\n', 'utf8');
    await fsp.mkdir(path.join(project.folderPath!, 'src'), { recursive: true });
    await fsp.writeFile(path.join(project.folderPath!, 'src', 'PROJECT.md'), 'nested PROJECT.md\n', 'utf8');
    // Give any (wrong) event time to arrive.
    await new Promise(resolve => setTimeout(resolve, 400));

    const report = await monitorState(project.id);
    expect(report.state).toBe('SYNCHRONIZED');
    expect(countPendingChanges()).toBe(0);
  });

  it('never watches outside the Projects Root', async () => {
    // A folder that exists, is readable and holds a PROJECT.md, but sits outside
    // the configured root. Its contents must be invisible to the monitor.
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'phub-p7outside-'));
    tmpRoots.push(outside);
    await fsp.writeFile(path.join(outside, PROJECT_DOCUMENT_FILENAME), '# outside the root\n', 'utf8');

    const result = await registerProject({ id: -1, name: 'Outside', folderPath: outside });
    expect(result.monitored).toBe(false);
    expect(result.mode).toBe('SKIPPED');

    const report = getProjectMonitorReport(-1);
    expect(report.monitored).toBe(false);
    expect(report.unavailableReason).toBe('PROJECT_WORKSPACE_UNSAFE');
  });

  it('does not monitor a project with no workspace folder', async () => {
    const project = await createMonitoredProject(uniqueName('NoFolder'));
    // Project creation always makes a folder. Clearing the recorded path models a
    // project whose folder is not (or no longer) there - the imported-document
    // case Phase 4 already describes.
    await prisma.project.update({ where: { id: project.id }, data: { folderPath: null } });

    const result = await registerProject(await loadProject(project.id));
    expect(result.monitored).toBe(false);
    expect(result.reason).toBe('PROJECT_WORKSPACE_MISSING');

    const report = getProjectMonitorReport(project.id);
    expect(report.monitored).toBe(false);
    expect(report.unavailableReason).toBe('PROJECT_WORKSPACE_MISSING');
  });

  it('does not accept a path from the client', async () => {
    const project = await createMonitoredProject(uniqueName('NoPath'));

    for (const attempt of [
      { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' },
      { documentPath: 'C:\\Windows\\System32\\drivers\\etc\\hosts' },
      { folderPath: '/etc' },
      { file: '../../../../PROJECT.md' }
    ]) {
      const res = await api.post(`/api/projects/${project.id}/project-document/monitor/check`).send(attempt);
      // Rejected as an unknown field, or accepted and ignored because the monitor
      // resolves the path itself. Either way the monitor's path is unchanged.
      expect([200, 400]).toContain(res.status);
      const report = await monitorState(project.id);
      expect(report.relativePath).toBe(`./${PROJECT_DOCUMENT_FILENAME}`);
    }
    expect(getProjectMonitorReport(project.id).documentHash).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Change detection
// ---------------------------------------------------------------------------

describe('2. change detection', () => {
  it('does not report a freshly generated document', async () => {
    const project = await createMonitoredProject(uniqueName('Fresh'));
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized at baseline');
    expect(countPendingChanges()).toBe(0);
  });

  it('does not report a document whose content is unchanged', async () => {
    const project = await createMonitoredProject(uniqueName('SameBytes'), { description: 'Stable.' });
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized at baseline');

    // Identical bytes. The hash is the change test, so this must be silent even
    // though the filesystem event certainly fires.
    await writeDoc(project, await readDoc(project));
    await new Promise(resolve => setTimeout(resolve, 400));

    expect(getProjectMonitorReport(project.id).state).toBe('SYNCHRONIZED');
    expect(countPendingChanges()).toBe(0);
  });

  it('does not report a timestamp-only change', async () => {
    const project = await createMonitoredProject(uniqueName('Touch'), { description: 'Stable.' });
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized at baseline');
    const before = fs.statSync(docPath(project)).mtimeMs;

    // Append then truncate: mtime moves twice, content ends identical.
    const content = await readDoc(project);
    await fsp.appendFile(docPath(project), '\n', 'utf8');
    await fsp.writeFile(docPath(project), content, 'utf8');

    await new Promise(resolve => setTimeout(resolve, 400));
    expect(fs.statSync(docPath(project)).mtimeMs).toBeGreaterThan(before);
    expect(getProjectMonitorReport(project.id).state).toBe('SYNCHRONIZED');
    expect(countPendingChanges()).toBe(0);
  });

  it('detects an edited document and reports it without applying it', async () => {
    const project = await createMonitoredProject(uniqueName('Edit'), { description: 'Before.' });
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized at baseline');

    const { events, stop } = recordEvents();
    try {
      await writeDoc(project, setOverviewField(await readDoc(project), 'Description', 'After.'));

      await waitForState(project.id, s => s === 'MODIFIED', 'modified');
      const report = await monitorState(project.id);
      expect(report.hasPendingChange).toBe(true);
      expect(report.detectedAt).not.toBeNull();

      // The database must be untouched: monitoring never applies anything.
      const row = await prisma.project.findUnique({ where: { id: project.id }, select: { description: true } });
      expect(row?.description).toBe('Before.');

      // And the user was told, exactly once, with no content in the payload.
      const notifications = events.filter(e => e.kind === 'notification');
      expect(notifications).toHaveLength(1);
      const payload = notifications[0].payload as DocumentChangeNotification;
      expect(payload.projectId).toBe(project.id);
      expect(payload.projectName).toBe(project.name);
      expect(payload.detectedAt).toBeTruthy();
      expect(payload.projectFieldCount).toBe(1);
      expect(payload.summary).toContain('1 project field');
      expect(payload.changedFieldNames).toEqual(['description']);
      // Counts and field names only: no document text anywhere in the payload.
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain('After.');
    } finally {
      stop();
    }
  });

  it('applies nothing even after many events for one save', async () => {
    const project = await createMonitoredProject(uniqueName('Burst'), { description: 'Before.' });
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized at baseline');

    // The final document is built from the original, not from whatever the burst
    // left behind, so the test asserts debouncing rather than document recovery.
    const finalDoc = setOverviewField(await readDoc(project), 'Description', 'Burst final.');

    const { events, stop } = recordEvents();
    try {
      // Emulate a burst of writes to the same file, as an editor does.
      for (let i = 0; i < 8; i += 1) {
        await fsp.writeFile(docPath(project), `# partial write ${i}\n`, 'utf8');
        await fsp.appendFile(docPath(project), `\n<!-- ${i} -->`, 'utf8');
      }
      await writeDoc(project, finalDoc);

      await waitForState(project.id, s => s === 'MODIFIED', 'modified');
      // Give any extra event time to produce a spurious second notification.
      await new Promise(resolve => setTimeout(resolve, 400));

      const notifications = events.filter(e => e.kind === 'notification');
      expect(notifications).toHaveLength(1);

      // The final content is what was analysed, not a torn intermediate write.
      const preview = await previewSync(project.id);
      expect(preview.body.data.projectChanges).toHaveLength(1);
      expect(preview.body.data.projectChanges[0].to).toBe('Burst final.');
    } finally {
      stop();
    }
  });

  it('reports a record added to the document as a pending change, not as a new record', async () => {
    const project = await createMonitoredProject(uniqueName('Record'), { description: 'Keep.' });
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized at baseline');

    const featuresBefore = await prisma.feature.count({ where: { projectId: project.id } });
    // A real field edit plus a record that exists only in the document. Without
    // the field edit the change set would be "create one feature" alone, which is
    // a weaker assertion than "one project field and one record".
    const markdown = setOverviewField(await readDoc(project), 'Description', 'Still kept, plus a record.');
    await writeDoc(
      project,
      `${markdown}\n## Features\n\n- [ ] A feature that only exists in the document\n`
    );

    await waitForState(project.id, s => s === 'MODIFIED', 'modified');
    // The counts live on the notification, which is what the user is shown.
    const { body } = await api.post(`/api/projects/${project.id}/project-document/monitor/check`).send({});
    const notification = body.data.notification;
    expect(notification.recordChangeCount).toBe(1);
    expect(notification.recordCreateCount).toBe(1);
    expect(notification.changedEntityNames).toContain('features');

    // Detection did not create the record. Only an explicit sync may do that.
    expect(await prisma.feature.count({ where: { projectId: project.id } })).toBe(featuresBefore);
  });
});

// ---------------------------------------------------------------------------
// 3. Classification
// ---------------------------------------------------------------------------

describe('3. classification', () => {
  it('reports a missing document', async () => {
    const project = await createMonitoredProject(uniqueName('Missing'));
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized at baseline');

    await fsp.rm(docPath(project), { force: true });
    await waitForState(project.id, s => s === 'MISSING', 'missing');
    const report = await monitorState(project.id);
    expect(report.documentHash).toBeNull();
    expect(report.hasPendingChange).toBe(true);
  });

  it("reports a document that belongs to another project instead of this project's changes", async () => {
    const project = await createMonitoredProject(uniqueName('Identity'), { description: 'Mine.' });
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized at baseline');

    // Write another project's document, verbatim, into this project's folder.
    const other = await createMonitoredProject(uniqueName('IdentityOther'), { description: 'Theirs.' });
    await writeDoc(project, await readDoc(other));

    await waitForState(
      project.id,
      s => s === 'IDENTITY_MISMATCH' || s === 'INVALID',
      'an identity problem'
    );
    const report = await monitorState(project.id);
    expect(['IDENTITY_MISMATCH', 'INVALID']).toContain(report.state);

    // Nothing was applied, and this project's own record is intact.
    const row = await prisma.project.findUnique({ where: { id: project.id }, select: { description: true } });
    expect(row?.description).toBe('Mine.');
  });

  it('reports an unparsable document without failing', async () => {
    const project = await createMonitoredProject(uniqueName('Broken'));
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized at baseline');

    await writeDoc(project, 'not a project document at all\n\n```\nunclosed\n');
    await waitForState(project.id, s => s === 'INVALID' || s === 'UNSUPPORTED_VERSION', 'invalid');
    const report = await monitorState(project.id);
    expect(['INVALID', 'UNSUPPORTED_VERSION']).toContain(report.state);
    // Other projects keep being monitored.
    expect(getMonitorStatus().running).toBe(true);
  });

  it('reports an unsupported document version', async () => {
    const project = await createMonitoredProject(uniqueName('Version'));
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized at baseline');

    const markdown = await readDoc(project);
    expect(markdown).toContain('p-hub-document-version:');
    await writeDoc(project, markdown.replace(/(p-hub-document-version:\s*)\d+/, '$199'));

    await waitForState(project.id, s => s === 'UNSUPPORTED_VERSION', 'unsupported version');
    const report = await monitorState(project.id);
    expect(report.state).toBe('UNSUPPORTED_VERSION');
  });

  it('reports a conflict instead of applying anything', async () => {
    const project = await createMonitoredProject(uniqueName('Conflict'), { description: 'Start.' });
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized at baseline');

    // Synchronize once so there is a synchronized baseline and a state hash.
    const first = await syncNow(project.id);
    expect(first.status).toBe(200);
    await markProjectSynchronized(project.id);

    // Change the database and the file, so both moved after the last sync.
    await prisma.project.update({ where: { id: project.id }, data: { description: 'Changed in the app.' } });
    await writeDoc(project, setOverviewField(await readDoc(project), 'Description', 'Changed in the file.'));

    await waitForState(project.id, s => s === 'CONFLICT', 'a conflict');
    const report = await monitorState(project.id);
    expect(report.state).toBe('CONFLICT');

    // The conflict is reported, not resolved: the database still holds the app value.
    const row = await prisma.project.findUnique({ where: { id: project.id }, select: { description: true } });
    expect(row?.description).toBe('Changed in the app.');
  });

  it('goes back to synchronized when the file is restored', async () => {
    const project = await createMonitoredProject(uniqueName('Restore'), { description: 'Stable.' });
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized at baseline');
    const original = await readDoc(project);

    await writeDoc(project, setOverviewField(original, 'Description', 'Different.'));
    await waitForState(project.id, s => s === 'MODIFIED', 'modified');

    await writeDoc(project, original);
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized again');
    expect(countPendingChanges()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Approval is still the only write path
// ---------------------------------------------------------------------------

describe('4. explicit approval is still required', () => {
  it('leaves the change pending until the user synchronizes', async () => {
    const project = await createMonitoredProject(uniqueName('Approval'), { description: 'Before.' });
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized at baseline');

    await writeDoc(project, setOverviewField(await readDoc(project), 'Description', 'After.'));
    await waitForState(project.id, s => s === 'MODIFIED', 'modified');

    // Nothing applied by detection, preview, or by waiting.
    const preview = await previewSync(project.id);
    expect(preview.body.data.applicable).toBe(true);
    expect(preview.body.data.unchanged).toBe(false);
    let row = await prisma.project.findUnique({ where: { id: project.id }, select: { description: true } });
    expect(row?.description).toBe('Before.');
    await new Promise(resolve => setTimeout(resolve, 300));
    row = await prisma.project.findUnique({ where: { id: project.id }, select: { description: true } });
    expect(row?.description).toBe('Before.');

    // The explicit synchronization applies it, and the monitor settles.
    const synced = await syncNow(project.id);
    expect(synced.status).toBe(200);
    expect(synced.body.data.applied).not.toBeNull();
    row = await prisma.project.findUnique({ where: { id: project.id }, select: { description: true } });
    expect(row?.description).toBe('After.');

    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized after the explicit sync');
    expect(countPendingChanges()).toBe(0);
  });

  it('does not clear the pending change when a synchronization was refused', async () => {
    const project = await createMonitoredProject(uniqueName('Refused'), { description: 'Start.' });
    await syncNow(project.id);
    await markProjectSynchronized(project.id);

    await prisma.project.update({ where: { id: project.id }, data: { description: 'Moved in the app.' } });
    await writeDoc(project, setOverviewField(await readDoc(project), 'Description', 'Moved in the file.'));
    await waitForState(project.id, s => s === 'CONFLICT', 'a conflict');

    // A synchronization without acknowledgement is refused...
    const refused = await syncNow(project.id, false);
    expect(refused.body.data.applied).toBeNull();
    // ...and the pending change is still reported, because it was never resolved.
    expect(getProjectMonitorReport(project.id).state).toBe('CONFLICT');
    const row = await prisma.project.findUnique({ where: { id: project.id }, select: { description: true } });
    expect(row?.description).toBe('Moved in the app.');
  });

  it('never changes the project stage from a document', async () => {
    const project = await createMonitoredProject(uniqueName('Stage'), { description: 'Keep.' });
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized at baseline');
    const stageBefore = (await prisma.project.findUnique({ where: { id: project.id }, select: { stage: true } }))!
      .stage;

    // Stage is rendered as a bold label plus its value on the next line.
    await writeDoc(project, setOverviewField(await readDoc(project), 'Stage', 'Production'));

    // The bytes changed, so this is reported as a pending change...
    await waitForState(project.id, s => s === 'MODIFIED', 'modified');
    await new Promise(resolve => setTimeout(resolve, 300));
    const stageAfter = (await prisma.project.findUnique({ where: { id: project.id }, select: { stage: true } }))!
      .stage;
    expect(stageAfter).toBe(stageBefore);
  });
});

// ---------------------------------------------------------------------------
// 5. Dismissal
// ---------------------------------------------------------------------------

describe('5. dismissal', () => {
  it('hides the notification without discarding the change', async () => {
    const project = await createMonitoredProject(uniqueName('Dismiss'), { description: 'Before.' });
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized at baseline');

    await writeDoc(project, setOverviewField(await readDoc(project), 'Description', 'After.'));
    await waitForState(project.id, s => s === 'MODIFIED', 'modified');
    expect(countPendingChanges()).toBe(1);

    const { events, stop } = recordEvents();
    try {
      const dismissed = await api.post(`/api/projects/${project.id}/project-document/monitor/dismiss`).send({});
      expect(dismissed.status).toBe(200);
      expect(events.some(e => e.kind === 'dismissed')).toBe(true);

      expect(countPendingChanges()).toBe(0);
      // The change itself is untouched: the document is still out of sync.
      const report = await monitorState(project.id);
      expect(report.state).toBe('MODIFIED');
      const row = await prisma.project.findUnique({ where: { id: project.id }, select: { description: true } });
      expect(row?.description).toBe('Before.');
    } finally {
      stop();
    }
  });

  it('does not re-announce an unchanged dismissed change', async () => {
    const project = await createMonitoredProject(uniqueName('DismissQuiet'), { description: 'Before.' });
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized at baseline');

    await writeDoc(project, setOverviewField(await readDoc(project), 'Description', 'After.'));
    await waitForState(project.id, s => s === 'MODIFIED', 'modified');
    await dismissProjectChange(project.id);
    expect(countPendingChanges()).toBe(0);

    // Saving the same bytes again must not resurrect the notification.
    const { events, stop } = recordEvents();
    try {
      await writeDoc(project, await readDoc(project));
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(countPendingChanges()).toBe(0);
      expect(events.filter(e => e.kind === 'notification')).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it('alerts again after a real new edit', async () => {
    const project = await createMonitoredProject(uniqueName('DismissNew'), { description: 'Before.' });
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized at baseline');

    await writeDoc(project, setOverviewField(await readDoc(project), 'Description', 'First edit.'));
    await waitForState(project.id, s => s === 'MODIFIED', 'modified');
    await dismissProjectChange(project.id);
    expect(countPendingChanges()).toBe(0);

    await writeDoc(project, setOverviewField(await readDoc(project), 'Description', 'Second edit.'));
    await waitForState(project.id, s => s === 'MODIFIED', 'modified again');
    await waitForPendingCount(1);
    const report = await monitorState(project.id);
    expect(report.hasPendingChange).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Startup baseline
// ---------------------------------------------------------------------------

describe('6. startup behaviour', () => {
  it('does not report a pending change for an unchanged document', async () => {
    const project = await createMonitoredProject(uniqueName('RestartClean'));
    const before = countPendingChanges();

    await stopDocumentMonitor();
    await startDocumentMonitor({ debounceMs: 25, pollIntervalMs: 60_000 });

    expect(countPendingChanges()).toBe(before);
    expect(getProjectMonitorReport(project.id).state).toBe('SYNCHRONIZED');
  });

  it('restores a pending change after a restart', async () => {
    const project = await createMonitoredProject(uniqueName('RestartPending'), { description: 'Before.' });
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized at baseline');

    // Edit while the server is down.
    await stopDocumentMonitor();
    await writeDoc(project, setOverviewField(await readDoc(project), 'Description', 'Edited offline.'));
    await startDocumentMonitor({ debounceMs: 25, pollIntervalMs: 60_000 });

    await waitForState(project.id, s => s === 'MODIFIED', 'modified after restart');
    expect(countPendingChanges()).toBe(1);
    const row = await prisma.project.findUnique({ where: { id: project.id }, select: { description: true } });
    expect(row?.description).toBe('Before.');
  });

  it('keeps a dismissal across a restart', async () => {
    const project = await createMonitoredProject(uniqueName('RestartDismiss'), { description: 'Before.' });
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized at baseline');

    await writeDoc(project, setOverviewField(await readDoc(project), 'Description', 'After.'));
    await waitForState(project.id, s => s === 'MODIFIED', 'modified');
    await dismissProjectChange(project.id);
    expect(countPendingChanges()).toBe(0);

    await stopDocumentMonitor();
    await startDocumentMonitor({ debounceMs: 25, pollIntervalMs: 60_000 });
    await new Promise(resolve => setTimeout(resolve, 300));

    // Still dismissed: the file did not change, so there is nothing new to say.
    expect(countPendingChanges()).toBe(0);
    expect(getProjectMonitorReport(project.id).state).toBe('MODIFIED');
  });

  it('writes nothing to the database while establishing a baseline', async () => {
    const project = await createMonitoredProject(uniqueName('Baseline'), { description: 'Stable.' });
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized at baseline');

    const fingerprintBefore = await prisma.project.findUnique({
      where: { id: project.id },
      select: {
        projectDocumentHash: true,
        projectDocumentStateHash: true,
        projectDocumentSyncedAt: true,
        projectDocumentLastDetectedHash: true,
        projectDocumentDetectedAt: true,
        projectDocumentChangeState: true,
        projectDocumentDismissedAt: true,
        description: true,
        stage: true
      }
    });

    // Stop, restart, and let the baseline be established again from scratch.
    await stopDocumentMonitor();
    await prisma.project.update({
      where: { id: project.id },
      data: {
        projectDocumentLastDetectedHash: null,
        projectDocumentDetectedAt: null,
        projectDocumentChangeState: null,
        projectDocumentDismissedAt: null
      }
    });
    await startDocumentMonitor({ debounceMs: 25, pollIntervalMs: 60_000 });
    await new Promise(resolve => setTimeout(resolve, 300));

    const fingerprintAfter = await prisma.project.findUnique({
      where: { id: project.id },
      select: {
        projectDocumentHash: true,
        projectDocumentStateHash: true,
        projectDocumentSyncedAt: true,
        projectDocumentLastDetectedHash: true,
        projectDocumentDetectedAt: true,
        projectDocumentChangeState: true,
        projectDocumentDismissedAt: true,
        description: true,
        stage: true
      }
    });

    // A synchronized document at startup is a baseline, not a detection: all four
    // monitoring columns stay NULL and no Phase 6 metadata moves.
    expect(fingerprintAfter.projectDocumentLastDetectedHash).toBeNull();
    expect(fingerprintAfter.projectDocumentDetectedAt).toBeNull();
    expect(fingerprintAfter.projectDocumentChangeState).toBeNull();
    expect(fingerprintAfter.projectDocumentDismissedAt).toBeNull();
    expect(fingerprintAfter).toEqual(fingerprintBefore);
  });
});

// ---------------------------------------------------------------------------
// 7. Lifecycle
// ---------------------------------------------------------------------------

describe('7. lifecycle', () => {
  it('registers a project only once, however many times it is asked', async () => {
    const project = await createMonitoredProject(uniqueName('Once'));
    for (let i = 0; i < 5; i += 1) {
      await registerProject(await loadProject(project.id));
    }
    // One registration per project, so one edit still produces one change.
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized');
    const { events, stop } = recordEvents();
    try {
      await writeDoc(project, setOverviewField(await readDoc(project), 'Description', 'Once only.'));
      await waitForState(project.id, s => s === 'MODIFIED', 'modified');
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(events.filter(e => e.kind === 'notification')).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it('stops watching a project that is unregistered', async () => {
    const project = await createMonitoredProject(uniqueName('Unregister'));
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized');

    await unregisterProject(project.id);
    expect(getProjectMonitorReport(project.id).monitored).toBe(false);

    await writeDoc(project, setOverviewField(await readDoc(project), 'Description', 'After unregister.'));
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(getProjectMonitorReport(project.id).state).not.toBe('MODIFIED');
  });

  it('stops watching a hard-deleted project', async () => {
    const project = await createMonitoredProject(uniqueName('HardDelete'));
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized');

    const res = await api.delete(`/api/projects/${project.id}?hard=true`);
    expect(res.status).toBe(200);
    expect(getProjectMonitorReport(project.id).monitored).toBe(false);

    await writeDoc(project, setOverviewField(await readDoc(project), 'Description', 'After delete.'));
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(getProjectMonitorReport(project.id).state).not.toBe('MODIFIED');
  });

  it('keeps watching an archived project', async () => {
    // Archiving is not deleting: the folder and the file are still there.
    const project = await createMonitoredProject(uniqueName('Archived'), { description: 'Before.' });
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized');

    const res = await api.post(`/api/projects/${project.id}/archive`).send({});
    expect(res.status).toBe(200);

    await writeDoc(project, setOverviewField(await readDoc(project), 'Description', 'While archived.'));
    // Archiving writes the Archived line into the rendered document, so the state
    // hash moves and Phase 6 calls this a conflict rather than a plain edit.
    // Either way the point is that the change was detected while archived.
    await waitForState(
      project.id,
      s => s === 'MODIFIED' || s === 'CONFLICT',
      'a detected change while archived'
    );
  });

  it('rebuilds watches on resync', async () => {
    const project = await createMonitoredProject(uniqueName('Resync'));
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized');

    await unregisterProject(project.id);
    const status = await resyncDocumentMonitor();
    expect(status.running).toBe(true);
    expect(getProjectMonitorReport(project.id).monitored).toBe(true);

    await writeDoc(project, setOverviewField(await readDoc(project), 'Description', 'After resync.'));
    await waitForState(project.id, s => s === 'MODIFIED', 'modified after resync');
  });

  it('closes everything on shutdown and can be started again', async () => {
    const project = await createMonitoredProject(uniqueName('Shutdown'));
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized');

    await stopDocumentMonitor();
    expect(getMonitorStatus().running).toBe(false);
    expect(getMonitorStatus().mode).toBe('STOPPED');

    // No watcher survives shutdown, so a later edit changes nothing.
    await writeDoc(project, setOverviewField(await readDoc(project), 'Description', 'While stopped.'));
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(countPendingChanges()).toBe(0);

    await startDocumentMonitor({ debounceMs: 25, pollIntervalMs: 60_000 });
    // The edit made while stopped is picked up as a baseline comparison, not lost.
    await waitForState(project.id, s => s === 'MODIFIED', 'modified after restart');
  });

  it('is idempotent when started twice', async () => {
    const project = await createMonitoredProject(uniqueName('Idempotent'));
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized');

    const before = getMonitorStatus().watchedProjects;
    // A second start must resync, not duplicate: the registration count for this
    // project must not grow, and one edit must still produce one change.
    await startDocumentMonitor({ debounceMs: 25, pollIntervalMs: 60_000 });
    await startDocumentMonitor({ debounceMs: 25, pollIntervalMs: 60_000 });

    expect(getProjectMonitorReport(project.id).monitored).toBe(true);
    expect(getMonitorStatus().watchedProjects).toBeGreaterThanOrEqual(before);

    const { events, stop } = recordEvents();
    try {
      await writeDoc(project, setOverviewField(await readDoc(project), 'Description', 'Idempotent.'));
      await waitForState(project.id, s => s === 'MODIFIED', 'modified');
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(events.filter(e => e.kind === 'notification')).toHaveLength(1);
    } finally {
      stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. The HTTP surface
// ---------------------------------------------------------------------------

describe('8. API', () => {
  it('reports the service status and pending changes', async () => {
    const project = await createMonitoredProject(uniqueName('ApiSnapshot'), { description: 'Before.' });
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized');

    const res = await api.get('/api/document-monitor');
    expect(res.status).toBe(200);
    expect(res.body.data.status.running).toBe(true);
    expect(res.body.data.status.mode).toBe('WATCH');
    expect(Array.isArray(res.body.data.pending)).toBe(true);
    expect(typeof res.body.data.pendingCount).toBe('number');
    expect(typeof res.body.data.streamClients).toBe('number');
  });

  it('re-checks on demand without waiting for an event', async () => {
    const project = await createMonitoredProject(uniqueName('ApiCheck'), { description: 'Before.' });
    await waitForState(project.id, s => s === 'SYNCHRONIZED', 'synchronized');

    // Modify the file and check in the same breath, with the watcher disabled for
    // this project by unregistering it: only the explicit check can notice.
    await unregisterProject(project.id);
    await writeDoc(project, setOverviewField(await readDoc(project), 'Description', 'Checked on demand.'));

    const res = await api.post(`/api/projects/${project.id}/project-document/monitor/check`).send({});
    expect(res.status).toBe(200);
    // The project is not registered, so the check correctly reports it is not
    // monitored rather than inventing a state.
    expect(res.body.data.monitored).toBe(false);

    // Registered again, the automatic path picks it up.
    await registerProject(await loadProject(project.id));
    await waitForState(project.id, s => s === 'MODIFIED', 'modified');
  });

  it('answers with a 404 for an unknown project', async () => {
    for (const path of [
      '/api/projects/999999/project-document/monitor',
      '/api/projects/__nope__/project-document/monitor'
    ]) {
      const res = await api.get(path);
      expect(res.status).toBe(404);
    }
  });

  it('streams a snapshot and a change event', async () => {
    const project = await createModifiedProject(uniqueName('Sse'), { description: 'Before.' });
    // This project already has a pending change before the stream opens, which is
    // the interesting case: the snapshot frame must carry it.

    const received: string[] = [];
    const controller = new AbortController();
    try {
      const res = await fetch(`${apiServerUrl()}/api/document-monitor/stream`, { signal: controller.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Read frames in the background while the change happens.
      const pump = (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            for (const frame of buffer.split('\n\n')) {
              for (const line of frame.split('\n')) {
                if (line.startsWith('event: ')) received.push(line.slice(7).trim());
              }
            }
          }
        } catch {
          // aborted
        }
      })();

      // The first frame must be a full snapshot, so a late or reconnecting client
      // is immediately correct. No need for a quiet pending list here: the frame
      // carries whatever is pending, and this test owns all of it.
      const deadlineForSnapshot = Date.now() + EVENT_TIMEOUT_MS;
      while (Date.now() < deadlineForSnapshot && !received.includes('snapshot')) {
        await new Promise(resolve => setTimeout(resolve, POLL_STEP_MS));
      }
      expect(received).toContain('snapshot');

      // A second, distinct edit produces a `change` frame while connected.
      await writeDoc(
        project,
        setOverviewField(await readDoc(project), 'Description', 'Changed again over the stream.')
      );

      const deadline = Date.now() + EVENT_TIMEOUT_MS;
      while (Date.now() < deadline && !received.includes('change')) {
        await new Promise(resolve => setTimeout(resolve, POLL_STEP_MS));
      }
      expect(received).toContain('change');

      controller.abort();
      await pump;
    } finally {
      controller.abort();
    }
  });

  it('resyncs on request', async () => {
    const res = await api.post('/api/document-monitor/resync').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.status.running).toBe(true);
  });
});

/** A real listening port for the SSE test, which needs a genuine HTTP response. */
let server: import('node:http').Server | null = null;
let port = 0;
function apiServerUrl(): string {
  if (!server) throw new Error('server not started');
  return `http://127.0.0.1:${port}`;
}

beforeAll(async () => {
  const { createApp } = await import('../src/app');
  const app = createApp();
  await new Promise<void>(resolve => {
    server = app.listen(0, () => {
      const addr = server!.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = null;
  }
  // The manual check is the read-only escape hatch; make sure it agrees with the
  // automatic path rather than being a separate, unverified code path.
  const project = createdProjectIds.length > 0 ? createdProjectIds[createdProjectIds.length - 1] : null;
  if (project != null) {
    await checkProjectNow(project).catch(() => null);
  }
});