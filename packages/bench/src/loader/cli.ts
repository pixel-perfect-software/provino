#!/usr/bin/env node
// `pnpm bench:loader <check|isolation|e2e>`: Track 2's Spike A, ported (B06).
//   check      run the fixture through the loader; the bar is 600/600 and 0 isolation
//              violations under `registry` (`--tier none` shows the check can fail)
//   isolation  bench-registry: total ms for 200 files under `none` and `registry`, and the
//              per-file overhead (bar ≤1 ms/file on Node 24 with --max-overhead-ms 1)
//   graph      T2.6's node_modules graph: the corpus, its edges against oxc-parser, and the cold and
//              warm medians (`--max-cold-ms 300 --max-warm-ms 20`)
//   claims     the cost of the claims verdicts over 2,000 claimed files of one package (no bar)
//   per-file   the cost of settling the per-file set (D132) on a hub with 3,000 per-file
//              importers and one shared one (no bar)
//   per-file-graph  a UI library graph of about 3,000 CommonJS modules evaluated per file under
//              jsdom: `provino jest -w 1` against Jest 30.5 on the same project, interleaved; file 1,
//              files 2..N and the heap after each file (`--files n --runs n --only provino,jest
//              --baseline <checkout> --idle-memory-limit <limit> --keep`; no bar)
//   e2e        bench-e2e: process start to exit for 200 files and 1 file, Provino's loader vs
//              Jest 30.5 with @swc/jest; a first per-file signal, not a gate
// Every number is labelled `local`. These are in-process micro-benchmarks from the spike, not
// Track 12 R5 BenchRecords, which `provino-bench run` writes.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { parseLimit } from '../internal/limits.ts'
import { claimsLines } from './claims.ts'
import { e2eLines, isolationLines, measureE2e, measureIsolation } from './e2e.ts'
import { FIXTURE_FILES, TESTS_PER_FILE, writeLoaderFixture } from './fixture.ts'
import { graphChild, graphCommand } from './graph-cli.ts'
import { perFileLines } from './per-file.ts'
import { PER_FILE_TESTS, perFileGraphLines, type Subject } from './per-file-graph.ts'
import { createFixtureLoader, type LoaderTier, runFixture } from './run.ts'

const { positionals, values: args } = parseArgs({
  allowPositionals: true,
  options: {
    tier: { type: 'string', default: 'registry' },
    heavy: { type: 'boolean', default: false },
    'max-overhead-ms': { type: 'string' },
    'max-cold-ms': { type: 'string' },
    'max-warm-ms': { type: 'string' },
    files: { type: 'string' },
    runs: { type: 'string' },
    only: { type: 'string' },
    keep: { type: 'boolean', default: false },
    baseline: { type: 'string' },
    'idle-memory-limit': { type: 'string' },
  },
})
const command = positionals[0]

// Parsed before any run, so a mistyped bar fails at once.
const maxOverheadMs = parseLimit('max-overhead-ms', args['max-overhead-ms'])
const maxColdMs = parseLimit('max-cold-ms', args['max-cold-ms'])
const maxWarmMs = parseLimit('max-warm-ms', args['max-warm-ms'])

// The graph commands need no fixture tree.
if (command === 'graph-child') {
  await graphChild(positionals[1], positionals[2])
  process.exit(0)
}
if (command === 'graph') {
  const { lines: graphLines, exitCode } = await graphCommand({ maxColdMs, maxWarmMs })
  process.stdout.write(`${graphLines.join('\n')}\n`)
  process.exit(exitCode)
}

if (command === 'per-file-graph') {
  const count = (name: string, value: string | undefined, fallback: number): number => {
    const parsed = value === undefined ? fallback : Number(value)
    if (!Number.isInteger(parsed) || parsed < 1) {
      process.stderr.write(`--${name} must be a positive integer, got ${value}\n`)
      process.exit(2)
    }
    return parsed
  }
  const subjects: Subject[] = []
  for (const name of (args.only ?? 'provino,jest,baseline').split(',')) {
    if (name !== 'provino' && name !== 'jest' && name !== 'baseline') {
      process.stderr.write(`--only takes provino, jest and baseline, got ${name}\n`)
      process.exit(2)
    }
    if (name !== 'baseline' || args.baseline !== undefined) subjects.push(name)
  }
  const lines = await perFileGraphLines({
    files: count('files', args.files, PER_FILE_TESTS),
    runs: count('runs', args.runs, 3),
    keep: args.keep,
    subjects,
    ...(args.baseline === undefined ? {} : { baseline: args.baseline }),
    ...(args['idle-memory-limit'] === undefined
      ? {}
      : { idleMemoryLimit: args['idle-memory-limit'] }),
  })
  process.stdout.write(`${lines.join('\n')}\n`)
  process.exit(0)
}

if (command === 'claims') {
  process.stdout.write(`${(await claimsLines()).join('\n')}\n`)
  process.exit(0)
}

if (command === 'per-file') {
  process.stdout.write(`${perFileLines().join('\n')}\n`)
  process.exit(0)
}

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
    const result = await measureIsolation(dir, files)
    lines.push(...isolationLines(result, variant))
    // Written `!(measured <= bar)` so a NaN measurement fails the bar instead of passing it.
    if (maxOverheadMs !== undefined && !(result.overheadMsPerFile <= maxOverheadMs)) {
      ok = false
      lines.push(
        `FAIL overhead ${result.overheadMsPerFile.toFixed(2)} ms/file is above ${maxOverheadMs}`,
      )
    }
  } else if (command === 'e2e') {
    lines.push(...e2eLines(await measureE2e(dir)))
  } else {
    ok = false
    lines.push(
      'usage: bench:loader <check|isolation|graph|claims|per-file|per-file-graph|e2e> [--tier registry|none] [--heavy] [--max-overhead-ms N] [--max-cold-ms N --max-warm-ms N]',
    )
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
process.stdout.write(`${lines.join('\n')}\n`)
process.exitCode = ok ? 0 : 1
