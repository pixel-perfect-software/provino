// `bench:loader e2e` and `bench:loader isolation` (Track 2's bench-e2e and bench-registry), as
// functions: the CLI prints them, and `provino-bench instructions` prints them as T2.12's `local`
// signals (≥5× per-file speedup over Jest, registry overhead ≤1.5 ms/file). Signals, not gates
// (build-plan §6: T2.12 is a per-PR regression guard; R6 is the GO gate).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRunnerPackage, runProcess } from '@provino/harness'
import { median } from '../stats.ts'
import { FIXTURE_FILES } from './fixture.ts'
import { createFixtureLoader, type LoaderTier, runFixture } from './run.ts'

/**
 * Measured runs of each subject, after one warm-up.
 * @public
 */
export const LOADER_BENCH_RUNS = 3

/**
 * T2.12's per-file speedup line (a signal).
 * @public
 */
export const E2E_MIN_SPEEDUP = 5

/**
 * T2.12's registry-overhead line, ms per file (a signal).
 * @public
 */
export const MAX_REGISTRY_OVERHEAD_MS = 1.5

/**
 * What `bench:loader e2e` measured: process start to exit, Provino's loader against Jest 30.5 with
 * `@swc/jest`, 200 files and 1 file each, medians. Per file is (200 − 1) / 199.
 * @public
 */
export interface E2eResult {
  readonly jestVersion: string
  readonly ours200Ms: number
  readonly ours1Ms: number
  readonly jest200Ms: number
  readonly jest1Ms: number
  readonly oursPerFileMs: number
  readonly jestPerFileMs: number
  /** `jestPerFileMs / oursPerFileMs`. */
  readonly speedup: number
}

/**
 * Runs the e2e comparison on the loader fixture in `dir` (written by `writeLoaderFixture`).
 * @public
 */
export async function measureE2e(dir: string): Promise<E2eResult> {
  const entry = fileURLToPath(new URL('entry.ts', import.meta.url))
  const jest = resolveRunnerPackage('jest', import.meta.url)
  const config = join(dir, 'jest.config.json')
  writeFileSync(
    config,
    JSON.stringify({
      rootDir: dir,
      testMatch: ['<rootDir>/tests/*.test.ts'],
      testEnvironment: 'node',
      cacheDirectory: join(dir, '.jest-cache'),
      // magic-string and es-module-lexer ship ESM only, so Jest has to transform them too.
      transformIgnorePatterns: [
        '/node_modules/(?!(?:\\.pnpm/)?(?:magic-string|es-module-lexer)[@/])',
      ],
      transform: {
        '\\.[cm]?[jt]s$': [
          '@swc/jest',
          {
            jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
            module: { type: 'commonjs' },
          },
        ],
      },
    }),
  )
  const env = { ...process.env, NO_COLOR: '1' }
  const ours = (count: number) =>
    runProcess(
      process.execPath,
      ['--conditions=provino-source', entry, dir, String(count), 'registry'],
      { cwd: dir, env, timeoutMs: 300_000 },
    )
  const theirs = (count: number) =>
    runProcess(
      process.execPath,
      [jest.bin, '--ci', '--runInBand', '--config', config, ...(count === 1 ? ['t000'] : [])],
      { cwd: dir, env, timeoutMs: 600_000 },
    )
  const wall: Record<string, number[]> = { ours200: [], ours1: [], jest200: [], jest1: [] }
  // One warm-up of each (Jest fills its cache), then interleaved measured runs.
  for (let run = 0; run <= LOADER_BENCH_RUNS; run++) {
    for (const [key, start] of [
      ['ours200', () => ours(FIXTURE_FILES)],
      ['jest200', () => theirs(FIXTURE_FILES)],
      ['ours1', () => ours(1)],
      ['jest1', () => theirs(1)],
    ] as const) {
      const result = await start()
      if (result.exitCode !== 0) {
        throw new Error(`${key} exited with ${result.exitCode}:\n${result.output}`)
      }
      if (run > 0) wall[key]?.push(result.wallMs)
    }
  }
  const at = (key: string): number => median(wall[key] ?? [])
  const oursPerFileMs = (at('ours200') - at('ours1')) / (FIXTURE_FILES - 1)
  const jestPerFileMs = (at('jest200') - at('jest1')) / (FIXTURE_FILES - 1)
  return {
    jestVersion: jest.version,
    ours200Ms: at('ours200'),
    ours1Ms: at('ours1'),
    jest200Ms: at('jest200'),
    jest1Ms: at('jest1'),
    oursPerFileMs,
    jestPerFileMs,
    speedup: jestPerFileMs / oursPerFileMs,
  }
}

/**
 * `bench:loader e2e`'s lines.
 * @public
 */
export function e2eLines(result: E2eResult): string[] {
  return [
    `loader e2e (local, Node ${process.version}, Jest ${result.jestVersion} + @swc/jest, median of ${LOADER_BENCH_RUNS})`,
    `  provino ${result.ours200Ms.toFixed(0)} ms / 200 files, ${result.ours1Ms.toFixed(0)} ms / 1 file → ${result.oursPerFileMs.toFixed(2)} ms per file`,
    `  jest    ${result.jest200Ms.toFixed(0)} ms / 200 files, ${result.jest1Ms.toFixed(0)} ms / 1 file → ${result.jestPerFileMs.toFixed(2)} ms per file`,
    `  per-file speedup ${result.speedup.toFixed(1)}x (a signal, not a gate)`,
  ]
}

/**
 * What `bench:loader isolation` measured: total ms for the fixture under `none` and `registry`,
 * medians, and the overhead per file.
 * @public
 */
export interface IsolationResult {
  readonly noneMs: number
  readonly registryMs: number
  readonly overheadMsPerFile: number
}

/**
 * Runs the fixture's `files` under both tiers, in this process: one warm-up pass per tier, then
 * interleaved runs, each with a fresh loader. Throws if a registry run fails a test.
 * @public
 */
export async function measureIsolation(
  dir: string,
  files: readonly string[],
): Promise<IsolationResult> {
  const totals: Record<LoaderTier, number[]> = { none: [], registry: [] }
  for (let run = 0; run <= LOADER_BENCH_RUNS; run++) {
    for (const tier of ['none', 'registry'] as const) {
      const result = await runFixture(createFixtureLoader(dir), files, tier)
      if (tier === 'registry' && result.failed > 0) {
        throw new Error(`the fixture failed under registry: ${result.failures[0]}`)
      }
      if (run > 0) totals[tier].push(result.elapsedMs)
    }
  }
  const noneMs = median(totals.none)
  const registryMs = median(totals.registry)
  return { noneMs, registryMs, overheadMsPerFile: (registryMs - noneMs) / files.length }
}

/**
 * `bench:loader isolation`'s lines.
 * @public
 */
export function isolationLines(result: IsolationResult, variant: string): string[] {
  return [
    `loader isolation (local, Node ${process.version}, ${variant} fixture, median of ${LOADER_BENCH_RUNS})`,
    `  none     ${result.noneMs.toFixed(0)} ms for ${FIXTURE_FILES} files`,
    `  registry ${result.registryMs.toFixed(0)} ms for ${FIXTURE_FILES} files`,
    `  registry overhead ${result.overheadMsPerFile.toFixed(2)} ms/file`,
  ]
}
