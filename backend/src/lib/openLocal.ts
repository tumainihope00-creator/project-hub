import { spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './errors.js';
import { readProjectsRootSetting } from './settings.js';
import { isInsideRoot } from './projectWorkspace.js';

/**
 * Launch a project's workspace folder in the operating system's file manager
 * or in Visual Studio Code.
 *
 * Three rules, matching the ones in projectWorkspace.ts:
 *
 * 1. The path that gets launched comes ONLY from the database record and the
 *    configured Projects Root - never from the request. The frontend sends a
 *    project id; this module re-derives the folder and proves it is inside the
 *    Projects Root before anything is spawned. There is no API here that can be
 *    pointed at an arbitrary location.
 *
 * 2. Processes are spawned with an argument array and `shell: false`. No part
 *    of a folder path is ever concatenated into a command string, so a folder
 *    named `foo & del /f /q *` is just a folder name.
 *
 * 3. The child is `detached` and `unref`ed: the HTTP request returns as soon as
 *    the launch succeeds, and neither the response nor the server's lifetime is
 *    tied to Explorer or VS Code.
 *
 * Windows is the development platform (see paths.ts). On any other operating
 * system these actions return a clear "not supported" error rather than
 * guessing at an equivalent command.
 */

const LOG_PREFIX = '[open-local]';

export type LocalOpenTarget = 'explorer' | 'vscode';

export type OpenableFolder =
  | { available: true; folderPath: string }
  | { available: false; status: number; reason: string; message: string; possibleAction: string };

/**
 * Work out which folder may be opened for a project, from the database alone.
 *
 * Deliberately returns a result object instead of throwing for the ordinary
 * "this project cannot be opened" cases (no workspace, missing folder, unsafe
 * path), so the route can log the reason without turning every honest refusal
 * into an error-handling path.
 */
export async function resolveProjectFolderForOpening(project: {
  id: number;
  folderName: string | null;
  folderPath: string | null;
}): Promise<OpenableFolder> {
  if (!project.folderPath) {
    return {
      available: false,
      status: 422,
      reason: 'PROJECT_WORKSPACE_MISSING',
      message: 'This project has no folder configured, so there is nothing to open.',
      possibleAction:
        'Only projects created with a workspace folder have one. Create the project from the New Project dialog to get a workspace, or set a Projects Root in Settings first.'
    };
  }

  const stored = await readProjectsRootSetting();
  if (!stored) {
    return {
      available: false,
      status: 409,
      reason: 'PROJECTS_ROOT_NOT_CONFIGURED',
      message: 'No Projects Root is configured, so Project Hub cannot verify this project folder.',
      possibleAction: 'Open Settings and set a Projects Root, then try again.'
    };
  }

  const root = path.resolve(stored.value);
  const folderPath = path.resolve(project.folderPath);

  if (!isInsideRoot(root, folderPath)) {
    return {
      available: false,
      status: 409,
      reason: 'PROJECT_WORKSPACE_UNSAFE',
      message: 'The stored workspace path for this project does not resolve to a folder inside the configured Projects Root.',
      possibleAction:
        'Project Hub will not launch anything outside the Projects Root. Check the Projects Root in Settings, or recreate the project so its workspace is recorded correctly.'
    };
  }

  try {
    const stats = await fsp.lstat(folderPath);
    if (stats.isSymbolicLink()) {
      return {
        available: false,
        status: 409,
        reason: 'PROJECT_WORKSPACE_UNSAFE',
        message: 'The stored workspace path for this project is a link, so Project Hub will not launch it.',
        possibleAction: 'Open the linked location yourself, or recreate the project so its workspace is recorded correctly.'
      };
    }
    if (!stats.isDirectory()) {
      return {
        available: false,
        status: 409,
        reason: 'PROJECT_WORKSPACE_NOT_A_DIRECTORY',
        message: `The stored workspace path for this project is not a folder (${folderPath}).`,
        possibleAction:
          'Project Hub will not replace whatever is at that path. Move it aside yourself, or recreate the project so its workspace is recorded correctly.'
      };
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return {
        available: false,
        status: 409,
        reason: 'PROJECT_WORKSPACE_GONE',
        message: `The project folder no longer exists on disk (${folderPath}).`,
        possibleAction:
          'Nothing in the project record was lost. Restore the folder at that exact path yourself, or update the project - Project Hub never recreates a missing folder automatically.'
      };
    }
    return {
      available: false,
      status: 409,
      reason: 'PROJECT_WORKSPACE_UNREADABLE',
      message: 'Project Hub could not check the project folder on disk.',
      possibleAction: 'Check the folder permissions, then try again.'
    };
  }

  return { available: true, folderPath };
}

function unsupportedPlatform(): ApiError {
  return new ApiError(
    409,
    `Opening folders and editors is only supported on Windows; this server is running on "${process.platform}".`,
    { code: 'PLATFORM_UNSUPPORTED', platform: process.platform },
    {
      category: 'SYSTEM_ERROR',
      operation: 'open a project folder on the local machine',
      possibleAction: 'Open the folder manually using the path shown on the project page.'
    }
  );
}

function launchFailed(target: LocalOpenTarget, command: string, error: NodeJS.ErrnoException): ApiError {
  if (error.code === 'ENOENT') {
    return new ApiError(
      409,
      target === 'vscode'
        ? 'Visual Studio Code could not be found on this machine.'
        : 'Windows File Explorer could not be launched.',
      { code: 'LAUNCHER_NOT_FOUND', command },
      {
        category: 'SYSTEM_ERROR',
        operation: target === 'vscode' ? 'launch Visual Studio Code' : 'open the folder in File Explorer',
        possibleAction:
          target === 'vscode'
            ? 'Install Visual Studio Code, or repair the installation so "Code.exe" exists in its default location or the "code" command is on PATH. Project Hub does not install applications for you.'
            : 'Check that this is a normal Windows installation, then try again.'
      }
    );
  }
  return new ApiError(
    500,
    target === 'vscode' ? 'Visual Studio Code could not be started.' : 'File Explorer could not be started.',
    { code: 'LAUNCH_FAILED', command, errno: error.code ?? null },
    {
      category: 'SYSTEM_ERROR',
      operation: target === 'vscode' ? 'launch Visual Studio Code' : 'open the folder in File Explorer',
      possibleAction: 'Check the folder path and try again. No files were changed.'
    }
  );
}

/**
 * Spawn the launcher and resolve once the process actually started.
 *
 * The promise deliberately settles on the `spawn` event, not on process exit:
 * `explorer.exe` famously returns exit code 1 even on success, and VS Code
 * hands the folder to the running instance and exits. Waiting for an exit code
 * would report failure for a successful launch. A genuine failure to start the
 * executable surfaces as an `error` event (ENOENT etc.) and is mapped by the
 * caller.
 */
function spawnDetached(command: string, args: string[], target: LocalOpenTarget): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
    } catch (err) {
      reject(launchFailed(target, command, err as NodeJS.ErrnoException));
      return;
    }
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', (err) => reject(launchFailed(target, command, err as NodeJS.ErrnoException)));
  });
}

