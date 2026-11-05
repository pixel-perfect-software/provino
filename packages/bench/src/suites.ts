import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type RunnerPackage, resolveRunnerPackage } from '@provino/harness'
import type { BenchSubject, IsolationMode } from '@provino/types'
import { BenchError } from './errors.ts'
import { APP_TESTS_PER_FILE, appFiles } from './generators/app.ts'
import {
  bigRecords,
  ISOLATE_HEAVY_FILES,
  ISOLATE_HEAVY_TESTS_PER_FILE,
  isolateHeavyFiles,
} from './generators/isolate-heavy.ts'
import { MOCK_HEAVY_TESTS_PER_FILE, mockHeavyFiles } from './generators/mock-heavy.ts'
import { FLAVOUR_DIR, FLAVOURS, type GeneratedFile, MAX_SUITE_FILES } from './generators/render.ts'
import type { BenchSubjectSpec, CacheDir, CacheKind } from './run-bench.ts'

/**
 * The bench package's directory.
 * @public
 */
export const PACKAGE_DIR: string = fileURLToPath(new URL('..', import.meta.url))

/**
 * The repository root.
 */
const REPO_ROOT: string = fileURLToPath(new URL('../../..', import.meta.url))

/**
 * Where suites are generated (gitignored).
 */
const SUITES_DIR: string = join(PACKAGE_DIR, '.suites')

/**
 * Where bench records are written by default (gitignored).
 * @public
 */
export const RESULTS_DIR: string = join(PACKAGE_DIR, '.results')

/**
 * Where the bench reads and writes: the repository (for the commit and the reproducible commands),
 * where suites are generated, and where records go.
 * @public
 */
export interface BenchPaths {
  readonly repoRoot: string
  readonly suitesRoot: string
  readonly resultsDir: string
}

/**
 * The real locations: this repository, `.suites/` and `.results/` in the bench package.
 * @public
 */
