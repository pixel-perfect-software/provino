// B10's acceptance check: an `app-N` suite (the Jest flavour) through one worker, under `registry`
// and under `none`. The bar is every test passing, none failing, and no ordering violation.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IsolationTier, PoolKind } from '@provino/types'
import { BenchError } from '../errors.ts'
import { FLAVOUR_DIR } from '../generators/render.ts'
import {
  buildSuite,
  expectedTests,
  PACKAGE_DIR,
  parseSuiteName,
  type SuiteSpec,
} from '../suites.ts'
import { runWorkerFiles, type WorkerRunResult } from './run.ts'

/** The tiers B10 implements. */
export const TIERS: readonly IsolationTier[] = ['registry', 'none']

/** A suite written to a temporary directory. */
export interface WrittenSuite {
  readonly spec: SuiteSpec
  /** The Jest tree: the project root, with `setup.js` and `tests/`. */
  readonly rootDir: string
  readonly setupFile: string
  /** The test files, in name order. */
  readonly files: readonly string[]
  /** Removes the directory. */
  cleanup(): Promise<void>
}

/**
 * Generates `name` (an `app-N` suite) in its Jest flavour into a new directory under the OS temp
 * directory. Only the Jest tree is written: it is the one this worker runs.
 */
export async function writeJestSuite(name: string): Promise<WrittenSuite> {
  const spec = parseSuiteName(name)
  if (spec.kind !== 'app') {
    throw new BenchError(
      'BENCH_UNKNOWN_SUITE',
      `${name}: the worker check runs app-N suites (mocks arrive with B13)`,
    )
  }
  const prefix = `${FLAVOUR_DIR.cjs}/`
  const base = await realpath(await mkdtemp(join(tmpdir(), 'provino-worker-')))
  try {
    const files: string[] = []
    for (const file of buildSuite(spec)) {
      if (!file.path.startsWith(prefix)) continue
      const target = join(base, file.path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.contents)
      if (file.path.includes('/tests/') && file.path.endsWith('.test.js')) files.push(target)
    }
    const rootDir = join(base, FLAVOUR_DIR.cjs)
    // The suite imports date-fns, lodash and zod: they resolve from the bench package's modules.
    await symlink(join(PACKAGE_DIR, 'node_modules'), join(rootDir, 'node_modules'), 'dir')
    return {
      spec,
      rootDir,
      setupFile: join(rootDir, 'setup.js'),
      files: files.sort(),
      cleanup: () => rm(base, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(base, { recursive: true, force: true })
    throw error
  }
}

/** One tier of the check: what ran, and whether it met the bar. */
export interface TierCheck {
  readonly result: WorkerRunResult
  /** The tests the suite holds: the number that must pass. */
  readonly expected: number
  readonly ok: boolean
}

/** Whether a run meets the bar: all `expected` passed, none failed or skipped, no violation. */
export function meetsBar(result: WorkerRunResult, expected: number): boolean {
  return (
    result.passed === expected &&
    result.total === expected &&
    result.failed === 0 &&
    result.unhandled === 0 &&
    result.violations.length === 0
  )
}

/**
 * Runs the suite through one worker per tier, one after the other, and checks each against the bar.
 */
export async function checkSuite(
  suite: WrittenSuite,
  options: { readonly pool?: PoolKind; readonly tiers?: readonly IsolationTier[] } = {},
): Promise<readonly TierCheck[]> {
  const expected = expectedTests(suite.spec)
  const checks: TierCheck[] = []
  for (const isolation of options.tiers ?? TIERS) {
    const result = await runWorkerFiles({
      rootDir: suite.rootDir,
      files: suite.files,
      setupFilesAfterEnv: [suite.setupFile],
      pool: options.pool ?? 'inline',
      isolation,
    })
    checks.push({ result, expected, ok: meetsBar(result, expected) })
  }
  return checks
}

/** The lines the CLI prints for one tier. */
export function describeTier({ result, expected, ok }: TierCheck): string[] {
  return [
    `  ${result.isolation.padEnd(8)} ${result.files} files, tests passed ${result.passed}/${expected}, failed ${result.failed}, skipped ${result.skipped}, unhandled ${result.unhandled}, order violations ${result.violations.length}, ${result.elapsedMs.toFixed(0)} ms (local)${ok ? '' : '  FAIL'}`,
    ...result.violations.slice(0, 10).map((violation) => `    order: ${violation}`),
    ...result.failures.map((failure) => `    ${failure}`),
  ]
}
