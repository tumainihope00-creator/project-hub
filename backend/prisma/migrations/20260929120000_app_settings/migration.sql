-- Application-wide settings (Phase 2: configurable Projects Root).
--
-- Additive only: this creates one new table and touches no existing table,
-- column, index, constraint or row. Existing project data is unaffected.
--
-- A key/value table is the smallest mechanism that lets the user configure
-- Project Hub from the UI and have the value survive a restart, while matching
-- the existing architecture (Prisma + PostgreSQL, snake_case @@map tables).

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);
