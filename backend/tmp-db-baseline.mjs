import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';

const p = new PrismaClient();

const projects = await p.project.findMany({ orderBy: { id: 'asc' } });

const tables = [
  ['projects', p.project],
  ['research_entries', p.researchEntry],
  ['research_questions', p.researchQuestion],
  ['requirements', p.requirement],
  ['features', p.feature],
  ['feature_requirements', p.featureRequirement],
  ['architecture_decisions', p.architectureDecision],
  ['tech_stack', p.techStackItem],
  ['database_tables', p.databaseTable],
  ['api_endpoints', p.apiEndpoint],
  ['milestones', p.milestone],
  ['tasks', p.task],
  ['issues', p.issue],
  ['development_sessions', p.developmentSession],
  ['ai_sessions', p.aiSession],
  ['prompts', p.prompt],
  ['prompt_versions', p.promptVersion],
  ['prompt_generations', p.promptGeneration],
  ['project_documents', p.projectDocument],
  ['document_versions', p.projectDocumentVersion],
  ['notes', p.note],
  ['deployments', p.deployment],
  ['production_incidents', p.productionIncident],
  ['git_references', p.gitReference],
  ['activity_events', p.activityEvent],
  ['project_relationships', p.projectRelationship],
  ['attachments', p.attachment],
  ['tags', p.tag],
  ['tag_assignments', p.tagAssignment],
  ['app_settings', p.appSetting]
];

const counts = {};
for (const [name, delegate] of tables) {
  counts[name] = await delegate.count();
}

const projectRows = projects.map(x => ({
  id: x.id,
  slug: x.slug,
  name: x.name,
  stage: x.stage,
  description: x.description,
  problem: x.problem,
  motivation: x.motivation,
  targetUsers: x.targetUsers,
  expectedValue: x.expectedValue,
  assumptions: x.assumptions,
  initialQuestions: x.initialQuestions,
  inspiration: x.inspiration,
  v1Scope: x.v1Scope,
  originalIdea: x.originalIdea,
  repositoryUrl: x.repositoryUrl,
  isArchived: x.isArchived,
  archivedAt: x.archivedAt?.toISOString() ?? null,
  folderName: x.folderName,
  folderPath: x.folderPath,
  createdAt: x.createdAt.toISOString(),
  updatedAt: x.updatedAt.toISOString()
}));

const json = JSON.stringify({ projectRows, counts });
console.log('tableCount=' + Object.keys(counts).length);
console.log('projectCount=' + projects.length);
console.log('counts=' + JSON.stringify(counts));
console.log('fingerprint=' + createHash('sha256').update(json).digest('hex'));
await p.$disconnect();
