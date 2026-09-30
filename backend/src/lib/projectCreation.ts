import { ApiError } from './errors.js';
import { prisma } from './prisma.js';
import { readProjectsRootSetting } from './settings.js';
import { probeProjectsRoot } from './paths.js';
import {
  collisionError,
  createWorkspaceFolder,
  inspectTarget,
  ProjectNameError,
  removeEmptyCreatedFolder,
  resolveWorkspace
} from './projectWorkspace.js';

/**
 * Phase 3 creation flow: database record and physical folder, kept consistent.
 *
 * The order is deliberate and is the whole point of this file:
 *
 *   validate name -> load Projects Root -> resolve safe folder name ->
 *   containment check -> collision check -> create folder -> create DB record
 *
 * The folder is created first so that a folder failure never leaves a database
 * project pointing at nothing. If the database then fails, the folder is removed
 * again - but only if THIS call created it and only if it is still empty. If
 * that cleanup fails, the partial state is reported explicitly rather than
 * hidden, because a folder the user can see on disk but no project in the
 * database is a real, confusing state they deserve to know about.
 */

export interface CreateProjectInput {
  name: string;
  [key: string]: unknown;
}

export interface CreatedProject {
  project: Record<string, unknown>;
  workspace: {
    folderName: string;
    folderPath: string;
    renamed: boolean;
  };
  /** Set only when something went wrong but the folder survived. */
  partialState?: {
    folderPath: string;
    reason: string;
  };
}

/**
 * The Projects Root must be configured AND usable, otherwise we stop.
 *
 * We never fall back to another directory. Writing project folders somewhere the
 * user did not choose is far worse than refusing to create the project.
 */
async function requireUsableProjectsRoot(): Promise<string> {
  const stored = await readProjectsRootSetting();
  if (!stored) {
    throw new ApiError(409, 'No Projects Root is configured, so no project folder can be created.', {
      code: 'PROJECTS_ROOT_NOT_CONFIGURED'
    }, {
      category: 'VALIDATION_FAILED',
      operation: 'create the project workspace',
      possibleAction: 'Open Settings and set a Projects Root first, then create the project.'
    });
  }

  const probe = await probeProjectsRoot(stored.value, { testWrite: false });
  if (!probe.exists || !probe.isDirectory) {
    throw new ApiError(409, `The configured Projects Root at ${stored.value} is not an available folder.`, {
      code: 'PROJECTS_ROOT_UNUSABLE',
      path: stored.value
    }, {
      category: 'VALIDATION_FAILED',
      operation: 'create the project workspace',
      possibleAction: 'Open Settings, test the Projects Root connection, and create the folder if it is missing.'
    });
  }
  if (!probe.readable) {
    throw new ApiError(409, `Project Hub cannot read the configured Projects Root at ${stored.value}.`, {
      code: 'PROJECTS_ROOT_UNUSABLE',
      path: stored.value
    }, {
      category: 'VALIDATION_FAILED',
      operation: 'create the project workspace',
      possibleAction: 'Grant read access to that folder, or choose a different Projects Root in Settings.'
    });
  }
  return stored.value;
}

export async function prepareProjectWorkspace(projectName: string): Promise<{
  root: string;
  folderName: string;
  folderPath: string;
  renamed: boolean;
}> {
  const root = await requireUsableProjectsRoot();

  let resolved;
  try {
    resolved = resolveWorkspace(root, projectName);
  } catch (err) {
    if (err instanceof ProjectNameError) {
      throw new ApiError(400, err.message, { code: err.code, input: projectName }, {
        category: 'VALIDATION_FAILED',
        operation: 'create the project workspace',
        possibleAction: err.possibleAction
      });
    }
    throw err;
  }

  const collision = await inspectTarget(resolved.folderPath);
  if (collision) throw collisionError(collision);

  return { root, ...resolved };
}

/**
 * Create the workspace folder, then the database record.
 *
 * `createRecord` is injected so the ordering and the rollback can be tested
 * without needing a real database failure.
 */
export async function createProjectWithWorkspace<T extends Record<string, unknown>>(
  input: CreateProjectInput,
  createRecord: (data: {
    name: string;
    folderName: string;
    folderPath: string;
  }) => Promise<T>
): Promise<{ project: T; folderName: string; folderPath: string; renamed: boolean; partialState?: { folderPath: string; reason: string } }> {
  const root = await requireUsableProjectsRoot();

  let resolved;
  try {
    resolved = resolveWorkspace(root, input.name);
  } catch (err) {
    if (err instanceof ProjectNameError) {
      throw new ApiError(400, err.message, { code: err.code, input: input.name }, {
        category: 'VALIDATION_FAILED',
        operation: 'create the project workspace',
        possibleAction: err.possibleAction
      });
    }
    throw err;
  }

  const collision = await inspectTarget(resolved.folderPath);
  if (collision) throw collisionError(collision);

  // From here on, `createdByUs` is the single source of truth about whether we
  // are allowed to remove this folder. It is a local variable, so it can never
  // be true for a folder that existed before this request.
  const { createdByUs } = await createWorkspaceFolder(resolved.folderPath);
  if (!createdByUs) {
    // Lost a race with something else creating the folder between our check and
    // our mkdir. Treat it exactly like any other collision.
    const late = await inspectTarget(resolved.folderPath);
    throw collisionError(
      late ?? {
        kind: 'exists',
        path: resolved.folderPath,
        message: `A folder already exists at ${resolved.folderPath}. Project Hub will not overwrite it.`,
        possibleAction: 'Choose a different project name.'
      }
    );
  }

  try {
    const project = await createRecord({
      name: input.name,
      folderName: resolved.folderName,
      folderPath: resolved.folderPath
    });
    return {
      project,
      folderName: resolved.folderName,
      folderPath: resolved.folderPath,
      renamed: resolved.renamed
    };
  } catch (dbError) {
    // The database record did not happen. The folder this call created is
    // orphaned, so remove it - but only ours, and only while it is empty.
    const cleanup = await removeEmptyCreatedFolder(resolved.folderPath);

    if (!cleanup.removed) {
      const message = `The project could not be saved, and the empty folder at ${resolved.folderPath} could not be cleaned up (${cleanup.reason}). The folder is still on disk but no project record was created.`;
      throw new ApiError(500, message, {
        code: 'PARTIAL_STATE_FOLDER_LEFT',
        folderPath: resolved.folderPath,
        cleanupReason: cleanup.reason,
        dbError: dbError instanceof Error ? dbError.message : String(dbError)
      }, {
        category: 'FILESYSTEM_ERROR',
        operation: 'create the project workspace',
        possibleAction: `Delete ${resolved.folderPath} yourself once you have checked what is in it.`
      });
    }

    // Folder removed cleanly. Report the original database failure unchanged so
    // the user sees the real cause, not a filesystem side effect.
    throw dbError;
  }
}

export { prisma };
