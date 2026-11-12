#!/usr/bin/env node
// `pnpm bench:env [--max-ratio N] [--max-heap-mb N] [--files N] [--rounds N]`: T8.3's jsdom bar.
// The per-file cost of `@provino/env-jsdom` (a fresh window, populated onto the global, the
// workload, torn down and restored exactly) against a raw-jsdom loop doing the same work (a fresh
// `JSDOM`, `populateGlobal`, the workload, `populated.restore()` and `window.close()`), in this one
// process, file by file interleaved (which goes first alternates). The baseline has to undo what it
// populated, or its next file would populate over the last one; what the environment adds is the
// descriptor-exact restore. Then the heap: growth after GC over `--files` files of the environment.
// T8.3: median within 10% of the baseline and growth at most 10 MB over 100 files
// (`--max-ratio 1.10 --max-heap-mb 10`). Needs `--expose-gc` (the root script passes it). Every
// number is `local`. Exit 0 when no bar is missed (or none is on), 1 when one is, 2 on bad usage.
//
// The spike's absolute figures (22.8 ms per file) were its machine's; only the `fresh-global` row
// applies to the registry tier (the `vm-window` row needs the realm tier, T2.8).
import { performance } from 'node:perf_hooks'
import { setImmediate as nextMacrotask } from 'node:timers/promises'
import { jsdomEnvironment } from '@provino/env-jsdom'
import { populateGlobal } from '@provino/env-shared'
import type { EnvironmentSetupContext } from '@provino/types'
import { JSDOM } from 'jsdom'
import { exitCodeFor, parseOrExitUsage } from '../internal/limits.ts'
import { median, ratioCi } from '../stats.ts'
import { failures, heapGrowthMb, parseBars, ratioOf } from './report.ts'

const bars = parseOrExitUsage('bench:env', () => parseBars(process.argv.slice(2)))

const gc = (globalThis as { gc?: () => void }).gc
if (gc === undefined) {
  process.stderr.write('bench:env: run with --expose-gc (use `pnpm bench:env`)\n')
  process.exit(2)
}

const URL_OPTION = 'http://localhost:3000'
const HTML = '<!DOCTYPE html><html><body><div id="root"></div></body></html>'
const WARMUP_FILES = 10

interface Dom {
  readonly document: Document
  readonly Event: typeof Event
}

/** What a small test file does to its window: build a tree, query it, dispatch an event. */
function workload(): number {
  const dom = globalThis as unknown as Dom
  const root = dom.document.createElement('div')
  for (let i = 0; i < 200; i++) {
    const item = dom.document.createElement('span')
    item.className = `item-${i % 7}`
    item.textContent = String(i)
    root.appendChild(item)
  }
  dom.document.body.appendChild(root)
  let clicks = 0
  root.addEventListener('click', () => {
    clicks++
  })
  root.firstElementChild?.dispatchEvent(new dom.Event('click', { bubbles: true }))
  return dom.document.querySelectorAll('.item-3').length + clicks
}

/** One file under a raw jsdom: new window, populate, the workload, restore, close. */
function rawFile(): number {
  const dom = new JSDOM(HTML, {
    url: URL_OPTION,
    pretendToBeVisual: true,
    runScripts: 'dangerously',
  })
  const populated = populateGlobal(globalThis, dom.window, { bindFunctions: true })
  const result = workload()
  populated.restore()
  dom.window.close()
  return result
}

const prepared: unknown = await jsdomEnvironment.prepare?.({})
const context: EnvironmentSetupContext<{ readonly url: string; readonly html: string }> = {
  options: { url: URL_OPTION, html: HTML },
  realm: 'worker',
  scope: 'file',
  testPath: '/bench.test.ts',
  pragmas: {},
  console,
  signal: new AbortController().signal,
}

/** One file under `@provino/env-jsdom`. */
async function environmentFile(): Promise<number> {
  const instance = await jsdomEnvironment.setup(context, prepared)
  const result = workload()
  const report = await instance.teardown()
  if (report !== undefined) throw new Error(`teardown left ${report.leakedGlobals.join(', ')}`)
  return result
}

async function settledHeap(): Promise<number> {
  for (let i = 0; i < 3; i++) {
    gc?.()
    await nextMacrotask()
  }
  return process.memoryUsage().heapUsed
}

// Heap first, in a process that has run nothing else: warm the module graph, then measure.
for (let i = 0; i < WARMUP_FILES; i++) await environmentFile()
const heapBefore = await settledHeap()
for (let i = 0; i < bars.files; i++) await environmentFile()
const heapAfter = await settledHeap()
const heapMb = heapGrowthMb(heapBefore, heapAfter)

// Timing: `rounds + 1` rounds of `files` files each, the first thrown away.
const baseline: number[] = []
const ours: number[] = []
for (let round = 0; round <= bars.rounds; round++) {
  for (let file = 0; file < bars.files; file++) {
    const measure = async (which: 'raw' | 'environment'): Promise<number> => {
      const start = performance.now()
      if (which === 'raw') rawFile()
      else await environmentFile()
      return performance.now() - start
    }
    // Alternate who goes first, so neither always runs on the other's warmed state.
    const first = (round + file) % 2 === 0 ? 'raw' : 'environment'
    const second = first === 'raw' ? 'environment' : 'raw'
    const a = await measure(first)
    const b = await measure(second)
    if (round === 0) continue
    baseline.push(first === 'raw' ? a : b)
    ours.push(first === 'raw' ? b : a)
  }
}

const baselineMedian = median(baseline)
const oursMedian = median(ours)
const ratio = ratioOf({ ours: oursMedian, baseline: baselineMedian })
const interval = ratioCi(ours, baseline)
const lines = [
  `env bench (local, Node ${process.version}, ${process.platform} ${process.arch}, ${bars.rounds} rounds of ${bars.files} files after 1 discarded, file by file interleaved in one process)`,
  `  raw jsdom (fresh-global): ${baselineMedian.toFixed(2)} ms per file (median of ${baseline.length})`,
  `  @provino/env-jsdom:       ${oursMedian.toFixed(2)} ms per file (median of ${ours.length})`,
  `  ratio: ${ratio.toFixed(3)}× (bootstrap 95% CI ${interval.low.toFixed(3)} to ${interval.high.toFixed(3)})`,
  `  heap growth after GC over ${bars.files} files: ${heapMb.toFixed(2)} MB (${WARMUP_FILES} warm-up files first)`,
  "  the baseline includes populateGlobal's own restore: without one its next file would populate over the last",
]
const missed = failures({ ratio, heapMb }, bars)
lines.push(...missed)
process.stdout.write(`${lines.join('\n')}\n`)
process.exitCode = exitCodeFor(missed)
