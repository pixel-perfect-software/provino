import { type Dirent, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BenchSubject } from '@provino/types'
import { BenchError } from './errors.ts'
import { APP_MAX_FILES, APP_TESTS_PER_FILE, appFiles } from './generators/app.ts'
import {
  ISOLATE_HEAVY_FILES,
  ISOLATE_HEAVY_TESTS_PER_FILE,
  isolateHeavyFiles,
} from './generators/isolate-heavy.ts'
import {
  MOCK_HEAVY_MAX_FILES,
  MOCK_HEAVY_TESTS_PER_FILE,
  mockHeavyFiles,
} from './generators/mock-heavy.ts'
import { FLAVOUR_DIR, FLAVOURS, type Flavour, type GeneratedFile } from './generators/render.ts'
import type { BenchSubjectSpec, CacheDir } from './run-bench.ts'

/**
 * The bench package's directory.
 * @public
 */
export const PACKAGE_DIR: string = fileURLToPath(new URL('..', import.meta.url))

/**
 * The repository root.
 * @public
 */
export const REPO_ROOT: string = fileURLToPath(new URL('../../..', import.meta.url))

/**
 * Where suites are generated (gitignored).
 * @public
 */
export const SUITES_DIR: string = join(PACKAGE_DIR, '.suites')

/**
 * Where bench records are written by default (gitignored).
 * @public
 */
export const RESULTS_DIR: string = join(PACKAGE_DIR, '.results')

/**
 * The shapes of synthetic suite.
 * @public
 */
export type SuiteKind = 'app' | 'mock-heavy' | 'isolate-heavy'

/**
 * A parsed suite name and what it generates.
 * @public
 */
export interface SuiteSpec {
  /** The name as typed, e.g. `app-500`. */
  readonly name: string
  readonly kind: SuiteKind
  readonly files: number
  readonly testsPerFile: number
}

/**
 * Parses `app-N`, `mock-heavy-N` (N from 1 up to 9999) or `isolate-heavy`.
 * @public
 */
export function parseSuiteName(name: string): SuiteSpec {
  if (name === 'isolate-heavy') {
    return {
      name,
      kind: 'isolate-heavy',
      files: ISOLATE_HEAVY_FILES,
      testsPerFile: ISOLATE_HEAVY_TESTS_PER_FILE,
    }
  }
  const match = /^(app|mock-heavy)-([1-9]\d*)$/.exec(name)
  const kind = match?.[1]
  const files = Number(match?.[2])
  if (kind === 'app' && files <= APP_MAX_FILES) {
    return { name, kind, files, testsPerFile: APP_TESTS_PER_FILE }
  }
  if (kind === 'mock-heavy' && files <= MOCK_HEAVY_MAX_FILES) {
    return { name, kind, files, testsPerFile: MOCK_HEAVY_TESTS_PER_FILE }
  }
  throw new BenchError(
    'BENCH_UNKNOWN_SUITE',
    `unknown suite ${JSON.stringify(name)}; expected app-N, mock-heavy-N (N 1 to 9999) or isolate-heavy`,
  )
}

/**
 * How many tests a suite holds, which every runner must report.
 * @public
 */
export function expectedTests(spec: SuiteSpec): number {
  return spec.files * spec.testsPerFile
}

/**
 * Every file of a suite, both flavour trees, as pure data.
 * @public
 */
export function buildSuite(spec: SuiteSpec): readonly GeneratedFile[] {
  return FLAVOURS.flatMap((flavour) => flavourFiles(spec, flavour))
}

function flavourFiles(spec: SuiteSpec, flavour: Flavour): readonly GeneratedFile[] {
  switch (spec.kind) {
    case 'app':
      return appFiles(spec.name, spec.files, flavour)
    case 'mock-heavy':
      return mockHeavyFiles(spec.name, spec.files, flavour)
    case 'isolate-heavy':
      return isolateHeavyFiles(spec.name, flavour)
  }
}

/**
 * The directory of a suite.
 * @public
 */
export function suiteDir(spec: SuiteSpec, root: string = SUITES_DIR): string {
  return join(root, spec.name)
}

/**
 * What `writeSuite` did.
 * @public
 */
export interface WriteSummary {
  readonly dir: string
  readonly written: number
  readonly unchanged: number
  readonly removed: number
}

async function listFiles(dir: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

async function inBatches<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  const size = 64
  for (let start = 0; start < items.length; start += size) {
    await Promise.all(items.slice(start, start + size).map(work))
  }
}

/**
 * Generates a suite into `<root>/<name>/`, idempotently: files with the right bytes are left
 * alone (so their mtimes and the runners' caches stay valid), changed files are rewritten, and
 * stale files in the `jest/` and `vitest/` trees are removed. `.cache/` and everything else in
 * the suite directory is untouched.
 * @public
 */
