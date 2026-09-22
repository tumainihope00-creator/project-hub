import { z } from 'zod';
import { toDate } from './activity.js';

export const optStr = z.string().trim().max(20000).optional().nullable().transform(v => (v === null || v === '' ? null : v));
export const optText = z.string().trim().max(100000).optional().nullable().transform(v => (v === null || v === '' ? null : v));
export const optInt = z.number().int().optional().nullable();
// Empty/missing dates are omitted entirely (undefined) so Prisma applies column
// defaults instead of receiving an explicit `null` on non-nullable DateTime columns.
export const isoDate = z
  .union([z.string(), z.date()])
  .optional()
  .nullable()
  .transform(v => toDate(v as string | Date | null | undefined) ?? undefined);
export const reqStr = z.string().trim().min(1).max(20000);

export const enumField = <T extends string>(values: readonly T[], optional: boolean) => {
  const base = z.enum([...values] as unknown as [string, ...string[]]);
  return optional ? base.optional().nullable() : base;
};

export const taggableType = z.enum(['project', 'task', 'issue', 'research', 'prompt', 'document', 'note']);

export function intFromQuery(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}