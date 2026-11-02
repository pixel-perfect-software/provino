import { execFileSync } from 'node:child_process'
import { arch, availableParallelism, cpus, platform, release, totalmem } from 'node:os'
import type { RunEnvironment, RunRef } from '@provino/types'
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

/**
 * The commit under `cwd` and the time of the run. `now` is a test seam.
 * @public
 */
export function readRunRef(options?: { readonly cwd?: string; readonly now?: Date }): RunRef {
  let sha: string
  try {
    sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: options?.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (cause) {
    throw new BenchError(
      'BENCH_GIT_UNAVAILABLE',
      'could not read the commit with git rev-parse HEAD',
      {
        cause,
      },
    )
  }
  return { sha, date: (options?.now ?? new Date()).toISOString() }
}
