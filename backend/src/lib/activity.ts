import { ActivityType, Prisma, PrismaClient } from '@prisma/client';
import { prisma } from './prisma.js';

export interface ActivityInput {
  projectId: number;
  type: ActivityType;
  description: string;
  metadata?: Record<string, unknown>;
  relatedType?: string;
  relatedId?: number;
}

/**
 * Writes an activity row. Pass a transaction client to keep the row inside a
 * caller's transaction; omitting it uses the shared client, which is what the
 * ordinary request handlers do.
 */
export async function logActivity(input: ActivityInput, client: Prisma.TransactionClient | PrismaClient = prisma): Promise<void> {
  await client.activityEvent.create({
    data: {
      projectId: input.projectId,
      type: input.type,
      description: input.description,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      relatedType: input.relatedType ?? null,
      relatedId: input.relatedId ?? null
    }
  });
}

/** Turn an ISO date/string into a Date, tolerating null/undefined. */
export function toDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return null;
  return d;
}

/** Format a big object of fields into a single-line description fragment. */
export function describeFields(obj: Record<string, unknown>, fields: string[]): string {
  const parts: string[] = [];
  for (const f of fields) {
    const v = obj[f];
    if (v !== undefined && v !== null && v !== '') parts.push(`${f}: ${String(v)}`);
  }
  return parts.join(', ');
}

export function cleanForDb(obj: Record<string, unknown>): Prisma.InputJsonValue {
  return obj as Prisma.InputJsonValue;
}