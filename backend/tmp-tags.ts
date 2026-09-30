import { prisma } from './src/lib/prisma.js';

const { count } = await prisma.tag.deleteMany({
  where: { id: 37, name: 'phase4', createdAt: new Date('2026-09-30T07:44:12.148Z') }
});
console.log('deleted rows:', count);
console.log('tags now:', await prisma.tag.count());
await prisma.$disconnect();
