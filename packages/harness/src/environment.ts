import { arch, availableParallelism, cpus, platform, release, totalmem } from 'node:os'
import type { RunEnvironment } from '@provino/types'

/**
 * Whether the environment says it is CI: `CI` is set to something other than empty, `0` or
 * `false`.
 */
function isCi(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.CI?.trim().toLowerCase()
  return value !== undefined && value !== '' && value !== '0' && value !== 'false'
}

/**
 * The machine and toolchain a run happens on. `runners` maps each runner measured to its version,
 * e.g. `{ jest: '30.5.2' }`. `cpuCount` is the parallelism this process may use, and `ci` is true
 * when `CI` is set to anything but empty, `0` or `false`. `env` is a test seam.
 * @public
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
