import {
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
import { runCommand } from './exec.ts'
import { type PackedPackage, packAll, pnpm } from './pack.ts'
import { publicPackages } from './workspace.ts'

/** One step of the smoke and what it printed. */
export interface SmokeStep {
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
 * Packs every public package with `pnpm pack`, installs `provino` from its tarball into an empty
 * directory (outside the repository, so none of its pnpm settings apply), and runs
 * `provino --version` and the three-file smoke suite there. The install reaches the registry
 * for `provino`'s own dependencies; it uses no registry copy of Provino. It is the local half of
 * T10.2's install matrix: one cell, run with pnpm.
 * @internal
 */
export function installSmoke(options: {
  readonly root: string
  readonly keep: boolean
  /** Tarballs already packed, to skip the pack (hygiene has them). */
  readonly packed?: readonly PackedPackage[]
}): SmokeResult {
  const work = mkdtempSync(join(tmpdir(), 'provino-smoke-'))
  const steps: SmokeStep[] = []
  const step = (name: string, ok: boolean, output: string): boolean => {
    steps.push({ name, ok, output })
    return ok
  }
  try {
    const packs = options.packed ?? packAll(publicPackages(options.root), join(work, 'tarballs'))
    const provino = packs.find((packed) => packed.name === 'provino')
    if (!step('pack', provino !== undefined, `${packs.length} tarballs`) || provino === undefined) {
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
    const install = run(['add', '--ignore-workspace', '--prefer-offline', provino.tarball])
    if (!step('install', install.status === 0, install.output)) {
      return { steps, ok: false, kept: options.keep ? work : undefined }
    }
    const version = run(['exec', 'provino', '--version'])
    const installed: unknown = JSON.parse(
      readFileSync(join(app, 'node_modules', 'provino', 'package.json'), 'utf8'),
    )
    const expected =
      typeof installed === 'object' && installed !== null && 'version' in installed
        ? String(installed.version)
        : ''
    step(
      'provino --version',
      version.status === 0 && version.output.trim().split('\n').at(-1) === expected,
      version.output,
    )
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
      step(
        'provino --version with no Oxc binding',
        still.status === 0 && still.output.trim().split('\n').at(-1) === expected,
        still.output,
      )
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
  } finally {
    if (!options.keep) rmSync(work, { recursive: true, force: true })
  }
  return { steps, ok: steps.every((entry) => entry.ok), kept: options.keep ? work : undefined }
}
