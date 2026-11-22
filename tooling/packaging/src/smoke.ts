import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CommandResult, runCommand } from './exec.ts'
import { packPackage, pnpm } from './pack.ts'
import { readManifest } from './package-json.ts'
import { publicPackages } from './workspace.ts'

/** One step of the smoke and what it printed. */
interface SmokeStep {
  readonly name: string
  readonly ok: boolean
  readonly output: string
}

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
 * Acceptance row 9's names (the boundaries manifest's `native` set): a native install holds none.
 * @internal
 */
export const NATIVE_BANNED: RegExp =
  /^(?:jest-.+|@jest\/.+|expect|pretty-format|chai|@vitest\/.+|vite|@babel\/.+)$/

/**
 * The banned package names anywhere in a `pnpm ls --depth Infinity --json` tree (an array of
 * projects, each with `dependencies` and `devDependencies` of `{ version, dependencies }`),
 * sorted and once each. Anything that isn't that shape is skipped, not trusted.
 * @internal
 */
export function bannedInTree(tree: unknown): readonly string[] {
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
        if (NATIVE_BANNED.test(name)) found.add(name)
        walk(child)
      }
    }
  }
  walk(tree)
  return [...found].sort()
}

/**
 * The native case (acceptance row 9, enabled by B27f's install split, D187): in its own empty app,
 * install `provino`'s tarball alone, run bare
 * `provino` on `NATIVE_SMOKE_FILES` (`Tests: 3 passed`), and read `pnpm ls --depth Infinity
 * --json`: no banned name anywhere in the tree.
 */
function nativeFootprint(
  work: string,
  tarball: string,
  step: (name: string, ok: boolean, output: string) => boolean,
): void {
  const app = join(work, 'native-app')
  mkdirSync(app, { recursive: true })
  writeFileSync(
    join(app, 'package.json'),
    `${JSON.stringify({ name: 'provino-native-smoke', private: true, type: 'module' }, null, 2)}\n`,
  )
  for (const [file, text] of Object.entries(NATIVE_SMOKE_FILES))
    writeFileSync(join(app, file), text)
  const { command, prefix } = pnpm()
  const run = (args: readonly string[]) =>
    runCommand(command, [...prefix, ...args], { cwd: app, timeoutMs: 600_000 })
  const install = run(['add', '--ignore-workspace', '--prefer-offline', tarball])
  if (!step('native: install', install.status === 0, install.output)) return
  const suite = run(['exec', 'provino'])
  step(
    'native: bare provino (3 tests)',
    suite.status === 0 && /Tests:\s+3 passed, 3 total/.test(suite.output),
    suite.output,
  )
  const listed = run(['ls', '--depth', 'Infinity', '--json'])
  let banned: readonly string[] = ['(pnpm ls printed no JSON)']
  try {
    banned = bannedInTree(JSON.parse(listed.output.slice(listed.output.indexOf('['))))
  } catch {
    // The placeholder above stands: the step fails with the output.
  }
  step(
    'native: no Jest or Vitest package in the install',
    listed.status === 0 && banned.length === 0,
    banned.length === 0 ? 'none' : banned.join('\n'),
  )
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
}): SmokeResult {
  const work = mkdtempSync(join(tmpdir(), 'provino-smoke-'))
  const kept = options.keep ? work : undefined
  const steps: SmokeStep[] = []
  const step = (name: string, ok: boolean, output: string): boolean => {
    steps.push({ name, ok, output })
    return ok
  }
  try {
    const packages = publicPackages(options.root)
    const tarballs = JEST_INSTALL.map((name) => {
      const pkg = packages.find((candidate) => candidate.manifest.name === name)
      return pkg === undefined ? undefined : packPackage(pkg, join(work, 'tarballs'))
    })
    const [provino, dialect] = tarballs
    if (
      !step('pack', provino !== undefined && dialect !== undefined, JEST_INSTALL.join('\n')) ||
      provino === undefined ||
      dialect === undefined
    ) {
      return { steps, ok: false, kept: undefined }
    }
    const app = join(work, 'app')
    mkdirSync(app, { recursive: true })
    writeFileSync(
      join(app, 'package.json'),
      `${JSON.stringify({ name: 'provino-smoke', private: true, type: 'module' }, null, 2)}\n`,
    )
    for (const [file, text] of Object.entries(SMOKE_FILES)) writeFileSync(join(app, file), text)

    const { command, prefix } = pnpm()
    const run = (args: readonly string[]) =>
      runCommand(command, [...prefix, ...args], { cwd: app, timeoutMs: 600_000 })
    const install = run([
      'add',
      '--ignore-workspace',
      '--prefer-offline',
      provino.tarball,
      dialect.tarball,
    ])
    if (!step('install', install.status === 0, install.output)) return { steps, ok: false, kept }
    const expected = readManifest(join(app, 'node_modules', 'provino')).version ?? ''
    const printsVersion = (result: CommandResult): boolean =>
      result.status === 0 && result.output.trim().split('\n').at(-1) === expected
    const version = run(['exec', 'provino', '--version'])
    step('provino --version', printsVersion(version), version.output)
    const suite = run(['exec', 'provino', 'jest', '--ci'])
    step(
      'smoke suite (3 files)',
      suite.status === 0 && /Tests:\s+3 passed, 3 total/.test(suite.output),
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
    // The native case (B27e, acceptance row 9): `provino` alone, since B27f's install split.
    nativeFootprint(work, provino.tarball, step)
  } finally {
    if (!options.keep) rmSync(work, { recursive: true, force: true })
  }
  return { steps, ok: steps.every((entry) => entry.ok), kept }
}
