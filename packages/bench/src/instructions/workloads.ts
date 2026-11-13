// The legs' workloads, run by `child.ts` in a process of their own: under cachegrind for the
// instruction count, and natively for the wall-time signal. Every input is written beforehand by
// `prepare.ts` into the work directory, so a workload only reads and runs. This module and what it
// imports must not reach `@provino/harness`: the child runs Provino's built packages (no
// `provino-source` condition), and the harness, a private package, has no build.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { jestHoistPolicy } from '@provino/dialect-jest'
import { createResolver } from '@provino/resolver'
import { createPipeline, hoistMocks } from '@provino/transform'
import type { ModuleTransformer, ResolveKind, Resolver } from '@provino/types'
import { CORE_TESTS, runCorePass } from '../core/workload.ts'
import { APP_TESTS_PER_FILE } from '../generators/app.ts'
import { ISOLATE_HEAVY_FILES, ISOLATE_HEAVY_TESTS_PER_FILE } from '../generators/isolate-heavy.ts'
import { MOCK_HEAVY_TESTS_PER_FILE } from '../generators/mock-heavy.ts'
import { generateTestFile } from '../hoist/generate.ts'
import { TARGET_BYTES as HOIST_BYTES, SEED as HOIST_SEED } from '../hoist/report.ts'
import { FIXTURE_FILES, TESTS_PER_FILE } from '../loader/fixture.ts'
import { createFixtureLoader, runFixture } from '../loader/run.ts'
import { meetsBar, runWorkerFiles } from '../worker/run.ts'
import type { LegId } from './legs.ts'

/**
 * What one workload did.
 * @public
 */
export interface WorkloadResult {
  /** Whether it did all its work correctly (every test passed, every file transformed, …). */
  readonly ok: boolean
  /** Wall time of the work itself, ms (`local`); not the process's start-up. */
  readonly ms: number
  /** Files, tests, calls or requests: what the per-unit signal divides by. */
  readonly units: number
  /** What went wrong, or a short note. */
  readonly detail: string
}

/**
 * Where `prepare.ts` writes each input, under the work directory.
 * @public
 */
export const WORK_PATHS = {
  /** `<suite>/jest/` for each guarded suite. */
  suites: 'suites',
  loaderFixture: 'loader-fixture',
  tsCorpus: 'ts-corpus',
  /** The TS corpus's imports, one `{ importer, specifier, kind }` per line of a JSON array. */
  requests: 'ts-corpus-requests.json',
  /** The transform cache `warm` reads; filled by the `warm-fill` step. */
  transformCache: 'ts-corpus-cache',
} as const

/** The tests each suite holds, for the bar the worker check uses. */
const SUITE_TESTS: Readonly<Record<'app-50' | 'mock-heavy-50' | 'isolate-heavy', number>> = {
  'app-50': 50 * APP_TESTS_PER_FILE,
  'mock-heavy-50': 50 * MOCK_HEAVY_TESTS_PER_FILE,
  'isolate-heavy': ISOLATE_HEAVY_FILES * ISOLATE_HEAVY_TESTS_PER_FILE,
}

/** Hoisting calls the `hoist` leg makes. */
export const HOIST_CALLS = 60

function sortedFiles(dir: string, suffix: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .sort()
    .map((name) => join(dir, name))
}

async function suiteLeg(
  work: string,
  name: 'app-50' | 'mock-heavy-50' | 'isolate-heavy',
): Promise<WorkloadResult> {
  const rootDir = join(work, WORK_PATHS.suites, name, 'jest')
  const files = sortedFiles(join(rootDir, 'tests'), '.test.js')
  const result = await runWorkerFiles({
    rootDir,
    files,
    setupFilesAfterEnv: [join(rootDir, 'setup.js')],
    pool: 'inline',
    isolation: 'registry',
  })
  const expected = SUITE_TESTS[name]
  const ok = meetsBar(result, expected)
  return {
    ok,
    ms: result.elapsedMs,
    units: files.length,
    detail: ok
      ? `${result.passed}/${expected} tests passed`
      : `${result.passed}/${expected} passed, ${result.failed} failed: ${result.failures.slice(0, 3).join('; ')}`,
  }
}

async function loaderLeg(work: string): Promise<WorkloadResult> {
  const dir = join(work, WORK_PATHS.loaderFixture)
  const files = sortedFiles(join(dir, 'tests'), '.test.ts')
  const result = await runFixture(createFixtureLoader(dir), files, 'registry')
  const expected = FIXTURE_FILES * TESTS_PER_FILE
  const ok = files.length === FIXTURE_FILES && result.passed === expected && result.violations === 0
  return {
    ok,
    ms: result.elapsedMs,
    units: files.length,
    detail: `${result.passed}/${expected} passed, ${result.violations} isolation violations${ok ? '' : `: ${result.failures.slice(0, 3).join('; ')}`}`,
  }
}

async function coreLeg(): Promise<WorkloadResult> {
  const pass = await runCorePass('off')
  return {
    ok: pass.passed === CORE_TESTS,
    ms: pass.elapsedMs,
    units: CORE_TESTS,
    detail: `${pass.passed}/${CORE_TESTS} tests passed, ${pass.events} events`,
  }
}

/** The pipeline every T3.12 leg uses: Oxc, no tsconfig, no hoisting; `cacheDir` turns the cache on. */
function corpusPipeline(root: string, cacheDir?: string): ModuleTransformer {
  return createPipeline({
    root,
    typescript: 'oxc',
    tsconfig: false,
    hoist: null,
    cache: cacheDir === undefined ? false : { dir: cacheDir },
    runnerForm: true,
  })
}

