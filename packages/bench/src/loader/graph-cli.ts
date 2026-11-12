// The `graph` and `graph-child` commands of `bench:loader` (T2.6, B13d). `graph-child` is one measured
// run in its own process; `graph` builds the corpus, checks its size and its edges, then runs the
// children interleaved (cold and warm, 10 each) and holds the medians to the bars. Every number is
// `local`.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProcess } from '@provino/harness'
import { median } from '../stats.ts'
import {
  buildCorpusGraph,
  CORPUS,
  checkEdges,
  corpusStats,
  FLOORS,
  type GraphRun,
  measureGraph,
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
  process.stdout.write(`${JSON.stringify(run)}\n`)
}

async function child(mode: 'cold' | 'warm' | 'prime', cacheDir: string): Promise<GraphRun> {
  const result = await runProcess(
    process.execPath,
    ['--conditions=provino-source', CLI, 'graph-child', mode, cacheDir],
    { cwd: process.cwd(), env: { ...process.env, NO_COLOR: '1' }, timeoutMs: 120_000 },
  )
  if (result.exitCode !== 0)
    throw new Error(`graph-child ${mode} exited ${result.exitCode}:\n${result.output}`)
  const line = result.output.trim().split('\n').at(-1) ?? ''
  return JSON.parse(line) as GraphRun
}

export interface GraphBars {
  readonly maxColdMs: number | undefined
  readonly maxWarmMs: number | undefined
}

/** Runs the whole check: the lines to print, and whether every bar and floor held. */
export async function graphCommand(bars: GraphBars): Promise<{ lines: string[]; ok: boolean }> {
  const lines: string[] = []
  let ok = true
  const graph = await buildCorpusGraph()
  const stats = corpusStats(graph)
  const edges = checkEdges(graph)
  lines.push(
    `loader graph (local, Node ${process.version}, entries ${CORPUS.map((entry) => `${entry.name}@${entry.version}`).join(', ')})`,
    `  corpus ${stats.files} files, ${(stats.bytes / 1e6).toFixed(1)} MB, ${stats.edges} edges (floors ${FLOORS.files} files, ${(FLOORS.bytes / 1e6).toFixed(1)} MB, ${FLOORS.edges} edges)`,
    `  oxc-parser: ${edges.missed.length} static edges missed, ${edges.extra} extra in the graph, ${edges.parseFailures} files it could not parse`,
  )
  for (const missed of edges.missed.slice(0, 10)) lines.push(`    missed ${missed}`)
  if (stats.files < FLOORS.files || stats.bytes < FLOORS.bytes || stats.edges < FLOORS.edges) {
    ok = false
    lines.push('FAIL the corpus is below the research floors')
  }
  if (edges.missed.length > 0) {
    ok = false
    lines.push('FAIL the graph misses static edges')
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
      if (coldRun.fromCache || !warmRun.fromCache || warmRun.scanned !== 0) {
        throw new Error('a cold run read a cache, or a warm run scanned')
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
      ok = false
      lines.push(`FAIL cold ${coldMs.toFixed(1)} ms is above ${bars.maxColdMs}`)
    }
    if (bars.maxWarmMs !== undefined && !(warmMs <= bars.maxWarmMs)) {
      ok = false
      lines.push(`FAIL warm ${warmMs.toFixed(1)} ms is above ${bars.maxWarmMs}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return { lines, ok }
}
