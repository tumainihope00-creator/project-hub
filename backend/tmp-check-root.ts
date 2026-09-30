import { prisma } from './src/lib/prisma.js';

const projects = await prisma.project.findMany({ orderBy: { id: 'asc' } });
console.log('project count:', projects.length);
console.log('\nprojects with a folderPath:', projects.filter(p => p.folderPath).length);
console.log('\nany test-looking projects:');
for (const p of projects) {
  if (/__TEST__|Manual Phase4|phub-/i.test(p.name) || /__test-/i.test(p.slug)) {
    console.log(`  id=${p.id} name=${JSON.stringify(p.name)} slug=${p.slug} folder=${p.folderPath}`);
  }
}
console.log('\nall projects:');
for (const p of projects) {
  console.log(`  ${String(p.id).padStart(4)}  ${p.name}  folder=${p.folderPath ?? '(none)'}`);
}
const settings = await prisma.appSetting.findMany();
console.log('\napp_settings:', JSON.stringify(settings));
await prisma.$disconnect();
