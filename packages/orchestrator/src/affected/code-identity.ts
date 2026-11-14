// What the edge cache's entries were made by. The package version is `0.0.0` until release, so it
// can't tell an entry the extractor wrote before an edit from one written after: the identity is a
// hash of the code files beside this one's directory instead (`src/` from source; the built files of
// the package that holds this module, which for `provino` inline the loader's lexer too). The same
// rule as `@provino/transform`'s `cache/code-identity.ts`, which this package does not import.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
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

let own: string | undefined

/**
 * The hash of this package's runtime code files (tests, type tests and declarations left out), by
 * relative path and content, once per process.
 * @internal
 */
export function engineIdentity(): string {
  if (own !== undefined) return own
  const dir = fileURLToPath(new URL('../', import.meta.url))
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
  own = hash.digest('hex').slice(0, 16)
  return own
}

/**
 * The hash of one module's file (an absolute path or a `file:` URL), or `''` for one that can't be
 * read: an extractor's identity follows its own code.
 * @internal
 */
export function moduleIdentity(location: string): string {
  try {
    const path = location.startsWith('file:') ? fileURLToPath(location) : location
    if (!isAbsolute(path)) return ''
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
  } catch {
    return ''
  }
}
