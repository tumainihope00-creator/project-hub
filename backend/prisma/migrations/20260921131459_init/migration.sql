-- CreateEnum
CREATE TYPE "LifecycleStage" AS ENUM ('IDEA', 'RESEARCH', 'PLANNING', 'ARCHITECTURE', 'BUILDING', 'TESTING', 'DEPLOYMENT', 'PRODUCTION', 'MAINTENANCE', 'PAUSED', 'COMPLETED', 'ARCHIVED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'BLOCKED', 'TESTING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "IssueSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'FIXING', 'TESTING', 'RESOLVED', 'CLOSED', 'WONT_FIX');

-- CreateEnum
CREATE TYPE "RequirementType" AS ENUM ('FUNCTIONAL', 'NON_FUNCTIONAL', 'CONSTRAINT');

-- CreateEnum
CREATE TYPE "RequirementStatus" AS ENUM ('PROPOSED', 'APPROVED', 'IN_PROGRESS', 'IMPLEMENTED', 'DEFERRED', 'REJECTED');

-- CreateEnum
CREATE TYPE "FeatureStatus" AS ENUM ('PLANNED', 'BUILDING', 'TESTING', 'COMPLETED', 'DROPPED');

-- CreateEnum
CREATE TYPE "ResearchType" AS ENUM ('TECHNICAL', 'MARKET', 'USER', 'COMPETITOR', 'ACADEMIC', 'SECURITY', 'ARCHITECTURE', 'TECHNOLOGY', 'LEGAL', 'OTHER');

-- CreateEnum
CREATE TYPE "ResearchQuestionStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'ANSWERED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ADRStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'SUPERSEDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MilestoneStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'DELAYED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PromptResult" AS ENUM ('SUCCESSFUL', 'PARTIALLY_SUCCESSFUL', 'FAILED', 'REJECTED', 'NEEDS_MODIFICATION');

-- CreateEnum
CREATE TYPE "DeploymentEnvironment" AS ENUM ('LOCAL', 'DEVELOPMENT', 'STAGING', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('QUEUED', 'IN_PROGRESS', 'SUCCESSFUL', 'FAILED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED', 'MONITORING');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('README', 'SRS', 'API_DOCUMENTATION', 'USER_GUIDE', 'INSTALLATION_GUIDE', 'ARCHITECTURE_DOCUMENTATION', 'DEPLOYMENT_GUIDE', 'RESEARCH_REPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "RelationshipType" AS ENUM ('RELATED', 'DEPENDS_ON', 'INSPIRED_BY', 'FORKED_FROM', 'REPLACES', 'PART_OF');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('PROJECT_CREATED', 'PROJECT_UPDATED', 'STAGE_CHANGED', 'PROJECT_ARCHIVED', 'PROJECT_ACTIVATED', 'PROJECT_DELETED', 'TASK_CREATED', 'TASK_UPDATED', 'TASK_COMPLETED', 'TASK_DELETED', 'RESEARCH_ADDED', 'RESEARCH_UPDATED', 'RESEARCH_QUESTION_ADDED', 'RESEARCH_QUESTION_UPDATED', 'REQUIREMENT_CREATED', 'REQUIREMENT_UPDATED', 'FEATURE_CREATED', 'FEATURE_UPDATED', 'ADR_CREATED', 'ADR_UPDATED', 'MILESTONE_CREATED', 'ISSUE_CREATED', 'ISSUE_UPDATED', 'ISSUE_RESOLVED', 'NOTE_CREATED', 'NOTE_UPDATED', 'DOCUMENT_CREATED', 'DOCUMENT_UPDATED', 'PROMPT_RECORDED', 'PROMPT_VERSIONED', 'AI_SESSION_RECORDED', 'DEVELOPMENT_SESSION_RECORDED', 'DEPLOYMENT_CREATED', 'DEPLOYMENT_UPDATED', 'PRODUCTION_INCIDENT_CREATED', 'PRODUCTION_INCIDENT_RESOLVED', 'GIT_REFERENCE_ADDED', 'RELATIONSHIP_CREATED', 'EXPORT_CREATED');

-- CreateEnum
CREATE TYPE "TechCategory" AS ENUM ('FRONTEND', 'BACKEND', 'DATABASE', 'HOSTING', 'OTHER');

-- CreateEnum
CREATE TYPE "GitRefKind" AS ENUM ('REPOSITORY', 'COMMIT', 'BRANCH', 'PULL_REQUEST', 'RELEASE');

-- CreateTable
CREATE TABLE "projects" (
    "id" SERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "problem" TEXT,
    "motivation" TEXT,
    "targetUsers" TEXT,
    "expectedValue" TEXT,
    "assumptions" TEXT,
    "initialQuestions" TEXT,
    "inspiration" TEXT,
    "originalIdea" TEXT,
    "stage" "LifecycleStage" NOT NULL DEFAULT 'IDEA',
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "repositoryUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT DEFAULT '#3b82f6',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tag_assignments" (
    "id" SERIAL NOT NULL,
    "tagId" INTEGER NOT NULL,
    "taggableType" TEXT NOT NULL,
    "taggableId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tag_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_entries" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "question" TEXT,
    "type" "ResearchType" NOT NULL DEFAULT 'OTHER',
    "source" TEXT,
    "url" TEXT,
    "summary" TEXT,
    "findings" TEXT,
    "relevance" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "research_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_questions" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT,
    "status" "ResearchQuestionStatus" NOT NULL DEFAULT 'OPEN',
    "category" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "research_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requirements" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "RequirementType" NOT NULL DEFAULT 'FUNCTIONAL',
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "status" "RequirementStatus" NOT NULL DEFAULT 'PROPOSED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "features" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "status" "FeatureStatus" NOT NULL DEFAULT 'PLANNED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_requirements" (
    "id" SERIAL NOT NULL,
    "featureId" INTEGER NOT NULL,
    "requirementId" INTEGER NOT NULL,

    CONSTRAINT "feature_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "architecture_decisions" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "decision" TEXT,
    "context" TEXT,
    "alternatives" TEXT,
    "reasoning" TEXT,
    "consequences" TEXT,
    "status" "ADRStatus" NOT NULL DEFAULT 'PROPOSED',
    "supersededById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "architecture_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tech_stack" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "category" "TechCategory" NOT NULL,
    "technology" TEXT NOT NULL,
    "version" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tech_stack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "database_tables" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT,
    "columns" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "database_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_endpoints" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "description" TEXT,
    "requestBody" TEXT,
    "response" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "milestones" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "targetDate" TIMESTAMP(3),
    "status" "MilestoneStatus" NOT NULL DEFAULT 'PLANNED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'TODO',
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "dueDate" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "milestoneId" INTEGER,
    "featureId" INTEGER,
    "requirementId" INTEGER,
    "devSessionId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issues" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "severity" "IssueSeverity" NOT NULL DEFAULT 'MEDIUM',
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "status" "IssueStatus" NOT NULL DEFAULT 'OPEN',
    "stepsToReproduce" TEXT,
    "expectedBehavior" TEXT,
    "actualBehavior" TEXT,
    "environment" TEXT,
    "possibleCause" TEXT,
    "solution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "development_sessions" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMinutes" INTEGER,
    "goal" TEXT,
    "workedOn" TEXT,
    "completed" TEXT,
    "problems" TEXT,
    "learned" TEXT,
    "nextStep" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "development_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_sessions" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "tool" TEXT NOT NULL,
    "model" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMinutes" INTEGER,
    "purpose" TEXT,
    "promptText" TEXT,
    "responseText" TEXT,
    "usedFromAI" TEXT,
    "rejectedFromAI" TEXT,
    "changesMade" TEXT,
    "result" "PromptResult" NOT NULL DEFAULT 'SUCCESSFUL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompts" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT,
    "purpose" TEXT,
    "category" TEXT,
    "stage" "LifecycleStage",
    "tool" TEXT,
    "model" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "taskId" INTEGER,
    "featureId" INTEGER,
    "issueId" INTEGER,
    "result" "PromptResult" NOT NULL DEFAULT 'PARTIALLY_SUCCESSFUL',
    "resultNote" TEXT,
    "finalVersionId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_versions" (
    "id" SERIAL NOT NULL,
    "promptId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "response" TEXT,
    "changes" TEXT,
    "reason" TEXT,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_documents" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "type" "DocumentType" NOT NULL DEFAULT 'OTHER',
    "title" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'markdown',
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" SERIAL NOT NULL,
    "documentId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notes" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "title" TEXT,
    "content" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployments" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "environment" "DeploymentEnvironment" NOT NULL DEFAULT 'DEVELOPMENT',
    "version" TEXT,
    "platform" TEXT,
    "url" TEXT,
    "commitHash" TEXT,
    "commitMessage" TEXT,
    "branch" TEXT,
    "pullRequest" TEXT,
    "tag" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'QUEUED',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_incidents" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "severity" "IssueSeverity" NOT NULL DEFAULT 'HIGH',
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "git_references" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "kind" "GitRefKind" NOT NULL DEFAULT 'COMMIT',
    "repositoryUrl" TEXT,
    "branch" TEXT,
    "commitHash" TEXT,
    "commitMessage" TEXT,
    "pullRequest" TEXT,
    "release" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "git_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_events" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "type" "ActivityType" NOT NULL,
    "description" TEXT NOT NULL,
    "metadata" TEXT,
    "relatedType" TEXT,
    "relatedId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_relationships" (
    "id" SERIAL NOT NULL,
    "fromProjectId" INTEGER NOT NULL,
    "toProjectId" INTEGER NOT NULL,
    "type" "RelationshipType" NOT NULL DEFAULT 'RELATED',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" INTEGER,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "storagePath" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "projects_slug_key" ON "projects"("slug");

-- CreateIndex
CREATE INDEX "projects_stage_idx" ON "projects"("stage");

-- CreateIndex
CREATE INDEX "projects_isArchived_idx" ON "projects"("isArchived");

-- CreateIndex
CREATE INDEX "projects_updatedAt_idx" ON "projects"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "tags_name_key" ON "tags"("name");

-- CreateIndex
CREATE INDEX "tag_assignments_taggableType_taggableId_idx" ON "tag_assignments"("taggableType", "taggableId");

-- CreateIndex
CREATE UNIQUE INDEX "tag_assignments_tagId_taggableType_taggableId_key" ON "tag_assignments"("tagId", "taggableType", "taggableId");

-- CreateIndex
CREATE INDEX "research_entries_projectId_idx" ON "research_entries"("projectId");

-- CreateIndex
CREATE INDEX "research_entries_type_idx" ON "research_entries"("type");

-- CreateIndex
CREATE INDEX "research_questions_projectId_idx" ON "research_questions"("projectId");

-- CreateIndex
CREATE INDEX "research_questions_status_idx" ON "research_questions"("status");

-- CreateIndex
CREATE INDEX "requirements_projectId_idx" ON "requirements"("projectId");

-- CreateIndex
CREATE INDEX "requirements_status_idx" ON "requirements"("status");

-- CreateIndex
CREATE UNIQUE INDEX "requirements_projectId_code_key" ON "requirements"("projectId", "code");

-- CreateIndex
CREATE INDEX "features_projectId_idx" ON "features"("projectId");

-- CreateIndex
CREATE INDEX "features_status_idx" ON "features"("status");

-- CreateIndex
CREATE UNIQUE INDEX "feature_requirements_featureId_requirementId_key" ON "feature_requirements"("featureId", "requirementId");

-- CreateIndex
CREATE INDEX "architecture_decisions_projectId_idx" ON "architecture_decisions"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "architecture_decisions_projectId_code_key" ON "architecture_decisions"("projectId", "code");

-- CreateIndex
CREATE INDEX "tech_stack_projectId_idx" ON "tech_stack"("projectId");

-- CreateIndex
CREATE INDEX "database_tables_projectId_idx" ON "database_tables"("projectId");

-- CreateIndex
CREATE INDEX "api_endpoints_projectId_idx" ON "api_endpoints"("projectId");

-- CreateIndex
CREATE INDEX "milestones_projectId_idx" ON "milestones"("projectId");

-- CreateIndex
CREATE INDEX "tasks_projectId_idx" ON "tasks"("projectId");

-- CreateIndex
CREATE INDEX "tasks_status_idx" ON "tasks"("status");

-- CreateIndex
CREATE INDEX "tasks_featureId_idx" ON "tasks"("featureId");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_projectId_code_key" ON "tasks"("projectId", "code");

-- CreateIndex
CREATE INDEX "issues_projectId_idx" ON "issues"("projectId");

-- CreateIndex
CREATE INDEX "issues_status_idx" ON "issues"("status");

-- CreateIndex
CREATE UNIQUE INDEX "issues_projectId_code_key" ON "issues"("projectId", "code");

-- CreateIndex
CREATE INDEX "development_sessions_projectId_idx" ON "development_sessions"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "development_sessions_projectId_number_key" ON "development_sessions"("projectId", "number");

-- CreateIndex
CREATE INDEX "ai_sessions_projectId_idx" ON "ai_sessions"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_sessions_projectId_number_key" ON "ai_sessions"("projectId", "number");

-- CreateIndex
CREATE INDEX "prompts_projectId_idx" ON "prompts"("projectId");

-- CreateIndex
CREATE INDEX "prompts_category_idx" ON "prompts"("category");

-- CreateIndex
CREATE INDEX "prompts_result_idx" ON "prompts"("result");

-- CreateIndex
CREATE INDEX "prompts_date_idx" ON "prompts"("date");

-- CreateIndex
CREATE UNIQUE INDEX "prompts_projectId_code_key" ON "prompts"("projectId", "code");

-- CreateIndex
CREATE INDEX "prompt_versions_promptId_idx" ON "prompt_versions"("promptId");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_versions_promptId_version_key" ON "prompt_versions"("promptId", "version");

-- CreateIndex
CREATE INDEX "project_documents_projectId_idx" ON "project_documents"("projectId");

-- CreateIndex
CREATE INDEX "document_versions_documentId_idx" ON "document_versions"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_documentId_version_key" ON "document_versions"("documentId", "version");

-- CreateIndex
CREATE INDEX "notes_projectId_idx" ON "notes"("projectId");

-- CreateIndex
CREATE INDEX "deployments_projectId_idx" ON "deployments"("projectId");

-- CreateIndex
CREATE INDEX "deployments_environment_status_idx" ON "deployments"("environment", "status");

-- CreateIndex
CREATE INDEX "production_incidents_projectId_idx" ON "production_incidents"("projectId");

-- CreateIndex
CREATE INDEX "production_incidents_status_idx" ON "production_incidents"("status");

-- CreateIndex
CREATE INDEX "git_references_projectId_idx" ON "git_references"("projectId");

-- CreateIndex
CREATE INDEX "activity_events_projectId_createdAt_idx" ON "activity_events"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "activity_events_type_idx" ON "activity_events"("type");

-- CreateIndex
CREATE INDEX "project_relationships_fromProjectId_idx" ON "project_relationships"("fromProjectId");

-- CreateIndex
CREATE INDEX "project_relationships_toProjectId_idx" ON "project_relationships"("toProjectId");

-- CreateIndex
CREATE UNIQUE INDEX "project_relationships_fromProjectId_toProjectId_type_key" ON "project_relationships"("fromProjectId", "toProjectId", "type");

-- CreateIndex
CREATE INDEX "attachments_projectId_idx" ON "attachments"("projectId");

-- CreateIndex
CREATE INDEX "attachments_recordType_recordId_idx" ON "attachments"("recordType", "recordId");

-- AddForeignKey
ALTER TABLE "tag_assignments" ADD CONSTRAINT "tag_assignments_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_entries" ADD CONSTRAINT "research_entries_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_questions" ADD CONSTRAINT "research_questions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "features" ADD CONSTRAINT "features_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_requirements" ADD CONSTRAINT "feature_requirements_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "features"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_requirements" ADD CONSTRAINT "feature_requirements_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "architecture_decisions" ADD CONSTRAINT "architecture_decisions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "architecture_decisions" ADD CONSTRAINT "architecture_decisions_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "architecture_decisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tech_stack" ADD CONSTRAINT "tech_stack_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_tables" ADD CONSTRAINT "database_tables_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_endpoints" ADD CONSTRAINT "api_endpoints_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "milestones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "features"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_devSessionId_fkey" FOREIGN KEY ("devSessionId") REFERENCES "development_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issues" ADD CONSTRAINT "issues_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "development_sessions" ADD CONSTRAINT "development_sessions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "features"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "issues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "prompts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_documents" ADD CONSTRAINT "project_documents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "project_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_incidents" ADD CONSTRAINT "production_incidents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "git_references" ADD CONSTRAINT "git_references_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_relationships" ADD CONSTRAINT "project_relationships_fromProjectId_fkey" FOREIGN KEY ("fromProjectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_relationships" ADD CONSTRAINT "project_relationships_toProjectId_fkey" FOREIGN KEY ("toProjectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
