// What a package needs, beside its rewritten test files, to run them on Provino (B27g2, D191):
// the config, the tests' tsconfig project (its `src` tests and its `provino.config.ts`), its
// turbo.json, the tsconfig exclude and the root reference, and the `test` script. Idempotent: it
// writes what is missing, adds what an existing file lacks (never removing a line), and sets the
// script, so running `rewrite` again after editing `bootstrap.json` refreshes the script. Left to
// hand: the bootstrap entries themselves, and creating a missing `test/` or `bench/` tsconfig.json
// (the scaffold then adds the `provino` and dependency references to the one that covers each test).
import { existsSync, readdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { PACKAGE_CONFIG, SRC_TEST_GLOB, TEST_ROOTS, testScript } from '../dogfood.ts'
import { record } from '../package-json.ts'
import { MigrateError } from './errors.ts'

const CONFIG = `import type { ProvinoConfig } from 'provino-runner/config'
import { packageConfig } from '../../tooling/provino/base.ts'

const config: ProvinoConfig = packageConfig(import.meta.dirname)

export default config
`

/** The tests projects' shared base (compiler options every migrated package's tests project needs). */
const TESTS_BASE = '../../tooling/provino/tsconfig.tests.base.json'

const TURBO = {
  $schema: '../../node_modules/turbo/schema.json',
  extends: ['//'],
  tasks: {
    test: {
      dependsOn: ['transit', 'provino#build'],
      inputs: [
        '$TURBO_DEFAULT$',
        '$TURBO_ROOT$/tooling/provino/**',
        '$TURBO_ROOT$/tooling/packaging/src/dogfood.ts',
      ],
    },
  },
}

type Json = Record<string, unknown>
type Reference = { path: string }

/** The `references` of a tsconfig, `[]` when it has none. */
const referencesOf = (config: Json): Reference[] => (config.references ?? []) as Reference[]

/**
 * JSON text as tsc reads a tsconfig: `//` and `/* *\/` comments and trailing commas dropped,
 * strings kept as written (a glob's `/*` or a URL's `//` inside one is text). `comments` says
 * whether there were any: writing the file back would lose them.
 */
function stripJsonComments(text: string): { readonly json: string; readonly comments: boolean } {
  let json = ''
  let comments = false
  for (let at = 0; at < text.length; at++) {
    const char = text[at]
    if (char === '"') {
      const start = at
      for (at++; at < text.length && text[at] !== '"'; at++) if (text[at] === '\\') at++
      json += text.slice(start, at + 1)
    } else if (char === '/' && text[at + 1] === '/') {
      comments = true
      while (at < text.length && text[at] !== '\n') at++
      json += '\n'
    } else if (char === '/' && text[at + 1] === '*') {
      comments = true
      const end = text.indexOf('*/', at + 2)
      at = end < 0 ? text.length : end + 1
      json += ' '
    } else {
      // A comma before the closing bracket is a trailing one: it is outside any string, since
      // only whitespace follows it in what is kept.
      if (char === ']' || char === '}') json = json.replace(/,(\s*)$/, '$1')
      json += char
    }
  }
  return { json, comments }
}

/**
 * `text` as JSON: a tsconfig as tsc reads it (`comments`: comments and trailing commas allowed, and
 * whether there were any), a `package.json` as Node reads it. A file with comments is never written
 * back (`updateJson` refuses, naming the edit), so none is lost.
 */
function parseJson(
  path: string,
  text: string,
  allowComments: boolean,
): { readonly value: Json; readonly comments: boolean } {
  const { json, comments } = allowComments
    ? stripJsonComments(text)
    : { json: text, comments: false }
  try {
    return { value: JSON.parse(json) as Json, comments }
  } catch (cause) {
    throw new MigrateError('MIGRATE_WRITE', `cannot read ${path} as JSON: edit it by hand`, {
      cause,
    })
  }
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** The path from `from` to `to` with `/` separators, as a tsconfig and the root's keys write it. */
const posixRelative = (from: string, to: string): string => relative(from, to).split('\\').join('/')

/**
 * What the scaffold will do: each file's new text with a `<path>: <what>` line for the command to
 * print, and each edit it leaves to hand. Nothing is written until `commit`, which writes every
 * file or, when an edit is left to hand, none: a run that stops leaves no package half scaffolded.
 */
class Changes {
  readonly lines: string[] = []
  readonly root: string
  private readonly pending = new Map<string, string>()
  private readonly byHand: string[] = []
  constructor(root: string) {
    this.root = root
  }
  /** The file as this run leaves it so far: its pending text, else what is on disk, else none. */
  async text(path: string): Promise<string | undefined> {
    const pending = this.pending.get(path)
    if (pending !== undefined) return pending
    return existsSync(path) ? await readFile(path, 'utf8') : undefined
  }
  write(path: string, text: string, what: string): void {
    this.pending.set(path, text)
    this.lines.push(`${relative(this.root, path)}: ${what}`)
  }
  leaveToHand(message: string): void {
    this.byHand.push(message)
  }
  async commit(): Promise<void> {
    if (this.byHand.length > 0) {
      throw new MigrateError(
        'MIGRATE_WRITE',
        `${this.byHand.join('\n')}\nnothing was written: make the change(s) above by hand, then run rewrite again`,
      )
    }
    for (const [path, text] of this.pending) await writeFile(path, text)
  }
}

async function writeIfMissing(path: string, text: string, changes: Changes): Promise<void> {
  if ((await changes.text(path)) !== undefined) return
  changes.write(path, text, 'written')
}

/**
 * Reads `path` as this run leaves it, applies `change` (which returns what it changed, or nothing)
 * and plans the write; a file with comments that `change` changes is left to hand instead.
 */
async function updateJson(
  path: string,
  change: (value: Json) => string | undefined,
  changes: Changes,
  allowComments = true,
): Promise<void> {
  const text = await changes.text(path)
  if (text === undefined) {
    throw new MigrateError('MIGRATE_WRITE', `cannot read ${path}: it does not exist`)
  }
  const { value, comments } = parseJson(path, text, allowComments)
  // Kept only where it is needed: the edit to name for a file that can't be rewritten.
  const before = comments ? structuredClone(value) : undefined
  const what = change(value)
  if (what === undefined) return
  if (before !== undefined) {
    // Rewritten, the file would lose its comments: name the edit instead, key by key.
    const keys = [...new Set([...Object.keys(before), ...Object.keys(value)])].filter(
      (key) => JSON.stringify(before[key]) !== JSON.stringify(value[key]),
    )
    const edits = keys.map((key) =>
      key in value ? `"${key}": ${JSON.stringify(value[key])}` : `no "${key}"`,
    )
    changes.leaveToHand(
      `${relative(changes.root, path)} has comments, which rewriting it would drop: make the change by hand (${what}: ${edits.join(', ')})`,
    )
    return
  }
  changes.write(path, json(value), what)
}

/**
 * Adds each of `wanted` that `list` lacks; returns the ones added. Two items are the same when
 * `key` gives them the same string (the item itself by default; a reference's resolved path, so `../x`
 * and `../../packages/x` from another directory are not both written).
 */
function addMissing(
  list: unknown,
  wanted: readonly string[],
  key: (item: string) => string = (item) => item,
): { list: string[]; added: string[] } {
  const current = Array.isArray(list) ? (list as string[]) : []
  const have = new Set(current.map(key))
  const added = wanted.filter((item) => !have.has(key(item)))
  return { list: [...current, ...added], added }
}

/** The directory names of the `@provino/*` workspace packages `manifest` depends on (any kind), sorted. */
function workspacePackages(root: string, manifest: Json): string[] {
  const names = ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((key) =>
    Object.keys(record(manifest[key])),
  )
  return [...new Set(names)]
    .filter((name) => name.startsWith('@provino/') && name !== manifest.name)
    .map((name) => name.slice('@provino/'.length))
    .filter((dir) => existsSync(join(root, 'packages', dir)))
    .sort()
}

/**
 * A lookup of the nearest `tsconfig.json` at or above a file, stopping below the package directory
 * (the package's own project covers `src`, not `test/` or `bench/`); answers are kept per directory.
 */
function tsconfigFinder(packageDir: string): (file: string) => string | undefined {
  const known = new Map<string, string | undefined>()
  const find = (dir: string): string | undefined => {
    if (dir === packageDir || !dir.startsWith(packageDir)) return undefined
    if (known.has(dir)) return known.get(dir)
    const candidate = join(dir, 'tsconfig.json')
    const found = existsSync(candidate) ? candidate : find(dirname(dir))
    known.set(dir, found)
    return found
  }
  return (file) => find(dirname(file))
}

/** The `*.test.ts` files under `directory`, skipping `node_modules` while walking. */
function testFilesUnder(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.name === 'node_modules') return []
    if (entry.isDirectory()) return testFilesUnder(path)
    return entry.name.endsWith('.test.ts') ? [path] : []
  })
}

