// What the two runners' tests may import from each other's API (B27h3). A test file runs on Provino
// or on node:test (the bootstrap set), and the helpers a test imports may be shared:
//
// - a node:test `after`, `test` or `describe` does nothing in a Provino worker (the hook is never called,
//   so the temp dir it was to remove stays), so a file a Provino-run test reaches makes no value
//   import of `node:test`;
// - a `provino` `afterAll` or `onTestFinished` called at a helper's module scope registers nothing under
//   node:test (outside a worker the call has no file to attach to), so a file a bootstrap test reaches
//   makes no value import of `provino`.
//
// A type import is erased and fine, and so is a file only the other runner's tests reach. The scan
// follows relative imports by their exact path (every relative import here is a `.ts` path),
// transitively, through the files under the migrated packages' include roots; each file is read once.
// It does not read `createRequire(...)('node:test')` or `process.getBuiltinModule`: no file does
// either, and a static scan can't know a callee.
import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { parseSync } from 'oxc-parser'
import { bootstrapFiles, migratedDirs, TEST_ROOTS, testFilesOf } from './dogfood.ts'

/**
 * The specifiers a TypeScript file loads at run time, read from its syntax tree (so a string that
 * holds an import statement is none): static imports and re-exports, and `import()` of a string or a
 * template with no substitution. A type import or re-export, or an import whose every specifier is
 * `type`, is erased and loads nothing.
 */
function runtimeRequests(file: string, text: string): string[] {
  const { module } = parseSync(file, text)
  const requests: string[] = []
  for (const statement of module.staticImports) {
    if (statement.entries.length > 0 && statement.entries.every((entry) => entry.isType)) continue
    requests.push(statement.moduleRequest.value)
  }
  for (const statement of module.staticExports) {
    for (const entry of statement.entries) {
      if (entry.moduleRequest !== null && !entry.isType) requests.push(entry.moduleRequest.value)
    }
  }
  for (const call of module.dynamicImports) {
    const written = text.slice(call.moduleRequest.start, call.moduleRequest.end)
    const quote = written[0]
    const literal = quote === "'" || quote === '"' || (quote === '`' && !written.includes('${'))
    if (literal && written.at(-1) === quote) requests.push(written.slice(1, -1))
  }
  return requests
}

/** Each file reached from `roots` with the file that first reached it (a root has none). */
function reach(
  roots: readonly string[],
  read: (file: string) => string | undefined,
  /** Called once per file reached, with the specifiers it loads at run time. */
  visit: (file: string, requests: readonly string[], chain: readonly string[]) => void,
): void {
  const parentOf = new Map<string, string | undefined>()
  const chainOf = (file: string): string[] => {
    const chain = [file]
    for (let at = parentOf.get(file); at !== undefined; at = parentOf.get(at)) chain.unshift(at)
    return chain
  }
  for (const root of roots) {
    const queue: [file: string, parent: string | undefined][] = [[root, undefined]]
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const [file, parent] = next
      if (parentOf.has(file)) continue
      parentOf.set(file, parent)
      const text = read(file)
      if (text === undefined || !/\.[cm]?tsx?$/.test(file)) continue
      const requests = runtimeRequests(file, text)
      visit(file, requests, chainOf(file))
      for (const request of requests) {
        if (request.startsWith('.')) {
          const target = posix.normalize(posix.join(posix.dirname(file), request))
          if (read(target) !== undefined) queue.push([target, file])
        }
      }
    }
  }
}

/**
 * The files a test file Provino runs reaches that make a value import of `node:test`, each as the
 * chain of imports that led to it. `tests` are the test files Provino runs (the include globs minus
 * the bootstrap set); `read` gives a file's text, or `undefined` when it is no source to follow.
 * @internal
 */
export function nodeTestImportProblems(
  tests: readonly string[],
  read: (file: string) => string | undefined,
): readonly string[] {
  const problems: string[] = []
  reach(tests, read, (file, requests, chain) => {
    if (!requests.includes('node:test')) return
    problems.push(
      chain.length === 1
        ? `${file} is a test file Provino runs and imports node:test: rewrite it (pnpm migrate:node-test rewrite) or add it to the bootstrap set`
        : `${chain.join(' → ')} imports node:test: its hooks and tests never run in a Provino worker, so take the hook as a parameter (the caller passes \`after\` or \`afterAll\`), or use provino's own when only Provino tests import this file, or keep it out of what a Provino test imports (a file only the bootstrap set imports may use node:test)`,
    )
  })
  return problems.sort()
}

/**
 * The mirror: the files a bootstrap test (it runs on node:test) reaches that make a value import of
 * `provino`. Its `afterAll` and `onTestFinished` register nothing outside a Provino worker, so a
 * cleanup called at module scope would be lost.
 * @internal
 */
export function provinoImportProblems(
  bootstrap: readonly string[],
  read: (file: string) => string | undefined,
): readonly string[] {
  const problems: string[] = []
  reach(bootstrap, read, (file, requests, chain) => {
    if (!requests.includes('provino')) return
    problems.push(
      chain.length === 1
        ? `${file} is a bootstrap test (it runs on node:test) and imports provino`
        : `${chain.join(' → ')} imports provino: a bootstrap test runs on node:test, where provino's \`afterAll\` and \`onTestFinished\` register nothing, so take the hook as a parameter (the caller passes \`after\`), or keep it out of what a bootstrap test imports`,
    )
  })
  return problems.sort()
}

/**
 * A reader of the repo's own sources for the two scans: a file's text when it is under one of
 * `roots` (and not in `node_modules`) and can be read, else `undefined`. Each file is read once.
 * @internal
 */
export function sourceReader(
  repoRoot: string,
  roots: readonly string[],
): (file: string) => string | undefined {
  const texts = new Map<string, string | undefined>()
  return (file) => {
    if (texts.has(file)) return texts.get(file)
    let text: string | undefined
    if (roots.some((root) => file.startsWith(root)) && !file.includes('/node_modules/')) {
      try {
        text = readFileSync(join(repoRoot, file), 'utf8')
      } catch {
        text = undefined
      }
    }
    texts.set(file, text)
    return text
  }
}

/**
 * Both scans over the repo at `repoRoot`: the migrated packages' test files, those Provino runs and
 * the bootstrap set, followed through the files under their include roots.
 * @internal
 */
export function importProblems(repoRoot: string): readonly string[] {
  const dirs = migratedDirs(repoRoot)
  const bootstrap = bootstrapFiles(repoRoot)
  const read = sourceReader(
    repoRoot,
    dirs.flatMap((dir) => TEST_ROOTS.map((root) => `${dir}/${root}/`)),
  )
  const tests = dirs
    .flatMap((dir) => testFilesOf(join(repoRoot, dir)).map((file) => `${dir}/${file}`))
    .filter((file) => !bootstrap.includes(file))
  return [
    ...nodeTestImportProblems(tests, read),
    ...provinoImportProblems(
      bootstrap.filter((file) => read(file) !== undefined),
      read,
    ),
  ]
}
