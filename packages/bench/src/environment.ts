import { execFileSync } from 'node:child_process'
import type { RunRef } from '@provino/types'
import { BenchError } from './errors.ts'

function git(cwd: string | undefined, args: readonly string[], what: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (cause) {
    throw new BenchError(
      'BENCH_GIT_UNAVAILABLE',
      `could not read ${what} with git ${args.join(' ')}`,
      {
        cause,
      },
    )
  }
}

/**
 * The commit under `cwd`, whether its working tree is dirty (`git status --porcelain` printed
 * anything, untracked files included), and the time. Read this when the bench starts, before any
 * run, so the record names the code that was measured and a git failure costs nothing. `now` is a
 * test seam.
 * @public
 */
export function readRunRef(options?: { readonly cwd?: string; readonly now?: Date }): RunRef {
  const cwd = options?.cwd
  const date = (options?.now ?? new Date()).toISOString()
  const sha = git(cwd, ['rev-parse', 'HEAD'], 'the commit').trim()
  const dirty = git(cwd, ['status', '--porcelain'], 'the working tree state').trim() !== ''
  return { sha, date, dirty }
}