/**
 * Gives the project covering each `test/` or `bench/` test file the references its migrated tests
 * need: `provino` and every `@provino/*` workspace package the package depends on. Without them a
 * test that imports one resolves through `provino-source` into that package's src, outside any
 * referenced project, and tsc checks its vendored files with the strict flags (not their own D17 ones).
 */
async function referenceTestProjects(
  root: string,
  packageDir: string,
  projects: ReadonlySet<string>,
  packages: readonly string[],
  changes: Changes,
): Promise<void> {
  const wanted = packages.map((name) => join(root, 'packages', name))
  for (const project of [...projects].sort()) {
    await updateJson(
      project,
      (config) => {
        const refs = referencesOf(config)
        const have = new Set(refs.map((ref) => resolve(dirname(project), ref.path)))
        have.add(dirname(project))
        have.add(packageDir)
        const added = wanted.filter((dir) => !have.has(dir))
        if (added.length === 0) return undefined
        config.references = [
          ...refs,
          ...added.map((dir) => ({ path: posixRelative(dirname(project), dir) })),
        ]
        return `reference ${added.map((dir) => relative(dirname(project), dir)).join(', reference ')}`
      },
      changes,
    )
  }
}

/**
 * Scaffolds the package at `packageDir` under `root`; returns what it changed, one line per file.
 * A package outside the workspace is left alone.
 * @internal
 */