function corpusFiles(work: string): { readonly root: string; readonly files: string[] } {
  const root = join(work, WORK_PATHS.tsCorpus)
  return { root, files: sortedFiles(join(root, 'src'), '.ts') }
}

/** Transforms every corpus file, checking each record has code and its module-runner form. */
function transformAll(pipeline: ModuleTransformer, files: readonly string[]): string | undefined {
  for (const filename of files) {
    const record = pipeline.transform({
      filename,
      source: readFileSync(filename, 'utf8'),
      role: 'source',
      consumer: 'import',
      instrument: false,
    })
    if (record.code.length === 0) return `${filename}: no code`
    if (record.runner === undefined) return `${filename}: no module-runner form`
  }
  return undefined
}

function transformLeg(work: string): WorkloadResult {
  const { root, files } = corpusFiles(work)
  const start = performance.now()
  // `runnerForm` makes each record's module-runner form too: the work a cold worker does for an
  // ES module.
  const problem = transformAll(corpusPipeline(root), files)
  const ms = performance.now() - start
  return {
    ok: problem === undefined,
    ms,
    units: files.length,
    detail: problem ?? `${files.length} files`,
  }
}

function hoistLeg(): WorkloadResult {
  const input = generateTestFile({ seed: HOIST_SEED, mocked: true, targetBytes: HOIST_BYTES })
  const start = performance.now()
  let problem: string | undefined
  for (let i = 0; i < HOIST_CALLS; i++) {
    const output = hoistMocks(input, jestHoistPolicy, { filename: '/virtual/bench.test.ts' })
    if (!output.rewroteImports || output.staticMocks.length === 0)
      problem = 'the file was not hoisted'
  }
  const ms = performance.now() - start
  return {
    ok: problem === undefined,
    ms,
    units: HOIST_CALLS,
    detail: problem ?? `${input.length} bytes`,
  }
}

interface Request {
  readonly importer: string
  readonly specifier: string
  readonly kind: ResolveKind
}

function readRequests(work: string): Request[] {
  const parsed: unknown = JSON.parse(readFileSync(join(work, WORK_PATHS.requests), 'utf8'))
  if (!Array.isArray(parsed)) throw new Error('the requests file is not an array')
  return parsed.map((entry: unknown): Request => {
    const importer: unknown = Reflect.get(Object(entry), 'importer')
    const specifier: unknown = Reflect.get(Object(entry), 'specifier')
    const kind: unknown = Reflect.get(Object(entry), 'kind')
    if (typeof importer !== 'string' || typeof specifier !== 'string') {
      throw new Error(`a request is malformed: ${JSON.stringify(entry)}`)
    }
    return { importer, specifier, kind: kind === 'require' ? 'require' : 'import' }
  })
}

/** Resolves every request with `resolver`; the first that fails, or `undefined`. */
function resolveAll(resolver: Resolver, requests: readonly Request[]): string | undefined {
  for (const { importer, specifier, kind } of requests) {
    const result = resolver.resolve(specifier, { importer, kind, conditions: ['node'] })
    if (result.type !== 'file' && result.type !== 'builtin') return `${specifier} from ${importer}`
  }
  return undefined
}

function resolveLeg(work: string): WorkloadResult {
  const { root } = corpusFiles(work)
  const requests = readRequests(work)
  const start = performance.now()
  const resolver = createResolver({
    root,
    mappers: [],
    extensions: ['.ts', '.js', '.mjs', '.cjs', '.json'],
    tsconfig: false,
  })
  // A cold pass, then a warm one through the same resolver: Track 3's spike D measured both.
  const problem = resolveAll(resolver, requests) ?? resolveAll(resolver, requests)
  const ms = performance.now() - start
  return {
    ok: problem === undefined && requests.length > 0,
    ms,
    units: requests.length * 2,
    detail:
      problem === undefined ? `${requests.length} requests, twice` : `not resolved: ${problem}`,
  }
}

/** Fills the transform cache the `warm` leg reads (a prepare step, not a leg). */
export function fillWarmCache(work: string): WorkloadResult {
  const { root, files } = corpusFiles(work)
  const start = performance.now()
  const problem = transformAll(corpusPipeline(root, join(work, WORK_PATHS.transformCache)), files)
  return {
    ok: problem === undefined,
    ms: performance.now() - start,
    units: files.length,
    detail: problem ?? 'filled',
  }
}

function warmLeg(work: string): WorkloadResult {
  const { root, files } = corpusFiles(work)
  const start = performance.now()
  const problem = transformAll(corpusPipeline(root, join(work, WORK_PATHS.transformCache)), files)
  const ms = performance.now() - start
  return {
    ok: problem === undefined,
    ms,
    units: files.length,
    detail: problem ?? `${files.length} files`,
  }
}

/**
 * Runs one leg's workload in this process.
 * @public
 */
export async function runWorkload(leg: LegId, work: string): Promise<WorkloadResult> {
  switch (leg) {
    case 'app-50':
    case 'mock-heavy-50':
    case 'isolate-heavy':
      return suiteLeg(work, leg)
    case 'loader-e2e':
      return loaderLeg(work)
    case 'core':
      return coreLeg()
    case 'transform':
      return transformLeg(work)
    case 'hoist':
      return hoistLeg()
    case 'resolve':
      return resolveLeg(work)
    case 'warm':
      return warmLeg(work)
  }
}

/**
 * The planted regression (`--plant`): a fixed loop of `iterations` steps, run after a workload so
 * the guard can be shown to flag a real rise in work, not a number edited after the fact. Its
 * result is returned so the loop can't be dropped.
 * @public
 */
export function plantedWork(iterations: number): number {
  let x = 0
  for (let i = 0; i < iterations; i++) x = (Math.imul(x, 31) + i) | 0
  return x
}
