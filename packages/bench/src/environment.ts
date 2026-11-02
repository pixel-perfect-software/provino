import { execFileSync } from 'node:child_process'
import { arch, availableParallelism, cpus, platform, release, totalmem } from 'node:os'
import type { BenchLabel, RunEnvironment, RunRef } from '@provino/types'
import { BenchError } from './errors.ts'

/**
 * Whether the environment says it is CI: `CI` is set to something other than empty, `0` or
 * `false`.
 * @public
 */
export function isCi(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.CI?.trim().toLowerCase()
  return value !== undefined && value !== '' && value !== '0' && value !== 'false'
}

/**
 * The machine and toolchain a benchmark runs on. `runners` maps each runner measured to its
 * version, e.g. `{ jest: '30.5.2' }`.
 * @public
 */
export function readEnvironment(
  runners: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): RunEnvironment {
  return {
    os: platform(),
    osRelease: release(),
    arch: arch(),
    cpuModel: cpus()[0]?.model ?? 'unknown',
    cpuCount: availableParallelism(),
    memoryMb: Math.round(totalmem() / (1024 * 1024)),
    node: process.version,
    runners,
    ci: isCi(env),
  }
}

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

/**
 * Refuses a `desktop` or `pinned` record on a dirty tree with `BENCH_DIRTY_TREE`: those labels
 * name a commit that anyone can check out, which a dirty tree makes untrue. A `local` record may
 * be dirty; its summary says so.
 * @public
 */
export function requireCleanTree(label: BenchLabel, ref: RunRef): void {
  if (label !== 'local' && ref.dirty) {
    throw new BenchError(
      'BENCH_DIRTY_TREE',
      `refusing a ${label} run: the git working tree has uncommitted changes (git status --porcelain is not empty), so commit ${ref.sha.slice(0, 7)} would not describe the code measured. Commit or stash them, or use --label local`,
    )
  }
}
