-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "v1Scope" TEXT;

-- CreateTable
CREATE TABLE "prompt_generations" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "promptId" INTEGER NOT NULL,
    "promptType" TEXT NOT NULL DEFAULT 'V1_BUILD_PROMPT',
    "version" INTEGER NOT NULL,
    "versionId" INTEGER,
    "config" TEXT,
    "readiness" DOUBLE PRECISION,
    "items" TEXT,
    "analysis" TEXT,
    "sourceSnapshot" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_generations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prompt_generations_projectId_promptType_version_idx" ON "prompt_generations"("projectId", "promptType", "version");

-- CreateIndex
CREATE INDEX "prompt_generations_promptId_idx" ON "prompt_generations"("promptId");

-- AddForeignKey
ALTER TABLE "prompt_generations" ADD CONSTRAINT "prompt_generations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_generations" ADD CONSTRAINT "prompt_generations_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "prompts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
