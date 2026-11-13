// Node's compile cache for the bin (B21d, T3.7): the code Provino's own chunks compile is cached on
// disk, so a warm start reads V8's bytecode instead of compiling it again (B21e measured the cold
// import of `provino` going from 36.8 to 31.8 ms, `local`). It is one of the bin's light files
// (`BIN_LIGHT_FILES` in `tooling/packaging/src/umbrella.ts`): the bin calls it before it imports the
// rest, so it may import nothing that loads an Oxc binding.
import { join } from 'node:path'
import {
  cacheModeFor,
  enableNativeCompileCache,
  type NativeCompileCacheResult,
} from '@provino/transform/v8cache'

/** The flags that turn code coverage on, as Jest and Vitest spell them. */
const COVERAGE_FLAGS: ReadonlySet<string> = new Set(['--coverage', '--collectCoverage'])

/** `--clear-cache` as `--clearCache`: Jest's parser takes a dashed flag as its camel-case one. */
function camelFlag(flag: string): string {
  return flag.startsWith('--')
    ? `--${flag.slice(2).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())}`
    : flag
}

/**
 * Whether the run collects coverage: `NODE_V8_COVERAGE` is set (Node's own collector), or the
 * command line names a coverage flag (`--coverage`, `--collectCoverage`, with or without `=value`;
 * `=false` is off). A code cache is never consumed under coverage: V8 reports block ranges only for
 * the functions it compiled in this process (`cacheModeFor`, build-plan §6).
 * @internal
 */
export function coverageOn(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (env.NODE_V8_COVERAGE !== undefined && env.NODE_V8_COVERAGE !== '') return true
  return argv.some((arg) => {
    const [flag, value] = arg.split('=', 2)
    return flag !== undefined && COVERAGE_FLAGS.has(camelFlag(flag)) && value !== 'false'
  })
}

/**
 * Whether the command line wants no cache written: `--no-cache`, or Jest's `--cache=false` and
 * `--cache false` (neither the results cache nor the transform cache is read or written, and the
 * compile cache is one more cache), and the two modes that start no run, `--clearCache` (which
 * removes the directory the compile cache would write into at exit) and `--showConfig`.
 * @internal
 */
export function cachesOff(argv: readonly string[]): boolean {
  return argv.some((arg, index) => {
    const flag = camelFlag(arg)
    return (
      arg === '--no-cache' ||
      arg === '--cache=false' ||
      flag === '--clearCache' ||
      flag === '--showConfig' ||
      (arg === '--cache' && argv[index + 1] === 'false')
    )
  })
}

/**
 * Turns on Node's compile cache for this process, in `<cwd>/node_modules/.cache/provino/compile`,
 * unless coverage is on (`cacheModeFor`), the command line says `--no-cache` (`cachesOff`) or the
 * user turned it off (`NODE_DISABLE_COMPILE_CACHE`). When it was turned on here and `env` names no
 * `NODE_COMPILE_CACHE` already, that variable is set to the same directory, which the forked
 * workers inherit: `module.enableCompileCache` is for this
 * process only, and a worker starts cold without it. The bin is the one caller; `run()` never does
 * this. It never throws: a cache that can't be turned on costs nothing but the speed-up.
 * @internal
 */
export function enableBinCompileCache(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  cwd: string,
): NativeCompileCacheResult {
  const dir = join(cwd, 'node_modules', '.cache', 'provino', 'compile')
  const mode = cachesOff(argv) ? 'off' : cacheModeFor({ coverage: coverageOn(argv, env) })
  const result = enableNativeCompileCache(dir, mode)
  if (result.status === 'enabled' && env.NODE_COMPILE_CACHE === undefined) {
    env.NODE_COMPILE_CACHE = dir
  }
  return result
}
