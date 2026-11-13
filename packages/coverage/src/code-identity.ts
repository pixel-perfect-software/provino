// A build identity for the transform cache key. The package version is `0.0.0` until release, so
// it can't tell an entry written before an edit to the instrumenter (or to one of its vendored
// patches) from one written after, and the pipeline's own fingerprint covers only
// `@provino/transform`'s code. The identity is a hash of this package's own code files. The same
// function as `@provino/transform`'s `cache/code-identity.ts`: this package sits in a layer that
// does not import it.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const CODE_FILE = /\.(?:ts|mts|cts|js|mjs|cjs)$/
const NOT_RUNTIME = /(?:\.d\.[cm]?ts|\.test\.[cm]?[jt]s|\.test-d\.ts)$|(?:^|[\\/])test-[^\\/]*$/

function collect(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') collect(path, out)
    } else if (CODE_FILE.test(entry.name) && !NOT_RUNTIME.test(path)) {
      out.push(path)
    }
  }
}

/**
 * The hash of every runtime code file under `dir` (tests, type tests and declarations left out),
 * by relative path and content, in a fixed order.
 * @internal
 */
export function codeIdentityOf(dir: string): string {
  const files: string[] = []
  collect(dir, files)
  files.sort()
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(relative(dir, file).split(sep).join('/'))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}

let own: string | undefined

/**
 * The identity of this package's code, computed once per process: `src/` when running from source
 * (the `provino-source` condition), else the directory of the built files this module is in.
 * @internal
 */
export function ownCodeIdentity(): string {
  own ??= codeIdentityOf(fileURLToPath(new URL('./', import.meta.url)))
  return own
}
