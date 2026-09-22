import 'dotenv/config';
import request from 'supertest';
import { createApp, prisma } from '../src/app';

export const app = createApp();
export const api = request(app);

let counter = 0;

export function uniqueName(prefix = 'Smoke'): string {
  counter += 1;
  return `__TEST__ ${prefix} ${Date.now()}-${counter}`;
}

export async function createProject(name = uniqueName('Project')) {
  const res = await api.post('/api/projects').send({ name, description: 'test project' });
  if (res.status !== 201) {
    throw new Error(`Failed to create test project (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body.data as { id: number; slug: string; name: string; stage: string };
}

export async function destroyProject(id: number) {
  await api.delete(`/api/projects/${id}?hard=true`);
}

export { prisma };
