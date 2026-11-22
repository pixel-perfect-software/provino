import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CommandResult, runCommand } from './exec.ts'
import { packPackage, pnpm } from './pack.ts'
import { readManifest } from './package-json.ts'
import { publicPackages } from './workspace.ts'

/** One step of the smoke and what it printed; a skipped step is `ok` and says why in `output`. */
export interface SmokeStep {
  readonly name: string
  readonly ok: boolean
  readonly output: string
  readonly skipped?: true
}

/**
 * How many tests each smoke suite holds and must pass: the three files of `SMOKE_FILES` (a test
 * each) and the three tests of `NATIVE_SMOKE_FILES`.
 * @internal
 */
export const SMOKE_TESTS = 3

/** The totals line of a run whose `SMOKE_TESTS` tests all passed. */
const ALL_PASSED = new RegExp(`Tests:\\s+${SMOKE_TESTS} passed, ${SMOKE_TESTS} total`)

/**
 * The three test files of the smoke suite: the injected globals in a CommonJS-style file, a
 * test that imports the `provino` entry, and a TypeScript test with an async assertion. A suite
 * like this loads the whole installed worker path: the transform for the `.ts` file, the
 * `provino` entry's late binding, and `expect` from the Jest dialect.
 */
export const SMOKE_FILES: Readonly<Record<string, string>> = {
  'globals.test.js': [
    "describe('globals', () => {",
    "  it('adds', () => {",
    '    expect(1 + 1).toBe(2)',
    '  })',
    '})',
    '',
  ].join('\n'),
  'entry.test.js': [
    "import { describe, expect, it } from 'provino'",
    '',
    "describe('the provino entry', () => {",
    "  it('forwards to the worker', () => {",
    '    expect({ a: [1, 2] }).toEqual({ a: [1, 2] })',
    '  })',
    '})',
    '',
  ].join('\n'),
  'typed.test.ts': [
    "test('a typed async test', async () => {",
    '  const value: number = await Promise.resolve(3)',
    '  expect(value).toBeGreaterThan(2)',
    '})',
    '',
  ].join('\n'),
}

/**
 * The native case's project (B27e): a `provino.config.ts` that names no dialect and a test file
 * that imports the native API from `provino`, three tests. Bare `provino` finds the config.
 */
export const NATIVE_SMOKE_FILES: Readonly<Record<string, string>> = {
  'provino.config.ts': "export default { include: ['**/*.test.ts'] }\n",
  'native.test.ts': [
    "import { describe, expect, fn, it, test } from 'provino'",
    '',
    "describe('native', () => {",
    "  it('adds', () => {",
    '    expect(1 + 1).toBe(2)',
    '  })',
    "  it('records a call', () => {",
    '    const f = fn()',
    "    f('a')",
    "    expect(f.mock.calls).toEqual([['a']])",
    '  })',
    '})',
    '',
    "test('an async test', async () => {",
    '  expect(await Promise.resolve(3)).toBeGreaterThan(2)',
    '})',
    '',
  ].join('\n'),
}

/**
 * Acceptance row 9's names, read from the boundaries manifest's `bannedPackageSets.native` under
 * `root` (`jest-*`, `@jest/*`, `expect`, …; `*` is one path segment), as a test of a package
 * name: a native install holds none. The manifest is the one list, so rows 8 and 9 can't drift
 * from the static ban.
 * @internal
 */
export function nativeBanned(root: string): RegExp {
  const path = join(root, 'tooling', 'boundaries', 'packages.json')
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const sets: unknown =
    typeof parsed === 'object' && parsed !== null
      ? Reflect.get(parsed, 'bannedPackageSets')
      : undefined
  const names: unknown =
    typeof sets === 'object' && sets !== null ? Reflect.get(sets, 'native') : undefined
  if (!Array.isArray(names) || names.length === 0 || !names.every((n) => typeof n === 'string')) {
    throw new Error(`${path}: bannedPackageSets.native is not a list of package names`)
  }
  const alternatives = names.map((name: string) =>
    name
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&'))
      .join('[^/]+'),
  )
  return new RegExp(`^(?:${alternatives.join('|')})$`)
}

/**
 * The banned package names anywhere in a `pnpm ls --depth Infinity --json` tree (an array of
 * projects, each with `dependencies` and `devDependencies` of `{ version, dependencies }`),
 * sorted and once each. Anything that isn't that shape is skipped, not trusted.
 * @internal
 */
export function bannedInTree(tree: unknown, banned: RegExp): readonly string[] {
  const found = new Set<string>()
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const deps: unknown = Reflect.get(node, key)
      if (typeof deps !== 'object' || deps === null) continue
      for (const [name, child] of Object.entries(deps)) {
        if (banned.test(name)) found.add(name)
        walk(child)
      }
    }
  }
  walk(tree)
  return [...found].sort()
}

