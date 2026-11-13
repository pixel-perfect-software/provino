// The child process of `compile-cache.test.ts`: `enableBinCompileCache` is process-global (it turns
// Node's compile cache on and remembers where), so each case runs in a process of its own.
// Usage: node compile-cache-child.ts <cwd> [bin arguments...]. Prints one JSON line.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Loaded by URL: the type-test project includes this directory but not the package's source. */
const { enableBinCompileCache, workerStartupEnv } = (await import(
  new URL('../src/internal/compile-cache.ts', import.meta.url).href
)) as {
  enableBinCompileCache(
    argv: readonly string[],
    env: Readonly<Record<string, string | undefined>>,
    cwd: string,
  ): { readonly status: string }
  workerStartupEnv(
    env: Readonly<Record<string, string | undefined>>,
  ): Readonly<Record<string, string>>
}

const [cwd = '', ...argv] = process.argv.slice(2)
const before = process.env.NODE_COMPILE_CACHE
const result = enableBinCompileCache(argv, process.env, cwd)
const grandchild = execFileSync(
  process.execPath,
  ['-e', 'process.stdout.write(process.env.NODE_COMPILE_CACHE ?? "")'],
  { encoding: 'utf8', env: process.env },
)
const dir = join(cwd, 'node_modules', '.cache', 'provino', 'compile')
process.stdout.write(
  `${JSON.stringify({
    status: result.status,
    before: before ?? null,
    after: process.env.NODE_COMPILE_CACHE ?? null,
    grandchild,
    workerEnv: workerStartupEnv(process.env),
    created: existsSync(dir),
    tagged: existsSync(join(dir, 'CACHEDIR.TAG')),
  })}\n`,
)
