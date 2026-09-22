import { z } from 'zod';
import { prisma } from './prisma.js';
import { taggableType } from './validation.js';

export type TaggableType = z.infer<typeof taggableType>;

const MODEL_TO_TAGGABLE: Record<string, TaggableType> = {
  researchEntry: 'research',
  task: 'task',
  issue: 'issue',
  prompt: 'prompt',
  projectDocument: 'document',
  note: 'note'
};

export function taggableKeyFor(model: string): TaggableType | null {
  return MODEL_TO_TAGGABLE[model] ?? null;
}

export function isTaggableType(value: string): value is TaggableType {
  return taggableType.safeParse(value).success;
}

export async function tagsFor(taggableType: string, taggableId: number) {
  const rows = await prisma.tagAssignment.findMany({
    where: { taggableType, taggableId },
    include: { tag: true },
    orderBy: { tag: { name: 'asc' } }
  });
  return rows.map(r => r.tag);
}

export async function setTags(type: TaggableType, taggableId: number, names: string[]): Promise<void> {
  const cleaned = [...new Set(names.map(n => n.trim().toLowerCase().replace(/\s+/g, '-')).filter(n => n.length > 0))];
  const existingAssignments = await prisma.tagAssignment.findMany({ where: { taggableType: type, taggableId } });
  const existingTagIds = new Set(existingAssignments.map(a => a.tagId));

  const tagIds: number[] = [];
  for (const name of cleaned) {
    let tag = await prisma.tag.findUnique({ where: { name } });
    if (!tag) tag = await prisma.tag.create({ data: { name } });
    tagIds.push(tag.id);
    if (!existingTagIds.has(tag.id)) {
      await prisma.tagAssignment.create({ data: { tagId: tag.id, taggableType: type, taggableId } });
    }
  }

  const keep = new Set(tagIds);
  for (const a of existingAssignments) {
    if (!keep.has(a.tagId)) {
      await prisma.tagAssignment.delete({ where: { id: a.id } });
    }
  }
}

export async function addTags(type: TaggableType, taggableId: number, names: string[]): Promise<void> {
  for (const name of names) {
    const cleaned = name.trim().toLowerCase().replace(/\s+/g, '-');
    if (!cleaned) continue;
    let tag = await prisma.tag.findUnique({ where: { name: cleaned } });
    if (!tag) tag = await prisma.tag.create({ data: { name: cleaned } });
    const existing = await prisma.tagAssignment.findUnique({
      where: { tagId_taggableType_taggableId: { tagId: tag.id, taggableType: type, taggableId } }
    });
    if (!existing) {
      await prisma.tagAssignment.create({ data: { tagId: tag.id, taggableType: type, taggableId } });
    }
  }
}

export async function removeTag(type: TaggableType, taggableId: number, tagId: number): Promise<void> {
  await prisma.tagAssignment.deleteMany({ where: { taggableType: type, taggableId, tagId } });
}

export async function tagUsage(): Promise<Array<{ id: number; name: string; color: string | null; count: number }>> {
  const groups = await prisma.tagAssignment.groupBy({ by: ['tagId'], _count: true });
  const tags = await prisma.tag.findMany({ orderBy: { name: 'asc' } });
  const map = new Map(groups.map(g => [g.tagId, g._count]));
  return tags.map(t => ({ id: t.id, name: t.name, color: t.color, count: map.get(t.id) ?? 0 }));
}