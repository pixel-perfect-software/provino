// The `graph` and `graph-child` commands of `bench:loader` (T2.6, B13d). `graph-child` is one measured
// run in its own process; `graph` builds the corpus, checks its size and its edges, then runs the
// children interleaved (cold and warm, 10 each) and holds the medians to the bars. Every number is
// `local`.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProcess } from '@provino/harness'
import { exitCodeFor, pastLimit, readSample, SAMPLE_PREFIX } from '../internal/limits.ts'
import { median } from '../stats.ts'
import {
  buildCorpusGraph,
  CORPUS,
  checkEdges,
  corpusStats,
  FLOORS,
  GRAPH_RUN_KEYS,
  type GraphRun,
  measureGraph,
  UNRESOLVED_CEILING,
} from './graph.ts'

const RUNS = 10
const CLI = fileURLToPath(new URL('cli.ts', import.meta.url))

/** One measured run, printed as JSON on one line, for the parent to read. */
export async function graphChild(
  mode: string | undefined,
  cacheDir: string | undefined,
): Promise<void> {
  if (mode !== 'cold' && mode !== 'warm' && mode !== 'prime') {
    throw new Error('usage: graph-child <cold|warm|prime> [cache dir]')
  }
  const run = await measureGraph(mode === 'cold' ? null : (cacheDir ?? null), mode === 'prime')
  process.stdout.write(`${SAMPLE_PREFIX}${JSON.stringify(run)}\n`)
}

async function child(mode: 'cold' | 'warm' | 'prime', cacheDir: string): Promise<GraphRun> {
  const result = await runProcess(
    process.execPath,
    ['--conditions=provino-source', CLI, 'graph-child', mode, cacheDir],
    { cwd: process.cwd(), env: { ...process.env, NO_COLOR: '1' }, timeoutMs: 120_000 },
  )
  if (result.exitCode !== 0)
    throw new Error(`graph-child ${mode} exited ${result.exitCode}:\n${result.output}`)
  const run = readSample(result.output, GRAPH_RUN_KEYS)
  if (run === undefined) throw new Error(`graph-child ${mode} printed no sample:\n${result.output}`)
  return run
}

export interface GraphBars {
  readonly maxColdMs: number | undefined
  readonly maxWarmMs: number | undefined
}

/** Runs the whole check: the lines to print, and each bar or floor that was missed. */
export async function graphCommand(
  bars: GraphBars,
): Promise<{ lines: string[]; missed: string[]; exitCode: 0 | 1 }> {
  const lines: string[] = []
  const missed: string[] = []
  const fail = (message: string): void => {
    missed.push(message)
    lines.push(`FAIL ${message}`)
  }
  const graph = await buildCorpusGraph()
  const stats = corpusStats(graph)
  const edges = checkEdges(graph)
  lines.push(
    `loader graph (local, Node ${process.version}, entries ${CORPUS.map((entry) => `${entry.name}@${entry.version}`).join(', ')})`,
    `  corpus ${stats.files} files, ${(stats.bytes / 1e6).toFixed(1)} MB, ${stats.edges} edges (floors ${FLOORS.files} files, ${(FLOORS.bytes / 1e6).toFixed(1)} MB, ${FLOORS.edges} edges)`,
    `  oxc-parser: ${edges.missed.length} static edges missed, ${edges.extra} extra in the graph, ${edges.parseFailures} files it could not parse`,
    `  unresolved: ${edges.unresolved.length} edges the graph left unresolved that Node resolves (ceiling ${UNRESOLVED_CEILING})`,
  )
  for (const entry of edges.missed.slice(0, 10)) lines.push(`    missed ${entry}`)
  for (const entry of edges.unresolved.slice(0, 10)) lines.push(`    unresolved ${entry}`)
  if (stats.files < FLOORS.files || stats.bytes < FLOORS.bytes || stats.edges < FLOORS.edges) {
    fail('the corpus is below the research floors')
  }
  if (edges.missed.length > 0) fail('the graph misses static edges')
  if (edges.unresolved.length > UNRESOLVED_CEILING) {
    fail(
      `${edges.unresolved.length} edges are unresolved that Node resolves, above ${UNRESOLVED_CEILING}`,
    )
  }

  const dir = mkdtempSync(join(tmpdir(), 'provino-graph-bench-'))
  try {
    // One run writes the cache the warm runs read; it is not measured.
    await child('prime', dir)
    const cold: number[] = []
    const warm: number[] = []
    let last: GraphRun | undefined
    for (let run = 0; run < RUNS; run++) {
      const coldRun = await child('cold', dir)
      const warmRun = await child('warm', dir)
      if (coldRun.fromCache !== 0 || warmRun.fromCache !== 1 || warmRun.scanned !== 0) {
        throw new Error('a cold run read a cache, or a warm run scanned')
      }
      // The cache must hand back what a scan finds.
      for (const key of ['files', 'edges', 'closure', 'importers'] as const) {
        if (coldRun[key] !== warmRun[key] && !missed.some((entry) => entry.includes(key))) {
          fail(
            `the warm run's ${key} (${warmRun[key]}) differ from the cold run's (${coldRun[key]})`,
          )
        }
      }
      cold.push(coldRun.ms)
      warm.push(warmRun.ms)
      last = warmRun
    }
    const coldMs = median(cold)
    const warmMs = median(warm)
    lines.push(
      `  cold (no cache: lexer init, scan, resolve, one reverse query) median ${coldMs.toFixed(1)} ms of ${RUNS} (min ${Math.min(...cold).toFixed(1)}, max ${Math.max(...cold).toFixed(1)})`,
      `  warm (cache read and parsed, same query)                      median ${warmMs.toFixed(1)} ms of ${RUNS} (min ${Math.min(...warm).toFixed(1)}, max ${Math.max(...warm).toFixed(1)})`,
      `  the reverse query found ${last?.importers ?? 0} importers of ansi-styles`,
    )
    // Written `!(measured <= bar)` so a NaN measurement fails the bar instead of passing it.
    if (bars.maxColdMs !== undefined && !(coldMs <= bars.maxColdMs)) {
      fail(`cold ${pastLimit(coldMs, bars.maxColdMs, 1)} ms is above ${bars.maxColdMs}`)
    }
    if (bars.maxWarmMs !== undefined && !(warmMs <= bars.maxWarmMs)) {
      fail(`warm ${pastLimit(warmMs, bars.maxWarmMs, 1)} ms is above ${bars.maxWarmMs}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return { lines, missed, exitCode: exitCodeFor(missed) }
}
