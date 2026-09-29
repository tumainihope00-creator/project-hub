import { prisma } from './prisma.js';
import { ApiError } from './errors.js';
import {
  PROJECTS_ROOT_MAX_LENGTH,
  createProjectsRoot,
  normalizeProjectsRoot,
  probeProjectsRoot,
  type PathProblem,
  type RootProbe
} from './paths.js';

/**
 * Application settings, currently one value: the Projects Root.
 *
 * Project Hub stores the Projects Root in the `app_settings` key/value table
 * rather than in `backend/.env`, for two reasons:
 *
 *   1. The user has to be able to change it from the Settings page. A `.env`
 *      file is not editable from a browser and is easy to overwrite by mistake.
 *   2. It has to survive a restart of P-Hub, which a value held in memory or
 *      derived from the working directory would not.
 *
 * The key is a fixed constant. There is deliberately no generic "get/set any
 * key" endpoint, so this table cannot be used to smuggle arbitrary
 * configuration into the application.
 *
 * It is NOT stored in `.env` and does NOT fall back to the P-Hub source
 * directory, the working directory, or the user's home directory. Until the user
 * configures a value, the application simply has no Projects Root.
 */

/** The one setting key this phase introduces. */
export const PROJECTS_ROOT_KEY = 'projects_root';

export interface StoredSetting {
  key: string;
  value: string;
  updatedAt: Date;
}

export interface ProjectsRootResponse {
  /** True only when the path is saved in the database. Testing a path that has
   *  not been saved yet reports false, so the UI never claims a value is
   *  configured just because the user tried it out. */
  configured: boolean;
  key: string;
  /** Normalized absolute path being reported on, or null when not configured. */
  path: string | null;
  updatedAt: string | null;
  exists: boolean | null;
  isDirectory: boolean | null;
  /** True when the final path component is a symlink or Windows junction. */
  isSymbolicLink: boolean | null;
  readable: boolean | null;
  /** null when writability was not tested. See `writableTested`. */
  writable: boolean | null;
  /** True when the writable probe actually ran. */
  writableTested: boolean;
  /** True only when the folder exists, is a directory, and is readable. */
  usable: boolean;
  problems: PathProblem[];
  checkedAt: string;
}

export async function readProjectsRootSetting(): Promise<StoredSetting | null> {
  return prisma.appSetting.findUnique({ where: { key: PROJECTS_ROOT_KEY } });
}

/** Turn a rejected path into the same structured error shape as every other API error. */
function pathError(problem: PathProblem, input: unknown): ApiError {
  return new ApiError(400, problem.message, { code: problem.code, input: typeof input === 'string' ? input : null }, {
    category: 'VALIDATION_FAILED',
    operation: 'validate the Projects Root path',
    possibleAction: problem.possibleAction ?? 'Correct the path and try again.'
  });
}

/** Validate raw input and return one canonical absolute path string. */
export function requireNormalizedProjectsRoot(input: unknown): string {
  const result = normalizeProjectsRoot(input);
  if (!result.ok) throw pathError(result.problem, input);
  return result.path;
}

function toResponse(stored: StoredSetting | null, status: RootProbe | null): ProjectsRootResponse {
  return {
    configured: stored !== null,
    key: PROJECTS_ROOT_KEY,
    path: stored ? stored.value : null,
    updatedAt: stored ? stored.updatedAt.toISOString() : null,
    exists: status ? status.exists : null,
    isDirectory: status ? status.isDirectory : null,
    isSymbolicLink: status ? status.isSymbolicLink : null,
    readable: status ? status.readable : null,
    writable: status ? status.writable : null,
    writableTested: status ? status.writable !== null : false,
    usable: status ? status.usable : false,
    problems: status ? status.problems : [],
    checkedAt: status ? status.checkedAt : new Date().toISOString()
  };
}

/**
 * The current Projects Root, with a non-destructive read check.
 *
 * Nothing is created and nothing is written, so this is safe to call on every
 * page load. Writability is reported as `null` because testing it requires
 * writing; use `testProjectsRoot()` when the user asks for a connection test.
 */
export async function getProjectsRoot(): Promise<ProjectsRootResponse> {
  const stored = await readProjectsRootSetting();
  if (!stored) return toResponse(null, null);
  const status = await probeProjectsRoot(stored.value, { testWrite: false });
  return toResponse(stored, status);
}

/**
 * Save the Projects Root.
 *
 * Validation here is non-destructive: it reads, it never creates. A path that
 * does not exist yet is still allowed, because the user may be pointing at a
 * folder they intend to create; the response says so and the UI offers to
 * create it. A path that exists but is a file, or that exists but cannot be
 * read, is refused outright, because Project Hub could never manage it.
 */
