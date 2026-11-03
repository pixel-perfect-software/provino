#!/usr/bin/env node
// `pnpm bench:loader <check|isolation|e2e>`: Track 2's Spike A, ported (B06).
//   check      run the fixture through the loader; the bar is 600/600 and 0 isolation
//              violations under `registry` (`--tier none` shows the check can fail)
//   isolation  bench-registry: total ms for 200 files under `none` and `registry`, and the
//              per-file overhead (bar ≤1 ms/file on Node 24 with --max-overhead-ms 1)
//   e2e        bench-e2e: process start to exit for 200 files and 1 file, Provino's loader vs
//              Jest 30.5 with @swc/jest; a first per-file signal, not a gate
// Every number is labelled `local`. These are in-process micro-benchmarks from the spike, not
// Track 12 R5 BenchRecords, which `provino-bench run` writes.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { resolveRunnerPackage, runProcess } from '@provino/harness'
import { parseLimit } from '../internal/limits.ts'
import { median } from '../stats.ts'
import { FIXTURE_FILES, TESTS_PER_FILE, writeLoaderFixture } from './fixture.ts'
import { createFixtureLoader, type LoaderTier, runFixture } from './run.ts'

const RUNS = 3
const { positionals, values: args } = parseArgs({
  allowPositionals: true,
  options: {
    tier: { type: 'string', default: 'registry' },
    heavy: { type: 'boolean', default: false },
    'max-overhead-ms': { type: 'string' },
  },
})
const command = positionals[0]

// Parsed before any run, so a mistyped bar fails at once.
const maxOverheadMs = parseLimit('max-overhead-ms', args['max-overhead-ms'])

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'provino-loader-fixture-')))
const lines: string[] = []
let ok = true
try {
  const files = writeLoaderFixture(dir, { heavy: args.heavy })
  const variant = args.heavy ? 'heavy' : 'default'
  if (command === 'check') {
    const tier: LoaderTier = args.tier === 'none' ? 'none' : 'registry'
    const result = await runFixture(createFixtureLoader(dir), files, tier)
    const total = FIXTURE_FILES * TESTS_PER_FILE
    lines.push(
      `loader check (local, Node ${process.version}, ${variant} fixture, tier ${tier})`,
      `  passed ${result.passed}/${total}, isolation violations ${result.violations}`,
      ...result.failures.map((failure) => `    ${failure}`),
    )
    if (tier === 'registry' && (result.passed !== total || result.violations !== 0)) {
      ok = false
      lines.push(`FAIL the bar is ${total}/${total} with 0 isolation violations`)
    }
  } else if (command === 'isolation') {
    // One warm-up pass per tier, then interleaved runs, each with a fresh loader.
    const totals: Record<LoaderTier, number[]> = { none: [], registry: [] }
    for (let run = 0; run <= RUNS; run++) {
      for (const tier of ['none', 'registry'] as const) {
        const result = await runFixture(createFixtureLoader(dir), files, tier)
        if (tier === 'registry' && result.failed > 0) {
          throw new Error(`the fixture failed under registry: ${result.failures[0]}`)
        }
        if (run > 0) totals[tier].push(result.elapsedMs)
      }
    }
    const none = median(totals.none)
    const registry = median(totals.registry)
    const overhead = (registry - none) / FIXTURE_FILES
    lines.push(
      `loader isolation (local, Node ${process.version}, ${variant} fixture, median of ${RUNS})`,
      `  none     ${none.toFixed(0)} ms for ${FIXTURE_FILES} files`,
      `  registry ${registry.toFixed(0)} ms for ${FIXTURE_FILES} files`,
      `  registry overhead ${overhead.toFixed(2)} ms/file`,
    )
    // Written `!(measured <= bar)` so a NaN measurement fails the bar instead of passing it.
    if (maxOverheadMs !== undefined && !(overhead <= maxOverheadMs)) {
      ok = false
      lines.push(`FAIL overhead ${overhead.toFixed(2)} ms/file is above ${maxOverheadMs}`)
    }
  } else if (command === 'e2e') {
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
        {
          cwd: dir,
          env,
          timeoutMs: 300_000,
        },
      )
    const theirs = (count: number) =>
      runProcess(
        process.execPath,
        [jest.bin, '--ci', '--runInBand', '--config', config, ...(count === 1 ? ['t000'] : [])],
        { cwd: dir, env, timeoutMs: 600_000 },
      )
    const wall: Record<string, number[]> = { ours200: [], ours1: [], jest200: [], jest1: [] }
    // One warm-up of each (Jest fills its cache), then interleaved measured runs.
    for (let run = 0; run <= RUNS; run++) {
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
    const perFile = (all: string, one: string) =>
      (median(wall[all] ?? []) - median(wall[one] ?? [])) / (FIXTURE_FILES - 1)
    const oursPerFile = perFile('ours200', 'ours1')
    const jestPerFile = perFile('jest200', 'jest1')
    lines.push(
      `loader e2e (local, Node ${process.version}, Jest ${jest.version} + @swc/jest, median of ${RUNS})`,
      `  provino ${median(wall.ours200 ?? []).toFixed(0)} ms / 200 files, ${median(wall.ours1 ?? []).toFixed(0)} ms / 1 file → ${oursPerFile.toFixed(2)} ms per file`,
      `  jest    ${median(wall.jest200 ?? []).toFixed(0)} ms / 200 files, ${median(wall.jest1 ?? []).toFixed(0)} ms / 1 file → ${jestPerFile.toFixed(2)} ms per file`,
      `  per-file speedup ${(jestPerFile / oursPerFile).toFixed(1)}x (a signal, not a gate)`,
    )
  } else {
    ok = false
    lines.push(
      'usage: bench:loader <check|isolation|e2e> [--tier registry|none] [--heavy] [--max-overhead-ms N]',
    )
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
process.stdout.write(`${lines.join('\n')}\n`)
process.exitCode = ok ? 0 : 1