/**
 * What the skipped native footprint case says: only `installSmoke({ native: false })` skips it
 * since B27f's install split (D187) moved the Jest and Vitest packages into the dialects' add-ons.
 * @internal
 */
export const NATIVE_FOOTPRINT_SKIP: string =
  'skipped: installSmoke was asked not to run the native case (native: false)'

/**
 * Whether `installSmoke` runs the native footprint case when not told: `true` since B27f (D187).
 * @internal
 */
export const NATIVE_FOOTPRINT_DEFAULT: boolean = true

/**
 * The Jest app's pnpm settings: no hoisting at all (`hoist=false`, in both places pnpm reads
 * settings from), the strictest layout, where an add-on is reachable only from the project.
 */
const NO_HOIST: Readonly<Record<string, string>> = {
  '.npmrc': 'hoist=false\n',
  'pnpm-workspace.yaml': 'hoist: false\n',
}

/** A command in an app directory, with pnpm. */
type Run = (args: readonly string[]) => CommandResult

/**
 * A new app `dir` under `work` (a private `type: module` package of that name), `files` written
 * into it, and `tarballs` installed with pnpm in one command, outside any workspace. Returns the app, a runner of
 * pnpm commands in it, and the install's result.
 */
function installApp(
  work: string,
  dir: string,
  files: Readonly<Record<string, string>>,
  tarballs: readonly string[],
): { readonly app: string; readonly run: Run; readonly install: CommandResult } {
  const app = join(work, dir)
  mkdirSync(app, { recursive: true })
  writeFileSync(
    join(app, 'package.json'),
    `${JSON.stringify({ name: `provino-${dir}`, private: true, type: 'module' }, null, 2)}\n`,
  )
  for (const [file, text] of Object.entries(files)) writeFileSync(join(app, file), text)
  const { command, prefix } = pnpm()
  const run: Run = (args) =>
    runCommand(command, [...prefix, ...args], { cwd: app, timeoutMs: 600_000 })
  const install = run(['add', '--ignore-workspace', '--prefer-offline', ...tarballs])
  return { app, run, install }
}

/**
 * The native case (acceptance row 9, run since B27f's install split, D187): in its own empty app,
 * install `provino`'s tarball alone, run bare
 * `provino` on `NATIVE_SMOKE_FILES` (`SMOKE_TESTS` passed), and read `pnpm ls --depth Infinity
 * --json`: no banned name anywhere in the tree.
 */
function nativeFootprint(
  root: string,
  work: string,
  tarball: string,
  step: (name: string, ok: boolean, output: string) => boolean,
): void {
  const { run, install } = installApp(work, 'native-app', NATIVE_SMOKE_FILES, [tarball])
  if (!step('native: install', install.status === 0, install.output)) return
  const suite = run(['exec', 'provino'])
  step(
    `native: bare provino (${SMOKE_TESTS} tests)`,
    suite.status === 0 && ALL_PASSED.test(suite.output),
    suite.output,
  )
  const listed = run(['ls', '--depth', 'Infinity', '--json'])
  const name = 'native: no Jest or Vitest package in the install'
  if (listed.status !== 0) {
    step(name, false, listed.output)
    return
  }
  let banned: readonly string[]
  try {
    // stdout only: pnpm's and Node's warnings go to stderr.
    banned = bannedInTree(JSON.parse(listed.stdout), nativeBanned(root))
  } catch (error) {
    failStep(step, name, error, listed.stdout)
    return
  }
  step(name, banned.length === 0, banned.length === 0 ? 'none' : banned.join('\n'))
}

/** Fails `name` with `error` and the text it was reading. */
function failStep(
  step: (name: string, ok: boolean, output: string) => boolean,
  name: string,
  error: unknown,
  text: string,
): void {
  step(name, false, `${error instanceof Error ? error.message : String(error)}\n${text}`)
}

/** What `installSmoke` took and found. */
export interface SmokeResult {
  readonly steps: readonly SmokeStep[]
  readonly ok: boolean
  /** The directory the smoke ran in, when it was kept. */
  readonly kept: string | undefined
}

/**
 * Moves this install's Oxc binding packages (`@oxc-parser/binding-<platform>` and the transform's
 * and resolver's) out of pnpm's store directory, as if the optional dependencies were never
 * installed. Returns the package names it moved, as `@oxc-parser+binding-<platform>` directory names.
 */
function removeOxcBindings(app: string): readonly string[] {
  const store = join(app, 'node_modules', '.pnpm')
  const moved: string[] = []
  for (const name of readdirSync(store)) {
    const match = /^(@oxc-(?:parser|transform|resolver))\+(binding-[^@]+)@/.exec(name)
    if (match === null) continue
    renameSync(join(store, name), join(store, `_removed_${name}`))
    moved.push(`${match[1]}+${match[2]}`)
  }
  return moved
}