export async function scaffoldPackage(
  root: string,
  packageDir: string,
): Promise<readonly string[]> {
  const dir = posixRelative(root, packageDir)
  if (dir.startsWith('..')) return []
  const changes = new Changes(root)
  const manifestPath = join(packageDir, 'package.json')
  const { value: manifest } = parseJson(manifestPath, await readFile(manifestPath, 'utf8'), false)

  await writeIfMissing(join(packageDir, PACKAGE_CONFIG), CONFIG, changes)
  await writeIfMissing(join(packageDir, 'turbo.json'), json(TURBO), changes)

  // The tests project: `provino` depends on most packages, so the tests cannot sit in the package's
  // own project (a cycle). It references the package's project, `provino` (not itself), the
  // `@provino/*` packages the package depends on, and the shared config's project. Each path is
  // relative to the package's own directory: `../core` under `packages/`, `../../packages/core`
  // under `tooling/`.
  const packages = [
    ...(manifest.name === 'provino' ? [] : ['provino']),
    ...workspacePackages(root, manifest),
  ]
  const referenceTo = (target: string): string => posixRelative(packageDir, join(root, target))
  const references = [
    './tsconfig.json',
    ...packages.map((name) => referenceTo(`packages/${name}`)),
    referenceTo('tooling/provino'),
  ]
  // One path: seed the file when it is missing, then merge into whatever is there.
  const testsConfig = join(packageDir, 'tsconfig.tests.json')
  await writeIfMissing(testsConfig, json({ extends: TESTS_BASE }), changes)
  await updateJson(
    testsConfig,
    (config) => {
      const notes: string[] = []
      if (config.extends !== TESTS_BASE) {
        config.extends = TESTS_BASE
        notes.push(`extends ${TESTS_BASE}`)
      }
      // The base carries these; a copy in the package would only drift.
      const options = { ...record(config.compilerOptions) }
      for (const key of ['rewriteRelativeImportExtensions', 'allowImportingTsExtensions']) {
        if (key in options) {
          delete options[key]
          notes.push(`${key} left to the base`)
        }
      }
      if (Object.keys(options).length === 0) delete config.compilerOptions
      else config.compilerOptions = options
      const include = addMissing(config.include, [SRC_TEST_GLOB, PACKAGE_CONFIG])
      const refs = addMissing(
        referencesOf(config).map((ref) => ref.path),
        references,
        (path) => resolve(packageDir, path),
      )
      config.include = include.list
      config.references = refs.list.map((path) => ({ path }))
      notes.push(...include.added.map((item) => `include ${item}`))
      notes.push(...refs.added.map((item) => `reference ${item}`))
      return notes.length === 0 ? undefined : notes.join(', ')
    },
    changes,
  )

  await updateJson(
    join(packageDir, 'tsconfig.json'),
    (config) => {
      const exclude = addMissing(config.exclude, [SRC_TEST_GLOB])
      if (exclude.added.length === 0) return undefined
      config.exclude = exclude.list
      return `exclude gained ${SRC_TEST_GLOB}`
    },
    changes,
  )
  await updateJson(
    join(root, 'tsconfig.json'),
    (config) => {
      const refs = referencesOf(config)
      const tests = `${dir}/tsconfig.tests.json`
      if (refs.some((ref) => ref.path === tests)) return undefined
      const at = refs.findIndex((ref) => ref.path === dir)
      refs.splice(at < 0 ? refs.length : at + 1, 0, { path: tests })
      config.references = refs
      return `reference to ${tests}`
    },
    changes,
  )
  await updateJson(
    join(packageDir, 'package.json'),
    (config) => {
      const scripts = record(config.scripts)
      const script = testScript(root, dir)
      if (scripts.test === script) return undefined
      config.scripts = { ...scripts, test: script }
      return `test script is now "${script}"`
    },
    changes,
    false,
  )
  // The tests under test/ and bench/: each one's covering project gets the references; the ones no
  // project covers are reported, since creating a tsconfig.json is left to hand.
  const covering = tsconfigFinder(packageDir)
  const projects = new Set<string>()
  const uncovered: string[] = []
  for (const name of TEST_ROOTS.filter((entry) => entry !== 'src')) {
    let count = 0
    for (const file of testFilesUnder(join(packageDir, name))) {
      const project = covering(file)
      if (project === undefined) count++
      else projects.add(project)
    }
    if (count > 0) {
      uncovered.push(
        `${dir}/${name}: ${count} test file(s) and no ${name}/tsconfig.json: no tsconfig covers them (create one by hand; the scaffold then adds its references)`,
      )
    }
  }
  await referenceTestProjects(root, packageDir, projects, packages, changes)
  await changes.commit()
  return [...changes.lines, ...uncovered]
}
