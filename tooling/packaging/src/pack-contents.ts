import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PackedPackage } from './pack.ts'
import type { WorkspacePackage } from './workspace.ts'

/** The file that carries the licenses of the code a package copies from other projects. */
export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.md'

/** What every public tarball must hold besides `package.json` and `dist`. */
const REQUIRED_FILES: readonly string[] = ['README.md', 'LICENSE']

/**
 * A module's path on its own comment line: how the bundler marks where each source file's code
 * starts in the JavaScript it writes (`// ../dialect-jest/src/runtime/vendor/jest-expect/x.ts`).
 * Only paths with a `vendor` directory count: that is where copied code lives (`UPSTREAM.md`).
 */
const VENDORED_MODULE = /^\/\/ (\S*\/vendor\/\S+\.[cm]?[jt]sx?)$/gm

/** Every `.js`, `.mjs` and `.cjs` file under `dir`, as absolute paths. */
function javascriptFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return javascriptFiles(path)
    return /\.[cm]?js$/.test(entry.name) ? [path] : []
  })
}

/**
 * The vendored source files a built package holds: the files under its `dist` directory whose
 * JavaScript includes a module from a `vendor` directory. Declaration files are not read: types
 * ship in the package whose JavaScript they describe.
 * @internal
 */
export function vendoredSourcesInDist(distDir: string): readonly string[] {
  const found = new Set<string>()
  for (const file of javascriptFiles(distDir)) {
    for (const match of readFileSync(file, 'utf8').matchAll(VENDORED_MODULE)) {
      if (match[1] !== undefined) found.add(match[1])
    }
  }
  return [...found]
}

/**
 * What is wrong with the files of one packed public package: a missing README.md or LICENSE; built
 * code that holds vendored sources but a tarball with no `THIRD_PARTY_NOTICES.md`, or one that is
 * not the repository's own (a copy kept in the package directory, as `LICENSE` is).
 *
 * The bundler may keep a vendored file's license header and may not: the Jest headers survive a
 * build, the headers some Vitest-derived files never had cannot, and `natural-compare` has an
 * `@license` line and no copyright. The notices file is what satisfies the licenses, so it is
 * required wherever vendored code ships and its text is the one place they are all written.
 * @internal
 */
export function packContentProblems(
  pkg: WorkspacePackage,
  packed: PackedPackage,
  root: string,
): readonly string[] {
  const name = pkg.manifest.name
  const problems: string[] = []
  for (const file of REQUIRED_FILES) {
    if (!packed.files.includes(file)) problems.push(`${name}: the tarball has no ${file}`)
  }
  const vendored = vendoredSourcesInDist(join(pkg.dir, 'dist'))
  if (vendored.length === 0) return problems
  if (!packed.files.includes(NOTICES_FILE)) {
    problems.push(
      `${name}: dist holds vendored code (${vendored.slice(0, 3).join(', ')}${vendored.length > 3 ? `, and ${vendored.length - 3} more` : ''}) ` +
        `but the tarball has no ${NOTICES_FILE}: copy the root one into ${pkg.rel} and add it to "files"`,
    )
  } else if (
    readFileSync(join(pkg.dir, NOTICES_FILE), 'utf8') !==
    readFileSync(join(root, NOTICES_FILE), 'utf8')
  ) {
    problems.push(
      `${name}: ${NOTICES_FILE} differs from the repository's: copy the root one over it`,
    )
  }
  return problems
}

/** Every directory under `dir` that holds an `UPSTREAM.md`, repo-relative with `/`. */
function upstreamDirectories(root: string, dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
        continue
      }
      found.push(...upstreamDirectories(root, rel))
    } else if (entry.name === 'UPSTREAM.md') {
      found.push(dir)
    }
  }
  return found
}

/**
 * Every directory of copied code (one with an `UPSTREAM.md`) must be named in the repository's
 * notices file, so a new vendor directory cannot ship without its license.
 * @internal
 */
export function noticesCoverageProblems(root: string): readonly string[] {
  const notices = readFileSync(join(root, NOTICES_FILE), 'utf8')
  const directories = ['packages', 'tooling'].flatMap((base) =>
    existsSync(join(root, base)) ? upstreamDirectories(root, base) : [],
  )
  return directories
    .filter((directory) => !notices.includes(directory))
    .map((directory) => `${NOTICES_FILE} does not name ${directory}, which has an UPSTREAM.md`)
}