export const DEFAULT_PATHS: BenchPaths = {
  repoRoot: REPO_ROOT,
  suitesRoot: SUITES_DIR,
  resultsDir: RESULTS_DIR,
}

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
 * Parses `app-N`, `mock-heavy-N` (N from 1 up to `MAX_SUITE_FILES`) or `isolate-heavy`.
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
  if (kind === 'app' && files <= MAX_SUITE_FILES) {
    return { name, kind, files, testsPerFile: APP_TESTS_PER_FILE }
  }
  if (kind === 'mock-heavy' && files <= MAX_SUITE_FILES) {
    return { name, kind, files, testsPerFile: MOCK_HEAVY_TESTS_PER_FILE }
  }
  throw new BenchError(
    'BENCH_UNKNOWN_SUITE',
    `unknown suite ${JSON.stringify(name)}; expected app-N, mock-heavy-N (N 1 to ${MAX_SUITE_FILES}) or isolate-heavy`,
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
  switch (spec.kind) {
    case 'app':
      return FLAVOURS.flatMap((flavour) => appFiles(spec.name, spec.files, flavour))
    case 'mock-heavy':
      return FLAVOURS.flatMap((flavour) => mockHeavyFiles(spec.name, spec.files, flavour))
    case 'isolate-heavy': {
      const records = bigRecords()
      return FLAVOURS.flatMap((flavour) => isolateHeavyFiles(spec.name, flavour, records))
    }
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
export async function writeSuite(spec: SuiteSpec, root?: string): Promise<WriteSummary> {
  const dir = suiteDir(spec, root)
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
 * The runners a suite can be checked and benchmarked under. `provino` is the `provino` bin, run on
 * the suite's `jest/` tree.
 * @public
 */
export type RunnerName = 'jest' | 'vitest' | 'provino'

/**
 * The runners, in the order a bench lists them.
 * @public
 */
export const RUNNERS: readonly RunnerName[] = ['jest', 'vitest', 'provino']

/**
 * The isolation tiers Provino can be planned at: the two the kill-check compares (R6).
 * @public
 */
export type ProvinoIsolation = 'registry' | 'none'

/**
 * How each runner is started: the tree under the suite it runs in, the Node arguments before its
 * bin, its config file, the arguments before `--config <config>`, and the kind of its own cache
 * directory (`cacheDir`, relative to the suite). Provino runs the Jest tree with the Jest dialect,
 * from source (`provino-source`), and keeps its results cache under that tree's `node_modules`.
 */
const RUNNER_SETUP: Readonly<
  Record<
    RunnerName,
    {
      /** The tree it runs in under the suite; the runner's own name when left out. */
      readonly tree?: string
      readonly nodeArgs: readonly string[]
      readonly config: string
      readonly args: readonly string[]
      readonly cacheKind: CacheKind
      /** Relative to the suite; `.cache/<cacheKind>` when left out. */
      readonly cacheDir?: string
    }
  >
> = {
  jest: {
    nodeArgs: [],
    config: 'jest.config.json',
    args: ['--ci'],
    cacheKind: 'jest',
  },
  vitest: {
    nodeArgs: [],
    config: 'vitest.config.ts',
    args: ['run'],
    cacheKind: 'vite',
  },
  provino: {
    tree: 'jest',
    nodeArgs: ['--conditions=provino-source'],
    config: 'provino.config.mjs',
    args: ['run'],
    cacheKind: 'provino',
    cacheDir: 'jest/node_modules/.cache/provino',
  },
}

function installedPackage(runner: RunnerName): RunnerPackage {
  try {
    return resolveRunnerPackage(runner, import.meta.url)
  } catch (cause) {
    throw new BenchError(
      'BENCH_RUNNER_NOT_FOUND',
      `${runner} is not installed for @provino/bench`,
      { cause },
    )
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
  /** Provino's isolation tier; `runner-default` for Jest and Vitest, which run at their defaults. */
  readonly isolation: IsolationMode
}

/**
 * Plans a runner on a suite. Jest runs `--ci` with its config in `jest/`; Vitest runs `run` with
 * its config in `vitest/` at its default isolation; Provino runs `provino run` (its bin, from
 * source) with its config in `jest/`, next to Jest's. `NODE_COMPILE_CACHE` points at
 * `<suite>/.cache/node-<runner>` so a cold run can delete it. `extraArgs` go last (the check uses
 * them for the report output). The runner's package is the one installed for this package; without
 * it, `BENCH_RUNNER_NOT_FOUND`.
 *
 * `options.isolation` is Provino's tier: it picks the config file (`provino.config.mjs` for
 * `registry`, the default, or `provino.none.config.mjs`). Jest and Vitest ignore it and run at their
 * defaults (`runner-default`).
 *
 * Both Provino tiers share one tree and one set of cache directories. That is safe: a cold run
 * deletes them right before its own run, and Provino's results cache only orders the next run's
 * files (it never skips one), so a run of the other tier can't change what a run measures.
 * @public
 */
export function planRunner(
  spec: SuiteSpec,
  runner: RunnerName,
  options?: {
    readonly paths?: BenchPaths
    readonly extraArgs?: readonly string[]
    readonly isolation?: ProvinoIsolation
  },
): RunnerPlan {
  const { repoRoot, suitesRoot } = options?.paths ?? DEFAULT_PATHS
  const { nodeArgs, args: leading, cacheKind } = RUNNER_SETUP[runner]
  const isolation: IsolationMode =
    runner === 'provino' ? (options?.isolation ?? 'registry') : 'runner-default'
  const config =
    runner === 'provino' && isolation === 'none'
      ? 'provino.none.config.mjs'
      : RUNNER_SETUP[runner].config
  const { tree = runner, cacheDir = join('.cache', cacheKind) } = RUNNER_SETUP[runner]
  const root = suiteDir(spec, suitesRoot)
  const pkg = installedPackage(runner)
  const cwd = join(root, tree)
  const args = [...leading, '--config', config, ...(options?.extraArgs ?? [])]
  const compileCache = join(root, '.cache', `node-${runner}`)
  const toolCache = join(root, cacheDir)

  const shownBin = relative(cwd, join(PACKAGE_DIR, 'node_modules', runner, pkg.binInPackage))
  const command = [
    `cd ${relative(repoRoot, cwd)} &&`,
    `NODE_COMPILE_CACHE=${relative(cwd, compileCache)}`,
    'node',
    ...nodeArgs,
    shownBin,
    ...args,
  ].join(' ')

  return {
    runner,
    version: pkg.version,
    cwd,
    argv: [process.execPath, ...nodeArgs, pkg.bin, ...args],
    env: { NODE_COMPILE_CACHE: compileCache },
    caches: [
      { kind: cacheKind, path: toolCache },
      { kind: 'node-compile', path: compileCache },
    ],
    command,
    configPath: relative(repoRoot, join(cwd, config)),
    isolation,
  }
}

/**
 * The bench subject and run spec for a planned runner. Jest and Vitest are measured at their
 * defaults (`runner-default`); Provino is `provino:jest` (the Jest dialect) at the plan's tier.
 * @public
 */
export function toSubjectSpec(plan: RunnerPlan): BenchSubjectSpec {
  const subject: BenchSubject = {
    runner: plan.runner === 'provino' ? 'provino:jest' : plan.runner,
    version: plan.version,
    isolation: plan.isolation,
    command: plan.command,
    configPath: plan.configPath,
  }
  return { subject, argv: plan.argv, cwd: plan.cwd, env: plan.env, caches: plan.caches }
}
