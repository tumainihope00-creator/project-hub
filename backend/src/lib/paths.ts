import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Projects Root path handling.
 *
 * The Projects Root is the folder that will contain every project folder Project
 * Hub manages. It is a *host* location, not project data, so this module is
 * deliberately small and deliberately read-mostly:
 *
 *   - normalize() decides whether a string is a usable absolute path. It is pure
 *     and touches no disk, so it can be used to reject bad input before any
 *     filesystem access happens at all.
 *   - probe() reports what is actually true of a directory. It never creates,
 *     moves or removes anything.
 *   - createRoot() is the ONLY function here that writes to the filesystem, and
 *     it only ever creates a directory the user explicitly asked for.
 *
 * Deliberate non-behaviour, so it is not mistaken for an oversight:
 *
 *   - Symlinks and Windows junctions are NOT resolved. `normalize()` is purely
 *     lexical, so the path the user typed is the path that gets stored. A later
 *     phase that needs to defend against escaping the root must do its own
 *     `fs.realpath` containment check at the moment of use; silently rewriting
 *     the user's chosen path here would be worse than storing it verbatim.
 *   - Nothing is ever deleted, moved, renamed or overwritten here. The single
 *     exception is the write-probe file that `probe()` creates itself and then
 *     removes, which is explained at that function.
 *
 * Windows is the development platform, so the checks are written for it, but
 * every path operation goes through `node:path` rather than string
 * concatenation, so `D:\My Projects` and `D:\Projects` both work and no
 * separator is ever hardcoded.
 */

export const PROJECTS_ROOT_MAX_LENGTH = 4096;

/** Machine-readable reason a path was rejected. Safe to show in the UI. */
export type PathProblemCode =
  | 'PATH_EMPTY'
  | 'PATH_TOO_LONG'
  | 'PATH_RELATIVE'
  | 'PATH_INVALID'
  | 'PATH_RESERVED_NAME'
  | 'PATH_TRAILING_DOT_OR_SPACE'
  | 'PATH_NOT_FOUND'
  | 'PATH_NOT_DIRECTORY'
  | 'PATH_NOT_READABLE'
  | 'PATH_NOT_WRITABLE'
  | 'PATH_PERMISSION_DENIED';

export interface PathProblem {
  code: PathProblemCode;
  message: string;
  possibleAction?: string;
}

export interface NormalizedPath {
  ok: true;
  path: string;
}

export interface RejectedPath {
  ok: false;
  problem: PathProblem;
}

export type NormalizeResult = NormalizedPath | RejectedPath;

/** What is actually true of a directory on disk right now. */
export interface RootProbe {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  /** True when the final component is a symlink/junction. Reported, not resolved. */
  isSymbolicLink: boolean;
  readable: boolean;
  /**
   * `null` when writability was not tested. Validation must never create files
   * as a side effect, so only the explicit connection test probes for writes.
   */
  writable: boolean | null;
  /** True only when the directory exists, is a directory, and is readable. */
  usable: boolean;
  problems: PathProblem[];
  checkedAt: string;
}

// Windows device names. `CON`, `NUL.txt` and `COM1` are all rejected by NTFS,
// which silently strips trailing dots/spaces rather than erroring.
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)
]);

/** Users paste paths with quotes from Explorer and terminals. */
function stripWrappingQuotes(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1).trim();
  }
  return v;
}

function rejected(code: PathProblemCode, message: string, possibleAction?: string): RejectedPath {
  return { ok: false, problem: { code, message, possibleAction } };
}

/**
 * Turn user input into one canonical absolute path string, or explain why it
 * cannot be one. Purely lexical: no disk access, so a hostile or broken path
 * can never cause a filesystem call here.
 */
