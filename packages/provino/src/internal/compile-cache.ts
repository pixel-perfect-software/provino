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
 * user turned it off (`NODE_DISABLE_COMPILE_CACHE`). It writes nothing to `env`: Jest sets no
 * `NODE_COMPILE_CACHE`, and a test that reads `process.env` or starts `node` must not see one (D7),
 * which covers `--pool inline` and `-i`, where the tests run in this process. The forked workers
 * start cold without it (`module.enableCompileCache` is for this process only), so the directory
 * is remembered here and `workerStartupEnv` offers it to the pool, which puts it in a fork's spawn
 * environment only, for Node's own startup, and has the worker remove it before any file loads.
 * The bin is the one caller; `run()` never does this. It never throws: a cache that can't be turned
 * on costs nothing but the speed-up.
 * @internal
 */
export function enableBinCompileCache(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): NativeCompileCacheResult {
  const dir = join(cwd, 'node_modules', '.cache', 'provino', 'compile')
  const mode = cachesOff(argv) ? 'off' : cacheModeFor({ coverage: coverageOn(argv, env) })
  const result = enableNativeCompileCache(dir, mode)
  // `enabled` only when this call did it: a `NODE_COMPILE_CACHE` the user set is `already-enabled`.
  enabled =
    result.status === 'enabled' ? { directory: dir, portable: result.portable === true } : undefined
  return result
}

/** Where `enableBinCompileCache` turned the cache on, and how, when it did: a process-wide fact, like the cache. */
let enabled: { readonly directory: string; readonly portable: boolean } | undefined

/**
 * What a forked worker's Node must find in its spawn environment to use the bin's compile cache
 * (`RunPoolOptions.startupEnv`): `NODE_COMPILE_CACHE`, when `enableBinCompileCache` turned the cache
 * on here, and `NODE_COMPILE_CACHE_PORTABLE=1` with it when the bin's cache is portable (Node 24.12
 * on): Node 26 names a portable cache's directory without the uid suffix, so a fork that wasn't
 * told would keep its entries in a directory of its own and share none with the bin. Nothing when
 * the bin turned nothing on (a library caller, coverage, `--no-cache`) or when the user set
 * `NODE_COMPILE_CACHE` themselves: that one reaches the workers, and the tests, as it is. The
 * worker removes every name listed here before any file loads.
 * @internal
 */
export function workerStartupEnv(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  if (enabled === undefined || env.NODE_COMPILE_CACHE !== undefined) return {}
  return {
    NODE_COMPILE_CACHE: enabled.directory,
    ...(enabled.portable ? { NODE_COMPILE_CACHE_PORTABLE: '1' } : {}),
  }
}