export async function saveProjectsRoot(input: unknown): Promise<ProjectsRootResponse> {
  const normalized = requireNormalizedProjectsRoot(input);
  const status = await probeProjectsRoot(normalized, { testWrite: false });

  if (status.exists && !status.isDirectory) {
    throw pathError(
      {
        code: 'PATH_NOT_DIRECTORY',
        message: 'That path is a file, not a folder, so it cannot be the Projects Root.',
        possibleAction: 'Choose the folder that should contain your project folders.'
      },
      normalized
    );
  }
  if (status.exists && !status.readable) {
    throw pathError(
      {
        code: 'PATH_NOT_READABLE',
        message: 'Project Hub cannot read that folder, so it cannot manage projects inside it.',
        possibleAction: 'Grant read access to your user account, or choose a folder you can read.'
      },
      normalized
    );
  }

  const saved = await prisma.appSetting.upsert({
    where: { key: PROJECTS_ROOT_KEY },
    create: { key: PROJECTS_ROOT_KEY, value: normalized },
    update: { value: normalized }
  });
  return toResponse(saved, status);
}

/** Full connection test, including a real write probe. Run only on request. */
export async function testProjectsRoot(input?: unknown): Promise<ProjectsRootResponse> {
  const stored = input === undefined || input === null || input === '' ? await readProjectsRootSetting() : null;
  const target = input === undefined || input === null || input === ''
    ? (stored ? stored.value : null)
    : requireNormalizedProjectsRoot(input);

  if (target === null) {
    throw new ApiError(400, 'Projects Root is not configured, so there is nothing to test.', { code: 'PATH_EMPTY' }, {
      category: 'VALIDATION_FAILED',
      operation: 'test the Projects Root folder',
      possibleAction: 'Enter a Projects Root path first, then test the connection.'
    });
  }

  const status = await probeProjectsRoot(target, { testWrite: true });
  const current = await readProjectsRootSetting();
  // Testing a draft path is useful before saving, so the echoed path is the one
  // that was actually tested. `configured` deliberately still reflects the
  // database: trying a path out is not the same as choosing it.
  return { ...toResponse(current, status), path: target };
}

/**
 * Create the Projects Root folder. Only ever called because the user explicitly
 * asked for it. Creates directories, never removes them.
 */
export async function initializeProjectsRoot(input?: unknown): Promise<ProjectsRootResponse & { created: boolean }> {
  const stored = input === undefined || input === null || input === '' ? await readProjectsRootSetting() : null;
  const target = input === undefined || input === null || input === ''
    ? (stored ? stored.value : null)
    : requireNormalizedProjectsRoot(input);

  if (target === null) {
    throw new ApiError(400, 'Projects Root is not configured, so there is no folder to create.', { code: 'PATH_EMPTY' }, {
      category: 'VALIDATION_FAILED',
      operation: 'create the Projects Root folder',
      possibleAction: 'Enter the Projects Root path you want to create, then confirm.'
    });
  }

  try {
    const { created, probe } = await createProjectsRoot(target);
    if (!probe.isDirectory) {
      throw new ApiError(400, 'That path is a file, not a folder, so it cannot be the Projects Root.', { code: 'PATH_NOT_DIRECTORY', input: target }, {
        category: 'VALIDATION_FAILED',
        operation: 'create the Projects Root folder',
        possibleAction: 'Choose the folder that should contain your project folders.'
      });
    }
    const current = await readProjectsRootSetting();
    // Creating a folder does not choose it. The path still has to be saved, and
    // `configured` says so honestly.
    return { ...toResponse(current, probe), path: target, created };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const problem = (err as { problem?: PathProblem })?.problem;
    if (problem) throw pathError(problem, target);
    throw new ApiError(500, 'The Projects Root folder could not be created.', { input: target }, {
      category: 'SYSTEM_ERROR',
      operation: 'create the Projects Root folder',
      possibleAction: 'Check the path is correct and that you can create folders there, then try again.'
    });
  }
}

/**
 * Forget the Projects Root. This only deletes the stored setting - it never
 * touches the folder on disk, which may contain real project work.
 */
export async function clearProjectsRoot(): Promise<ProjectsRootResponse> {
  await prisma.appSetting.deleteMany({ where: { key: PROJECTS_ROOT_KEY } });
  return toResponse(null, null);
}

export { PROJECTS_ROOT_MAX_LENGTH };
