// The child process of `compile-cache.test.ts`: `enableBinCompileCache` is process-global (it turns
// Node's compile cache on and sets `NODE_COMPILE_CACHE`), so each case runs in a process of its own.
// Usage: node compile-cache-child.ts <cwd> [bin arguments...]. Prints one JSON line.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Loaded by URL: the type-test project includes this directory but not the package's source. */
const { enableBinCompileCache } = (await import(
  new URL('../src/internal/compile-cache.ts', import.meta.url).href
)) as {
  enableBinCompileCache(
    argv: readonly string[],
    env: Record<string, string | undefined>,
    cwd: string,
  ): { readonly status: string }
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
    created: existsSync(dir),
    tagged: existsSync(join(dir, 'CACHEDIR.TAG')),
  })}\n`,
)
