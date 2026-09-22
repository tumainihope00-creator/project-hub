import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createProject, destroyProject, prisma, uniqueName } from './helpers';

let project: { id: number; slug: string; name: string; stage: string };

beforeAll(async () => {
  project = await createProject(uniqueName('Suite'));
});

afterAll(async () => {
  if (project?.id) await destroyProject(project.id);
  await prisma.$disconnect();
});

const base = () => `/api/projects/${project.id}`;

describe('health & meta', () => {
  it('reports health', async () => {
    const res = await api.get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
  });

  it('lists resources', async () => {
    const res = await api.get('/api/meta');
    expect(res.status).toBe(200);
    expect(res.body.data.resources).toContain('tasks');
    expect(res.body.data.resources).toContain('prompts');
  });
});

describe('projects', () => {
  it('creates a project with slug and original idea snapshot', async () => {
    expect(project.slug).toBeTruthy();
    const res = await api.get(`${base()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.slug).toBe(project.slug);
    expect(typeof res.body.data.originalIdea).toBe('string');
    const idea = JSON.parse(res.body.data.originalIdea);
    expect(idea.name).toBe(project.name);
  });

  it('rejects a project without a name', async () => {
    const res = await api.post('/api/projects').send({ description: 'no name' });
    expect(res.status).toBe(400);
  });

  it('returns stats and tags on the single-project endpoint (UI rendering contract)', async () => {
    const res = await api.get(`${base()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.stats).toBeTruthy();
    expect(typeof res.body.data.stats.progress).toBe('number');
    expect(typeof res.body.data.stats.tasksTotal).toBe('number');
    expect(typeof res.body.data.stats.prompts).toBe('number');
    expect(Array.isArray(res.body.data.tags)).toBe(true);
  });

  it('appears in the list and supports search', async () => {
    const all = await api.get('/api/projects?archived=all');
    expect(all.status).toBe(200);
    expect(all.body.data.some((p: any) => p.id === project.id)).toBe(true);

    const found = await api.get(`/api/projects?archived=all&q=${encodeURIComponent(project.name)}`);
    expect(found.body.data.some((p: any) => p.id === project.id)).toBe(true);

    const missing = await api.get('/api/projects?archived=all&q=zzz-no-such-project-zzz');
    expect(missing.body.data.some((p: any) => p.id === project.id)).toBe(false);
  });

  it('returns an overview with stats', async () => {
    const res = await api.get(`${base()}/overview`);
    expect(res.status).toBe(200);
    expect(res.body.data.project.id).toBe(project.id);
    expect(res.body.data.stats).toBeTruthy();
    expect(Array.isArray(res.body.data.recentActivity)).toBe(true);
  });

  it('changes stage and records a timeline event', async () => {
    const res = await api.post(`${base()}/stage`).send({ stage: 'BUILDING', note: 'kickoff' });
    expect(res.status).toBe(200);
    expect(res.body.data.stage).toBe('BUILDING');

    const timeline = await api.get(`${base()}/timeline`);
    expect(timeline.status).toBe(200);
    const types = timeline.body.data.flatMap((group: any) => group.items.map((e: any) => e.type));
    expect(types).toContain('STAGE_CHANGED');
  });
});

describe('tasks', () => {
  let taskId = 0;

  it('creates a task with an auto-generated code', async () => {
    const res = await api.post(`${base()}/tasks`).send({ title: 'Write tests', priority: 'HIGH' });
    expect(res.status).toBe(201);
    expect(res.body.data.code).toMatch(/^TASK-\d+$/);
    taskId = res.body.data.id;
  });

  it('sets and clears tags', async () => {
    const set = await api.put(`${base()}/tasks/${taskId}`).send({ tags: ['alpha', 'beta'] });
    expect(set.status).toBe(200);
    expect(set.body.data.tags.sort()).toEqual(['alpha', 'beta']);

    const listed = await api.get(`${base()}/tasks?q=Write tests`);
    const row = listed.body.data.find((t: any) => t.id === taskId);
    expect(row.tags.sort()).toEqual(['alpha', 'beta']);

    const cleared = await api.put(`${base()}/tasks/${taskId}`).send({ tags: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.tags).toEqual([]);
  });

  it('stamps completedAt when completed', async () => {
    const res = await api.put(`${base()}/tasks/${taskId}`).send({ status: 'COMPLETED' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('COMPLETED');
    expect(res.body.data.completedAt).toBeTruthy();
  });

  it('rejects a task under a non-existent project (FK integrity)', async () => {
    const res = await api.post('/api/projects/99999999/tasks').send({ title: 'orphan' });
    expect(res.status).toBe(409);
  });
});

describe('requirements, features & linking', () => {
  it('links and unlinks a requirement to a feature', async () => {
    const feature = await api.post(`${base()}/features`).send({ name: 'Auth' });
    const requirement = await api.post(`${base()}/requirements`).send({ title: 'Login required' });
    expect(feature.status).toBe(201);
    expect(requirement.status).toBe(201);
    expect(requirement.body.data.code).toMatch(/^REQ-\d+$/);

    const link = await api
      .post(`${base()}/features/${feature.body.data.id}/requirements`)
      .send({ requirementId: requirement.body.data.id });
    expect(link.status).toBe(201);

    const linked = await api.get(`${base()}/features/${feature.body.data.id}/requirements`);
    expect(linked.body.data).toHaveLength(1);
    expect(linked.body.data[0].id).toBe(requirement.body.data.id);

    const bad = await api
      .post(`${base()}/features/${feature.body.data.id}/requirements`)
      .send({ requirementId: 99999999 });
    expect(bad.status).toBe(404);

    const unlink = await api.delete(
      `${base()}/features/${feature.body.data.id}/requirements/${requirement.body.data.id}`
    );
    expect(unlink.status).toBe(200);
    const after = await api.get(`${base()}/features/${feature.body.data.id}/requirements`);
    expect(after.body.data).toHaveLength(0);
  });
});

describe('prompt versioning', () => {
  it('creates v1, adds a version, and keeps history on metadata update', async () => {
    const created = await api.post(`${base()}/prompts`).send({ title: 'Refactor helper', text: 'first prompt' });
    expect(created.status).toBe(201);
    const promptId = created.body.data.id;

    const v1 = await api.get(`${base()}/prompts/${promptId}/versions`);
    expect(v1.body.data).toHaveLength(1);
    expect(v1.body.data[0].version).toBe(1);

    const added = await api.post(`${base()}/prompts/${promptId}/versions`).send({ text: 'second prompt', changes: 'tweak' });
    expect(added.status).toBe(201);

    const updated = await api.put(`${base()}/prompts/${promptId}`).send({ title: 'Refactor helper v2' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.title).toBe('Refactor helper v2');

    const v2 = await api.get(`${base()}/prompts/${promptId}/versions`);
    expect(v2.body.data).toHaveLength(2);
    expect(v2.body.data[0].version).toBe(2);
  });
});

describe('document versioning', () => {
  it('creates a document with v1 and bumps version on content change', async () => {
    const created = await api.post(`${base()}/documents`).send({ title: 'README', type: 'README', content: 'hello' });
    expect(created.status).toBe(201);
    expect(created.body.data.currentVersion).toBe(1);
    const docId = created.body.data.id;

    const updated = await api.put(`${base()}/documents/${docId}`).send({ content: 'hello world', reason: 'expand' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.currentVersion).toBe(2);

    const versions = await api.get(`${base()}/documents/${docId}/versions`);
    expect(versions.body.data).toHaveLength(2);
    expect(versions.body.data[0].version).toBe(2);
    expect(versions.body.data[0].reason).toBe('expand');
  });
});

describe('assorted resources', () => {
  it('creates research, decisions and tech stack entries', async () => {
    const research = await api.post(`${base()}/research`).send({ title: 'Compare ORMs' });
    expect(research.status).toBe(201);

    const decision = await api.post(`${base()}/decisions`).send({ title: 'Use Prisma' });
    expect(decision.status).toBe(201);

    const stack = await api.post(`${base()}/tech-stack`).send({ technology: 'PostgreSQL', category: 'DATABASE' });
    expect(stack.status).toBe(201);
  });

  it('creates an issue and resolves it', async () => {
    const created = await api.post(`${base()}/issues`).send({ title: 'Flaky test' });
    expect(created.status).toBe(201);
    expect(created.body.data.code).toMatch(/^ISSUE-\d+$/);

    const resolved = await api.put(`${base()}/issues/${created.body.data.id}`).send({ status: 'RESOLVED' });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data.status).toBe('RESOLVED');
  });

  it('creates a deployment', async () => {
    const res = await api.post(`${base()}/deployments`).send({ environment: 'PRODUCTION', version: '1.0.0' });
    expect(res.status).toBe(201);
    expect(res.body.data.environment).toBe('PRODUCTION');
  });
});

describe('archive lifecycle', () => {
  it('archives and reactivates a project', async () => {
    const archived = await api.delete(`${base()}`);
    expect(archived.status).toBe(200);
    expect(archived.body.data.archived).toBe(true);

    const onlyArchived = await api.get('/api/projects?archived=only');
    expect(onlyArchived.body.data.some((p: any) => p.id === project.id)).toBe(true);

    const active = await api.get('/api/projects?archived=active');
    expect(active.body.data.some((p: any) => p.id === project.id)).toBe(false);

    const reactivated = await api.post(`${base()}/activate`);
    expect(reactivated.status).toBe(200);
    expect(reactivated.body.data.isArchived).toBe(false);
  });
});
