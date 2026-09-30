import fsp from 'node:fs/promises';
import path from 'node:path';
import { prisma } from './src/lib/prisma.js';
import { previewProjectDocument } from './src/lib/projectDocument.js';

const rows = await prisma.project.findMany({
  select: {
    id: true,
    name: true,
    _count: { select: { features: true, tasks: true, issues: true, notes: true } }
  },
  orderBy: { id: 'asc' }
});
const busiest = [...rows].sort(
  (a, b) =>
    b._count.features + b._count.tasks + b._count.issues + b._count.notes -
    (a._count.features + a._count.tasks + a._count.issues + a._count.notes)
)[0];

const first = await previewProjectDocument(rows[0].id);
const second = await previewProjectDocument(rows[0].id);
const busy = await previewProjectDocument(busiest.id);

console.log('rendered bytes:', Buffer.byteLength(first.markdown, 'utf8'));
console.log('deterministic across two reads:', first.markdown === second.markdown);
console.log('busiest project:', busiest.name, busiest.id);
console.log('=================== SAMPLE (project 1) ===================');
console.log(first.markdown);
console.log('=================== BUSIEST: first 60 lines ===================');
console.log(busy.markdown.split('\n').slice(0, 60).join('\n'));
console.log('=================== BUSIEST: headings ===================');
console.log(
  busy.markdown
    .split('\n')
    .filter(l => l.startsWith('#'))
    .join('\n')
);

// Written out so the frontend renderer check can render real documents.
const dir = process.env.SAMPLE_DIR ?? '.';
await fsp.writeFile(path.join(dir, 'sample-a.md'), first.markdown, 'utf8');
await fsp.writeFile(path.join(dir, 'sample-b.md'), busy.markdown, 'utf8');
console.log('wrote samples to', dir);
await prisma.$disconnect();