export function normalizeProjectsRoot(input: unknown): NormalizeResult {
  if (typeof input !== 'string') {
    return rejected('PATH_EMPTY', 'Projects Root is required.', 'Enter the absolute path of the folder that will contain your project folders, for example D:\\Projects.');
  }

  const raw = stripWrappingQuotes(input);
  if (!raw) {
    return rejected('PATH_EMPTY', 'Projects Root is not set.', 'Enter the absolute path of the folder that will contain your project folders, for example D:\\Projects.');
  }
  if (raw.length > PROJECTS_ROOT_MAX_LENGTH) {
    return rejected('PATH_TOO_LONG', `That path is ${raw.length} characters long, which is over the ${PROJECTS_ROOT_MAX_LENGTH} character limit.`, 'Choose a shorter path closer to the drive root, for example D:\\Projects.');
  }
  if (/[\u0000-\u001f]/.test(raw)) {
    return rejected('PATH_INVALID', 'That path contains control characters, which are not allowed in a folder path.', 'Remove the control characters and try again.');
  }

  // Windows-specific rejections, done before resolve() so a drive-relative or
  // drive-less path is never silently turned into an absolute one.
  if (process.platform === 'win32') {
    if (/^[a-z]:(?![\\/])/i.test(raw)) {
      return rejected('PATH_RELATIVE', `"${raw}" is a drive-relative path, not an absolute one.`, `Include the backslash after the drive letter, for example ${raw[0]}:\\${raw.slice(2) || 'Projects'}.`);
    }
    if (/^[\\/]/.test(raw) && !/^[\\/]{2}/.test(raw)) {
      return rejected('PATH_INVALID', `"${raw}" is missing a drive letter.`, 'Use a full absolute path such as D:\\Projects.');
    }
  }

  if (!path.isAbsolute(raw)) {
    // A generic example, not the user's input spliced onto a drive letter: that
    // reads as though we were suggesting they keep the part we just rejected.
    return rejected('PATH_RELATIVE', `"${raw}" is a relative path. Projects Root must be an absolute path.`, 'Start the path from the drive root, for example D:\\Projects.');
  }

  if (process.platform === 'win32') {
    // Windows forbids these in every path component. Catching them here matters:
    // a path like `D:\Pro?jects` can never exist, so letting it through would
    // make the probe report it as a missing folder, sending the user off to
    // create a folder that cannot be created. Validated per component, after
    // the absolute check, so the drive letter's own colon is not mistaken for
    // an illegal one and `..\Projects` is still reported as relative.
    const components = raw.split(/[\\/]+/).filter(Boolean);
    const isDrive = (c: string) => /^[a-z]:$/i.test(c);
    const badComponent = components.find(c => !isDrive(c) && /[<>:"|?*]/.test(c));
    if (badComponent) {
      const badChar = badComponent.match(/[<>:"|?*]/)?.[0] ?? '';
      return rejected('PATH_INVALID', `"${raw}" contains "${badChar}", which Windows does not allow in a folder name.`, 'Remove that character from the folder name and try again.');
    }
    // Windows silently strips a trailing dot or space from every component, so
    // `D:\a \b` and `D:\a\b` are the same folder. Reject rather than surprise.
    const trimmed = components.find(c => !isDrive(c) && /[. ]$/.test(c));
    if (trimmed) {
      return rejected('PATH_TRAILING_DOT_OR_SPACE', `The folder "${trimmed}" ends with a dot or space, which Windows removes silently.`, 'Remove the trailing dot or space and try again.');
    }
  }

  let resolved: string;
  try {
    // Collapses `.`, `..`, and duplicate separators using the platform rules.
    resolved = path.resolve(raw);
  } catch {
    return rejected('PATH_INVALID', `"${raw}" is not a path this operating system understands.`, 'Enter a full absolute path such as D:\\Projects.');
  }

  const root = path.parse(resolved).root;
  if (!root) {
    return rejected('PATH_INVALID', `"${raw}" does not resolve to a complete filesystem path.`, 'Enter a full absolute path such as D:\\Projects.');
  }

  // `D:\Projects\` and `D:\Projects` are the same folder; store one form.
  // `D:\` is the drive root, which keeps its trailing separator.
  if (resolved.length > root.length && (resolved.endsWith(path.sep) || resolved.endsWith('/'))) {
    resolved = resolved.replace(/[\\/]+$/, '');
  }
  if (resolved.length < root.length) resolved = root;

  const base = path.basename(resolved);
  const baseNoExt = base.split('.')[0].toLowerCase();
  if (process.platform === 'win32' && WINDOWS_RESERVED.has(baseNoExt)) {
    return rejected('PATH_RESERVED_NAME', `"${base}" is a reserved device name on Windows and cannot be used as a folder name.`, 'Choose a different folder name, for example Projects.');
  }
  if (process.platform === 'win32' && /[. ]$/.test(base)) {
    return rejected('PATH_TRAILING_DOT_OR_SPACE', `"${base}" ends with a dot or space, which Windows removes silently.`, 'Remove the trailing dot or space and try again.');
  }

  return { ok: true, path: resolved };
}

function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

function isMissingError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Report what is true of a directory without changing anything.
 *
 * Writability is only checked when `options.testWrite` is true, because the only
 * honest way to test it is to actually write. That test creates exactly one
 * uniquely named file with the exclusive `wx` flag - it can never overwrite an
 * existing file - and removes only that file, in a `finally` block, and only if
 * this function is the one that created it. Nothing else on disk is read,
 * listed recursively, written or removed.
 */
export async function probeProjectsRoot(target: string, options: { testWrite?: boolean } = {}): Promise<RootProbe> {
  const testWrite = options.testWrite === true;
  const problems: PathProblem[] = [];
  let exists = false;
  let isDirectory = false;
  let isSymbolicLink = false;
  let readable = false;
  let writable: boolean | null = null;

  let stats: Awaited<ReturnType<typeof fsp.lstat>> | null = null;
  try {
    stats = await fsp.lstat(target);
    exists = true;
  } catch (err) {
    if (isMissingError(err)) {
      problems.push({
        code: 'PATH_NOT_FOUND',
        message: 'That folder does not exist yet.',
        possibleAction: 'Save the path, then use "Create folder" to create it.'
      });
    } else if (isPermissionError(err)) {
      problems.push({
        code: 'PATH_PERMISSION_DENIED',
        message: 'Project Hub is not allowed to look at that location.',
        possibleAction: 'Check the folder permissions, or choose a folder your user account can access.'
      });
    } else {
      problems.push({
        code: 'PATH_INVALID',
        message: 'That location could not be inspected.',
        possibleAction: 'Check the path is correct and try again.'
      });
    }
  }

  if (stats) {
    isSymbolicLink = stats.isSymbolicLink();
    isDirectory = stats.isDirectory();

    if (exists && !isDirectory) {
      problems.push({
        code: 'PATH_NOT_DIRECTORY',
        message: 'That path is a file, not a folder.',
        possibleAction: 'Choose the folder that should contain your project folders.'
      });
    }

    // Actually open the directory. A permission bit is not proof on Windows, so
    // the only trustworthy read test is a real one.
    if (isDirectory) {
      let handle: Awaited<ReturnType<typeof fsp.opendir>> | null = null;
      try {
        handle = await fsp.opendir(target);
        readable = true;
      } catch (err) {
        readable = false;
        problems.push({
          code: isPermissionError(err) ? 'PATH_PERMISSION_DENIED' : 'PATH_NOT_READABLE',
          message: isPermissionError(err)
            ? 'Project Hub is not allowed to read that folder.'
            : 'Project Hub could not read that folder.',
          possibleAction: 'Check the folder permissions, or choose a folder your user account can read.'
        });
      } finally {
        await handle?.close().catch(() => undefined);
      }

      if (testWrite && readable) {
        const probeName = `.phub-write-probe-${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
        let created = false;
        try {
          // 'wx' fails if the name already exists, so this can never clobber.
          await fsp.writeFile(path.join(target, probeName), 'Project Hub write test.\n', { flag: 'wx' });
          created = true;
          writable = true;
        } catch (err) {
          writable = false;
          problems.push({
            code: isPermissionError(err) ? 'PATH_PERMISSION_DENIED' : 'PATH_NOT_WRITABLE',
            message: isPermissionError(err)
              ? 'Project Hub is not allowed to write to that folder.'
              : 'That folder is not writable by Project Hub.',
            possibleAction: 'Grant write access to your user account, or choose a folder you can write to.'
          });
        } finally {
          if (created) await fsp.unlink(path.join(target, probeName)).catch(() => undefined);
        }
      }
    }
  }

  return {
    path: target,
    exists,
    isDirectory,
    isSymbolicLink,
    readable,
    writable,
    usable: exists && isDirectory && readable,
    problems,
    checkedAt: new Date().toISOString()
  };
}

/**
 * Create the Projects Root folder. This is the only write in this module and it
 * only runs because a user explicitly asked for it. It never deletes, moves,
 * truncates or overwrites anything, and `recursive: true` only creates
 * directories that do not exist yet.
 */
export async function createProjectsRoot(target: string): Promise<{ created: boolean; probe: RootProbe }> {
  // Check first so `created` reports what this call actually did, rather than
  // what mkdir happened to do.
  let existed = true;
  try {
    await fsp.lstat(target);
  } catch (err) {
    if (isMissingError(err)) existed = false;
    else if (isPermissionError(err)) {
      throw Object.assign(new Error('Project Hub is not allowed to look at that location.'), {
        problem: {
          code: 'PATH_PERMISSION_DENIED' as PathProblemCode,
          message: 'Project Hub is not allowed to look at that location.',
          possibleAction: 'Check the folder permissions, or choose a folder your user account can access.'
        }
      });
    } else throw err;
  }

  if (!existed) {
    try {
      await fsp.mkdir(target, { recursive: true });
    } catch (err) {
      if (isMissingError(err)) {
        throw Object.assign(new Error('Part of that path already exists as a file, so the folder cannot be created.'), {
          problem: {
            code: 'PATH_NOT_DIRECTORY' as PathProblemCode,
            message: 'Part of that path already exists as a file, so the folder cannot be created.',
            possibleAction: 'Choose a different parent folder, or remove the file that is in the way.'
          }
        });
      }
      if (isPermissionError(err)) {
        throw Object.assign(new Error('Project Hub is not allowed to create that folder.'), {
          problem: {
            code: 'PATH_PERMISSION_DENIED' as PathProblemCode,
            message: 'Project Hub is not allowed to create that folder.',
            possibleAction: 'Choose a location your user account can write to, for example a folder inside your user profile.'
          }
        });
      }
      throw err;
    }
  }

  const probe = await probeProjectsRoot(target, { testWrite: false });
  return { created: !existed, probe };
}