export async function writeSuite(
  spec: SuiteSpec,
  options?: { readonly root?: string },
): Promise<WriteSummary> {
  const dir = suiteDir(spec, options?.root)
  const files = buildSuite(spec)
  const wanted = new Set<string>()
  for (const file of files) {
    if (isAbsolute(file.path) || normalize(file.path).startsWith('..')) {
      throw new RangeError(`generated path escapes the suite: ${file.path}`)
    }
    wanted.add(join(dir, file.path))
  }

  let removed = 0
  for (const flavour of FLAVOURS) {
    for (const existing of await listFiles(join(dir, FLAVOUR_DIR[flavour]))) {
      if (wanted.has(existing)) continue
      await rm(existing, { force: true })
      removed += 1
    }
  }

  let written = 0
  let unchanged = 0
  await inBatches(files, async (file) => {
    const target = join(dir, file.path)
    const bytes = Buffer.from(file.contents, 'utf8')
    try {
      if ((await readFile(target)).equals(bytes)) {
        unchanged += 1
        return
      }
    } catch {
      // not there yet
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
    written += 1
  })
  return { dir, written, unchanged, removed }
}

/**
 * The runners a suite can be benchmarked under.
 * @public
 */
export type RunnerName = 'jest' | 'vitest'

/**
 * The runners, in the order a bench lists them.
 * @public
 */
export const RUNNERS: readonly RunnerName[] = ['jest', 'vitest']

/**
 * A runner package resolved from this package: its version and its bin script. The bin is a real
 * file, resolved with `createRequire`, never a `.bin` shim.
 * @public
 */
export interface RunnerPackage {
  readonly version: string
  /** Absolute path of the bin script. */
  readonly bin: string
  /** The bin's path inside the package, e.g. `bin/jest.js`. */
  readonly binInPackage: string
}

function binField(value: unknown, runner: string): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const entry = (value as Record<string, unknown>)[runner]
    return typeof entry === 'string' ? entry : undefined
  }
  return undefined
}

/**
 * Finds a runner's package among this package's dependencies.
 * @public
 */
export function runnerPackage(runner: RunnerName): RunnerPackage {
  const require = createRequire(import.meta.url)
  let manifestPath: string
  let manifest: unknown
  try {
    manifestPath = require.resolve(`${runner}/package.json`)
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (cause) {
    throw new BenchError(
      'BENCH_RUNNER_NOT_FOUND',
      `${runner} is not installed for @provino/bench`,
      {
        cause,
      },
    )
  }
  const fields =
    typeof manifest === 'object' && manifest !== null ? (manifest as Record<string, unknown>) : {}
  const version = fields.version
  const binInPackage = binField(fields.bin, runner)
  if (typeof version !== 'string' || binInPackage === undefined) {
    throw new BenchError('BENCH_RUNNER_NOT_FOUND', `${runner}'s package.json has no version or bin`)
  }
  return {
    version,
    bin: join(dirname(manifestPath), binInPackage),
    binInPackage: normalize(binInPackage),
  }
}

/**
 * How to run one runner on a suite: the command, where, with what environment, and which caches
 * a cold run deletes.
 * @public
 */
export interface RunnerPlan {
  readonly runner: RunnerName
  readonly version: string
  readonly cwd: string
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly caches: readonly CacheDir[]
  /** The reproducible command, run from the repository root. */
  readonly command: string
  /** The runner's config file, relative to the repository root. */
  readonly configPath: string
}

/**
 * Plans a runner on a suite. Jest runs `--ci` with its config in `jest/`; Vitest runs `run` with
 * its config in `vitest/` at its default isolation. `NODE_COMPILE_CACHE` points at
 * `<suite>/.cache/node-<runner>` so a cold run can delete it. `extraArgs` go last (the check uses
 * them for JSON output).
 * @public
 */
export function planRunner(
  spec: SuiteSpec,
  runner: RunnerName,
  options?: { readonly root?: string; readonly extraArgs?: readonly string[] },
): RunnerPlan {
  const root = suiteDir(spec, options?.root)
  const pkg = runnerPackage(runner)
  const flavour = runner === 'jest' ? 'jest' : 'vitest'
  const cwd = join(root, flavour)
  const config = runner === 'jest' ? 'jest.config.json' : 'vitest.config.ts'
  const runnerArgs = runner === 'jest' ? ['--ci', '--config', config] : ['run', '--config', config]
  const args = [...runnerArgs, ...(options?.extraArgs ?? [])]
  const compileCache = join(root, '.cache', `node-${runner}`)
  const toolCache = join(root, '.cache', runner === 'jest' ? 'jest' : 'vite')

  const shownBin = relative(cwd, join(PACKAGE_DIR, 'node_modules', runner, pkg.binInPackage))
  const command = [
    `cd ${relative(REPO_ROOT, cwd)} &&`,
    `NODE_COMPILE_CACHE=${relative(cwd, compileCache)}`,
    'node',
    shownBin,
    ...args,
  ].join(' ')

  return {
    runner,
    version: pkg.version,
    cwd,
    argv: [process.execPath, pkg.bin, ...args],
    env: { NODE_COMPILE_CACHE: compileCache },
    caches: [
      { kind: runner === 'jest' ? 'jest' : 'vite', path: toolCache },
      { kind: 'node-compile', path: compileCache },
    ],
    command,
    configPath: relative(REPO_ROOT, join(cwd, config)),
  }
}

/**
 * The bench subject and run spec for a planned runner. Both runners are measured at their
 * defaults, so isolation is `runner-default`.
 * @public
 */
export function toSubjectSpec(plan: RunnerPlan): BenchSubjectSpec {
  const subject: BenchSubject = {
    runner: plan.runner,
    version: plan.version,
    isolation: 'runner-default',
    command: plan.command,
    configPath: plan.configPath,
  }
  return { subject, argv: plan.argv, cwd: plan.cwd, env: plan.env, caches: plan.caches }
}
