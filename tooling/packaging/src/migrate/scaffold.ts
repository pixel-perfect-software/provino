// What a package needs, beside its rewritten test files, to run them on Provino (B27g2, D203):
// the config, the tests' tsconfig project (its `src` tests and its `provino.config.ts`), its
// turbo.json, the tsconfig exclude and the root reference, and the `test` script. Idempotent: it
// writes what is missing, adds what an existing file lacks (never removing a line), and sets the
// script, so running `rewrite` again after editing `bootstrap.json` refreshes the script. Left to
// hand: the bootstrap entries themselves, and a `test/` directory's own tsconfig (a reference to
// `../../provino` when its tests import `provino`).
import { existsSync, readdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { SRC_TEST_GLOB, TEST_ROOTS, testScript } from '../dogfood.ts'
import { MigrateError } from './errors.ts'

const CONFIG = `import type { ProvinoConfig } from 'provino/config'
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

async function readJson(path: string): Promise<Json> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Json
  } catch (cause) {
    throw new MigrateError(
      'MIGRATE_WRITE',
      `cannot read ${path} as JSON (comments in it? edit by hand)`,
      { cause },
    )
  }
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** What the scaffold did, as `<path>: <what>` lines, for the command to print. */
class Changes {
  readonly lines: string[] = []
  readonly root: string
  constructor(root: string) {
    this.root = root
  }
  add(path: string, what: string): void {
    this.lines.push(`${relative(this.root, path)}: ${what}`)
  }
}

async function writeIfMissing(path: string, text: string, changes: Changes): Promise<void> {
  if (existsSync(path)) return
  await writeFile(path, text)
  changes.add(path, 'written')
}

/** Reads `path`, applies `change` (which returns what it changed, or nothing), writes on a change. */
async function updateJson(
  path: string,
  change: (value: Json) => string | undefined,
  changes: Changes,
): Promise<void> {
  const value = await readJson(path)
  const what = change(value)
  if (what === undefined) return
  await writeFile(path, json(value))
  changes.add(path, what)
}

/** Adds each of `wanted` that `list` lacks; returns the ones added. */
function addMissing(list: unknown, wanted: readonly string[]): { list: string[]; added: string[] } {
  const current = Array.isArray(list) ? (list as string[]) : []
  const added = wanted.filter((item) => !current.includes(item))
  return { list: [...current, ...added], added }
}

/** The `@provino/*` workspace packages `manifest` depends on, as `../<dir>` references. */
function workspaceReferences(root: string, manifest: Json): string[] {
  const names = ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((key) =>
    Object.keys((manifest[key] ?? {}) as Record<string, string>),
  )
  return [...new Set(names)]
    .filter((name) => name.startsWith('@provino/'))
    .map((name) => name.slice('@provino/'.length))
    .filter((dir) => existsSync(join(root, 'packages', dir)))
    .map((dir) => `../${dir}`)
    .sort()
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
  const dir = relative(root, packageDir).split('\\').join('/')
  if (dir.startsWith('..')) return []
  const changes = new Changes(root)
  const manifest = await readJson(join(packageDir, 'package.json'))

  await writeIfMissing(join(packageDir, 'provino.config.ts'), CONFIG, changes)
  await writeIfMissing(join(packageDir, 'turbo.json'), json(TURBO), changes)

  // The tests project: `provino` depends on most packages, so the tests cannot sit in the package's
  // own project (a cycle). It references the package's project, `provino` (not itself), the
  // `@provino/*` packages the package depends on, and the shared config's project.
  const self = manifest.name === 'provino'
  const references = [
    './tsconfig.json',
    ...(self ? [] : ['../provino']),
    ...workspaceReferences(root, manifest),
    '../../tooling/provino',
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
      const options = { ...((config.compilerOptions ?? {}) as Json) }
      for (const key of ['rewriteRelativeImportExtensions', 'allowImportingTsExtensions']) {
        if (key in options) {
          delete options[key]
          notes.push(`${key} left to the base`)
        }
      }
      if (Object.keys(options).length === 0) delete config.compilerOptions
      else config.compilerOptions = options
      const include = addMissing(config.include, [SRC_TEST_GLOB, 'provino.config.ts'])
      const current = ((config.references ?? []) as { path: string }[]).map((ref) => ref.path)
      const refs = addMissing(current, references)
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
      const refs = (config.references ?? []) as { path: string }[]
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
      const scripts = (config.scripts ?? {}) as Record<string, string>
      const script = testScript(root, dir)
      if (scripts.test === script) return undefined
      config.scripts = { ...scripts, test: script }
      return `test script is now "${script}"`
    },
    changes,
  )
  // Tests under test/ or bench/ are in no project of this scaffold's making: say which are in none.
  for (const root of TEST_ROOTS.filter((name) => name !== 'src')) {
    const covered = existsSync(join(packageDir, root, 'tsconfig.json'))
    const count = existsSync(join(packageDir, root)) ? testFilesUnder(join(packageDir, root)) : 0
    if (count > 0 && !covered) {
      changes.lines.push(
        `${dir}/${root}: ${count} test file(s) and no ${root}/tsconfig.json: no tsconfig covers them (add a project that references ../../provino, by hand)`,
      )
    }
  }
  return changes.lines
}

/** How many `*.test.ts` files sit under `directory` (not in node_modules). */
function testFilesUnder(directory: string): number {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' }).filter(
    (entry) => entry.endsWith('.test.ts') && !entry.split(/[\\/]/).includes('node_modules'),
  ).length
}