/**
 * The packages the Jest case installs: `provino` (it inlines every engine package) and the Jest
 * dialect's add-on (D187), which `provino jest` needs beside it.
 */
const JEST_INSTALL: readonly string[] = ['provino', '@provino/dialect-jest']

/**
 * Packs `provino` and `@provino/dialect-jest` with `pnpm pack` (`JEST_INSTALL`: the add-on reaches
 * the engine through its `provino` peer, so no other tarball is needed), installs both from their
 * tarballs into an empty directory (outside the repository, so none of its pnpm settings apply), and
 * runs `provino --version` and the three-file smoke suite there, then the native case with
 * `provino` alone. The install reaches the registry for `provino`'s own dependencies; it uses no
 * registry copy of Provino. It is the local half of T10.2's install matrix: one cell, run with
 * pnpm.
 * @internal
 */
export function installSmoke(options: {
  readonly root: string
  readonly keep: boolean
  /** Run the native footprint case (default `NATIVE_FOOTPRINT_DEFAULT`); off, it is a skipped step. */
  readonly native?: boolean
}): SmokeResult {
  const work = mkdtempSync(join(tmpdir(), 'provino-smoke-'))
  const kept = options.keep ? work : undefined
  const steps: SmokeStep[] = []
  const step = (name: string, ok: boolean, output: string): boolean => {
    steps.push({ name, ok, output })
    return ok
  }
  const skip = (name: string, why: string): void => {
    steps.push({ name, ok: true, output: why, skipped: true })
  }
  try {
    const packages = publicPackages(options.root)
    const [provino, dialect] = JEST_INSTALL.map((name) => {
      const pkg = packages.find((candidate) => candidate.manifest.name === name)
      return pkg === undefined ? undefined : packPackage(pkg, join(work, 'tarballs'))
    })
    if (
      !step('pack', provino !== undefined && dialect !== undefined, JEST_INSTALL.join('\n')) ||
      provino === undefined ||
      dialect === undefined
    ) {
      return { steps, ok: false, kept: undefined }
    }
    // `hoist=false`: nothing is hoisted into `node_modules/.pnpm/node_modules`, so `provino`, from its
    // folder in the store, could reach the add-on only by resolving it from the project (D187).
    const { app, run, install } = installApp(work, 'smoke', { ...SMOKE_FILES, ...NO_HOIST }, [
      provino.tarball,
      dialect.tarball,
    ])
    if (!step('install', install.status === 0, install.output)) return { steps, ok: false, kept }
    const hoisted = join(app, 'node_modules', '.pnpm', 'node_modules', '@provino', 'dialect-jest')
    step('install: hoist=false, so no hoisted @provino/dialect-jest', !existsSync(hoisted), hoisted)
    const expected = readManifest(join(app, 'node_modules', 'provino')).version ?? ''
    const printsVersion = (result: CommandResult): boolean =>
      result.status === 0 && result.output.trim().split('\n').at(-1) === expected
    const version = run(['exec', 'provino', '--version'])
    step('provino --version', printsVersion(version), version.output)
    const suite = run(['exec', 'provino', 'jest', '--ci'])
    step(
      `smoke suite (${SMOKE_TESTS} files)`,
      suite.status === 0 && ALL_PASSED.test(suite.output),
      suite.output,
    )
    if (suite.status === 0) {
      // T10.3, Provino's half: take this platform's Oxc binding packages out of the install (what
      // `npm i --omit=optional` or a stale lockfile leaves). --version and --help still answer, and
      // a run ends as one message naming the packages, with no stack.
      const removed = removeOxcBindings(app)
      step('Oxc bindings removed from the install', removed.length === 3, removed.join('\n'))
      const still = run(['exec', 'provino', '--version'])
      step('provino --version with no Oxc binding', printsVersion(still), still.output)
      const failed = run(['exec', 'provino', 'jest', '--ci'])
      step(
        'provino jest with no Oxc binding: one message, exit 1, no stack',
        failed.status !== 0 &&
          removed.every((name) => failed.output.includes(name.replace('+', '/'))) &&
          !/\n\s+at |Cannot find native binding/.test(
            failed.output.replace(/^ERR_PNPM.*\n?/gm, ''),
          ),
        failed.output,
      )
    }
    // The native case (B27e, acceptance row 9): on by default since B27f's install split.
    if (options.native ?? NATIVE_FOOTPRINT_DEFAULT) {
      nativeFootprint(options.root, work, provino.tarball, step)
    } else {
      skip('native: install footprint', NATIVE_FOOTPRINT_SKIP)
    }
  } finally {
    if (!options.keep) rmSync(work, { recursive: true, force: true })
  }
  return { steps, ok: steps.every((entry) => entry.ok), kept }
}