/** Open the folder in Windows File Explorer. */
export async function launchExplorer(folderPath: string): Promise<void> {
  if (process.platform !== 'win32') throw unsupportedPlatform();
  // `explorer.exe <path>` opens a window at that path. No flags, no shell.
  await spawnDetached('explorer.exe', [folderPath], 'explorer');
}

/**
 * Find VS Code, preferring a direct path to Code.exe.
 *
 * Spawning `code.cmd` itself is not possible with `shell: false` (Windows
 * refuses to start .cmd files that way, and routing through cmd.exe would mean
 * rebuilding a quoted command line from user-owned path segments). Code.exe
 * accepts the same folder argument, so every candidate below is the real
 * executable:
 *
 *   1. the two standard install locations (user setup and system setup)
 *   2. the Code.exe next to the `bin\code.cmd` shim that `where code` finds,
 *      which covers PATH-based installs whose parent layout matches
 *
 * If none of those exist, the caller receives a clear installation-guidance
 * error. Nothing is installed, downloaded or reconfigured.
 */
async function findVSCodeExecutable(): Promise<string | null> {
  const candidates: string[] = [];
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'));
  }
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'));
  }
  if (process.env['ProgramFiles(x86)']) {
    candidates.push(path.join(process.env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe'));
  }

  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }

  const shim = await findOnPath('code.cmd');
  if (shim) {
    // `<install>\bin\code.cmd` -> `<install>\Code.exe`
    const derived = path.resolve(path.dirname(shim), '..', 'Code.exe');
    if (await isFile(derived)) return derived;
  }
  return null;
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await fsp.lstat(target)).isFile();
  } catch {
    return false;
  }
}

/** Ask Windows where a command lives. Only ever asked for a fixed name. */
function findOnPath(commandName: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = spawn('where.exe', [commandName], { shell: false, windowsHide: true });
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += String(chunk);
      });
      child.once('error', () => resolve(null));
      child.once('close', () => {
        // `where` prints every match, one per line; the first wins.
        const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
        resolve(first || null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** Open the folder in VS Code, or explain exactly why it could not be. */
export async function launchVSCode(folderPath: string): Promise<void> {
  if (process.platform !== 'win32') throw unsupportedPlatform();
  const executable = await findVSCodeExecutable();
  if (!executable) {
    throw new ApiError(
      409,
      'Visual Studio Code could not be found on this machine.',
      { code: 'VSCODE_NOT_FOUND' },
      {
        category: 'SYSTEM_ERROR',
        operation: 'launch Visual Studio Code',
        possibleAction:
          'Install Visual Studio Code (the default installer location or the "Add to PATH" option are both detected), then try again. Project Hub does not install applications for you.'
      }
    );
  }
  await spawnDetached(executable, [folderPath], 'vscode');
}

/**
 * Shared step for both endpoints: refuse unsupported platforms, resolve the
 * trusted folder, then log a one-line diagnostic (project id and outcome only -
 * no request input is ever part of what is launched).
 */
export async function prepareLocalOpen(
  project: { id: number; folderName: string | null; folderPath: string | null },
  target: LocalOpenTarget
): Promise<string> {
  if (process.platform !== 'win32') throw unsupportedPlatform();
  const resolved = await resolveProjectFolderForOpening(project);
  if (!resolved.available) {
    console.warn(
      `${LOG_PREFIX} refusing to open ${target} for project ${project.id}: ${resolved.reason}`
    );
    throw new ApiError(resolved.status, resolved.message, { code: resolved.reason }, {
      category: resolved.reason === 'PROJECT_WORKSPACE_MISSING' ? 'DATA_MISSING' : 'SYSTEM_ERROR',
      operation: target === 'vscode' ? 'open the project folder in Visual Studio Code' : 'open the project folder in File Explorer',
      possibleAction: resolved.possibleAction
    });
  }
  return resolved.folderPath;
}
