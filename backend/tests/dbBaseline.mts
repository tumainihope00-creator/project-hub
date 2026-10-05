import 'dotenv/config';
import { createHash } from 'node:crypto';
import { prisma } from '../src/lib/prisma';

/**
 * Phase 7 database safety baseline / verification snapshot.
 *
 * Strictly read-only. Prints project count, project ids, per-table row counts,
 * per-project child record counts and a sha256 fingerprint of every project row
 * (including the Phase 6 sync metadata) so two snapshots can be compared.
 */

const TABLES = [
  'projects',
  'requirements',
  'features',
  'architecture_decisions',
  'tech_stack',
  'database_tables',
  'api_endpoints',
  'research_entries',
  'research_questions',
  'milestones',
  'tasks',
  'issues',
  'notes',
  'deployments',
  'git_references',
  'activity_events',
  'project_relationships',
  'tags',
  'tag_assignments'
] as const;

async function main() {
  const projects = await prisma.project.findMany({ orderBy: { id: 'asc' } });

  const tableCounts: Record<string, number> = {};
  for (const table of TABLES) {
    const rows = await prisma.$queryRawUnsafe<{ c: number }[]>(
      `SELECT COUNT(*)::int AS c FROM "${table}"`
    );
    tableCounts[table] = rows[0].c;
  }

  const childCountsByProject: Record<string, Record<string, number>> = {};
  for (const p of projects) {
    const where = { projectId: p.id };
    childCountsByProject[String(p.id)] = {
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

  const fingerprint = JSON.stringify(
    projects.map(p => ({
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

  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        projectCount: projects.length,
        projectIds: projects.map(p => p.id),
        tableCounts,
        childCountsByProject,
        fingerprintSha256: createHash('sha256').update(fingerprint, 'utf8').digest('hex')
      },
      null,
      2
    )
  );

  await prisma.$disconnect();
}

main().catch(async err => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
