import { arch, availableParallelism, cpus, platform, release, totalmem } from 'node:os'
import type { RunEnvironment } from '@provino/types'

/** Whether `CI` is set to something other than empty, `0` or `false`. */
function isCi(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.CI?.trim().toLowerCase()
  return value !== undefined && value !== '' && value !== '0' && value !== 'false'
}

/**
 * The machine and toolchain a run happens on, read from `node:os` and `process`. `runners` maps
 * each runner to its version. `env` is a test seam.
 * @internal
 */
export function readRunEnvironment(
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
