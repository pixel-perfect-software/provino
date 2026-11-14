// The recorder's work directories that are on disk right now. A signal ends the CLI through
// `process.exit` (`exitOnSignals`), which skips every `catch` and `finally`, so the cleanup that
// follows a failed or finished run never happens. The registry removes what is left on `exit`.
import { type RmOptions, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import { HarnessError } from '../errors.ts'
import { errorMessage } from './guards.ts'

/** The part of `process` the registry uses. */
export interface ExitTarget {
  once(event: 'exit', listener: () => void): unknown
  off(event: 'exit', listener: () => void): unknown
}

/** What the registry does, which tests replace. */
export interface WorkDirRegistryOptions {
  /** Where `exit` comes from. Default: `process`. */
  readonly target?: ExitTarget
  /** Removes one directory and everything in it, or throws. Default: `rmSync`. */
  readonly remove?: (dir: string) => void
  /** Says that a directory could not be removed. Default: a line on stderr. */
  readonly report?: (message: string) => void
}

/**
 * The work directories a process will remove on `exit` unless they are forgotten first.
 * @internal
 */
export interface WorkDirRegistry {
  /** Removes `dir` when the process exits, unless `forget(dir)` comes first. */
  track(dir: string): void
  /** `dir` is gone (or is meant to stay): leave it alone on exit. */
  forget(dir: string): void
}

/**
 * How a work directory is removed, by `rm` and by the exit hook's `rmSync` alike: the whole tree,
 * no error if it is already gone, a few retries for a file that is still busy.
 */
export const REMOVE_TREE_OPTIONS: Readonly<RmOptions> = {
  recursive: true,
  force: true,
  maxRetries: 3,
}

/**
 * Where work directories go: `value` (`PROVINO_RECORD_ROOT`) when set, else `fallback`. A value
 * must be an absolute path (`HARNESS_BAD_RECORD_ROOT` otherwise: a relative one would follow the
 * working directory); it is resolved and, when it exists, replaced by its real path, so a symlink
 * is never what Jest or git sees.
 * @internal
 */
export function resolveRecordRoot(value: string | undefined, fallback: string): string {
  if (value === undefined || value === '') return fallback
  if (!path.isAbsolute(value)) {
    throw new HarnessError(
      'HARNESS_BAD_RECORD_ROOT',
      `PROVINO_RECORD_ROOT must be an absolute path, not "${value}"`,
    )
  }
  const resolved = path.resolve(value)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

function removeTree(dir: string): void {
  rmSync(dir, REMOVE_TREE_OPTIONS)
}

function reportOnStderr(message: string): void {
  process.stderr.write(`${message}\n`)
}

/**
 * Makes a registry. It listens for `exit` only while it has a directory, so a finished run leaves
 * nothing on `process`.
 * @internal
 */
export function createWorkDirRegistry(options: WorkDirRegistryOptions = {}): WorkDirRegistry {
  const target = options.target ?? process
  const remove = options.remove ?? removeTree
  const report = options.report ?? reportOnStderr
  const live = new Set<string>()

  const onExit = (): void => {
    for (const dir of live) {
      try {
        remove(dir)
      } catch (error) {
        // Too late to do anything but say so, and the other directories still need removing.
        report(`could not remove the work directory ${dir}: ${errorMessage(error)}`)
      }
    }
    live.clear()
  }

  return {
    track(dir) {
      if (live.size === 0) target.once('exit', onExit)
      live.add(dir)
    },
    forget(dir) {
      if (live.delete(dir) && live.size === 0) target.off('exit', onExit)
    },
  }
}
