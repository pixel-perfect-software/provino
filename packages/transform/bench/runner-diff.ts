// B20 (T3.13): our module-runner transform against oracle A (oxc's `moduleRunnerTransformSync`)
// on three corpora, and its speed.
//
//   1. the fuzz corpus of `bench:runner-fuzz` (10,000 TypeScript files, seed 1, through the pipeline);
//   2. excalidraw at b99a49d (the ESM files, through the pipeline);
//   3. the scoping corpus: the hand-written cases and 5,000 generated programs.
//
// Each file's output is compared as an AST (positions, raw text and comments dropped) with oracle
// A's, with the errors, `deps` as sets, `dynamicDeps` and the export names. A difference needs an
// entry in `bench/runner-exemptions.ts`; an entry that is no longer needed fails the check. Then
// the fuzz files that compile run in a stub linker (oracle B, `execute` in `bench/runner-oracle.ts`)
// beside oracle A's, and the two transforms are timed on the excalidraw ESM files, interleaved,
// and the bars apply. `bench/runner-equivalence.test.ts` runs the scoping corpus in `pnpm test`.
//
// Usage: node --conditions=provino-source packages/transform/bench/runner-diff.ts
//          [--root <dir>] [--fuzz-files 10000] [--scoping-files 5000] [--passes 7]
//          [--max-median-ms 0.15] [--max-mean-ms 0.35] [--max-route-median-ms 0.5]
//          [--plant none|scope|order|member] [--skip-diff] [--skip-speed] [--json]
// A bar (`--max-*`) is opt-in and needs the speed run. A flag that cannot work (a bar that is not a
// number above 0, a bar with `--skip-speed`, a plant with `--skip-diff`, an unknown plant, a size
// that is not a whole number of 1 or more) exits with code 2 before any work. Exit 1: a problem.
import { parseArgs } from 'node:util'
import { createPipeline, toModuleRunner } from '@provino/transform'
import { moduleRunnerTransformSync } from 'oxc-transform'
import {
  DEFAULT_ROOT,
  median,
  parseBar,
  parseOrExitUsage,
  parsePositiveInt,
  readManifest,
  readSources,
  UsageError,
} from './corpus.ts'
import { generateFuzzCorpus } from './fuzz-corpus.ts'
import { EXEMPTIONS } from './runner-exemptions.ts'
import {
  compareExecutions,
  execute,
  judge,
  type OracleResult,
  oracleA,
  ours,
} from './runner-oracle.ts'
import { generateScopingPrograms, SCOPING_CASES } from './scoping-corpus.ts'

const PLANTS = ['none', 'scope', 'order', 'member'] as const
type Plant = (typeof PLANTS)[number]

// Parsed before any work, so a mistyped flag stops the run instead of passing it: `Number('abc')`
// is NaN, and a NaN is never above a bar.
const args = parseOrExitUsage('bench:runner-diff', () => {
  const { values } = parseArgs({
    options: {
      root: { type: 'string', default: DEFAULT_ROOT },
      'fuzz-files': { type: 'string', default: '10000' },
      'scoping-files': { type: 'string', default: '5000' },
      passes: { type: 'string', default: '7' },
      'max-median-ms': { type: 'string' },
      'max-mean-ms': { type: 'string' },
      'max-route-median-ms': { type: 'string' },
      plant: { type: 'string', default: 'none' },
      'skip-diff': { type: 'boolean', default: false },
      'skip-speed': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  })
  const plant: Plant | undefined = PLANTS.find((name) => name === values.plant)
  if (plant === undefined) {
    throw new UsageError(`--plant needs one of ${PLANTS.join(', ')}, got "${values.plant}"`)
  }
  const bars = {
    median: parseBar('max-median-ms', values['max-median-ms']),
    mean: parseBar('max-mean-ms', values['max-mean-ms']),
    route: parseBar('max-route-median-ms', values['max-route-median-ms']),
  }
  if (values['skip-speed'] && Object.values(bars).some((bar) => bar !== undefined)) {
    throw new UsageError('a --max-* bar needs the speed run, so it cannot go with --skip-speed')
  }
  if (values['skip-diff'] && plant !== 'none') {
    throw new UsageError(`--plant ${plant} needs the diff run, so it cannot go with --skip-diff`)
  }
  return {
    root: values.root,
    fuzzFiles: parsePositiveInt('fuzz-files', values['fuzz-files']),
    scopingFiles: parsePositiveInt('scoping-files', values['scoping-files']),
    passes: parsePositiveInt('passes', values.passes),
    bars,
    plant,
    skipDiff: values['skip-diff'],
    skipSpeed: values['skip-speed'],
    json: values.json,
  }
})

interface Item {
  readonly corpus: string
  readonly id: string
  readonly filename: string
  readonly code: string
}

const pipeline = createPipeline({
  root: args.root,
  typescript: 'oxc',
  tsconfig: false,
  hoist: null,
  cache: false,
})

function stripped(filename: string, source: string, role: 'test' | 'source'): string | null {
  const record = pipeline.transform({
    filename,
    source,
    role,
    consumer: 'import',
    instrument: false,
  })
  if (record.diagnostics.some((d) => d.severity === 'error')) return null
  return record.code
}

/**
 * A deliberate bug in our output, to show the check can fail (`--plant`). It reaches both the AST
 * comparison and oracle B, which runs the planted code. `scope` rewrites a parameter as an import
 * (the first `(x) => x...`); the fuzz corpus never calls such an arrow, so only the AST comparison
 * sees it. `order` swaps the first two imports and `member` reads another member of the first
 * import: oracle B sees both (the log, the exports).
 */
function plant(code: string): string {
  if (args.plant === 'scope')
    return code.replace(/\(([a-z])\) => \1/, '($1) => __vite_ssr_import_0__.$1')
  if (args.plant === 'member') return code.replace(/(__vite_ssr_import_\d+__\.)(\w+)/, '$1$2_x')
  if (args.plant === 'order') {
    return code.replace(
      /(const __vite_ssr_import_0__ = [^\n]*\n)(const __vite_ssr_import_1__ = [^\n]*\n)/,
      '$2$1',
    )
  }
  return code
}

const items: Item[] = []
for (const file of generateFuzzCorpus(args.fuzzFiles, 1)) {
  const code = stripped(file.filename, file.source, 'test')
  if (code !== null)
    items.push({ corpus: 'fuzz', id: file.filename, filename: file.filename, code })
}
const manifest = readManifest()
const excalidraw: { filename: string; code: string; rel: string }[] = []
for (const { filename, source } of readSources(args.root, manifest)) {
  const record = pipeline.transform({
    filename,
    source,
    role: 'source',
    consumer: 'import',
    instrument: false,
  })
  if (record.format !== 'esm' || record.diagnostics.some((d) => d.severity === 'error')) continue
  const rel = filename.slice(args.root.length + 1)
  excalidraw.push({ filename, code: record.code, rel })
  items.push({ corpus: 'excalidraw', id: rel, filename, code: record.code })
}
for (const { id, source } of [...SCOPING_CASES, ...generateScopingPrograms(args.scopingFiles, 1)]) {
  items.push({ corpus: 'scoping', id, filename: `/${id}.js`, code: source })
}

/** What each corpus was asked for: the comparisons below say how many of those files were made. */
const REQUESTED: Readonly<Record<string, number>> = {
  fuzz: args.fuzzFiles,
  excalidraw: manifest.files.length,
  scoping: SCOPING_CASES.length + args.scopingFiles,
}

interface Tally {
  /** Files compared. */
  files: number
  equal: number
  exempt: number
  failed: number
  /** Comparisons where oracle A rejected the input, so only the two errors were compared. */
  errorOnly: number
}
const problems: string[] = []
const counts = new Map<string, Tally>()
const exemptSeen = new Map<string, number>()
/** Oracle B: how many fuzz files were run, and how many of those ran at all. */
const executed = {
  /** Pairs offered to the stub linker: both transforms succeeded and no exemption covers them. */
  offered: 0,
  /** Pairs that compiled on at least one side and were compared. */
  checked: 0,
  /** Pairs neither side compiled (the same SyntaxError): nothing ran, nothing was compared. */
  notRunnable: 0,
  /** Checked pairs whose log is not empty, so the stub linker saw an import, a call or a `new`. */
  withLog: 0,
  differing: 0,
  ms: 0,
}
if (!args.skipDiff) {
  const runnable: { id: string; expected: string; actual: string }[] = []
  for (const item of items) {
    const tally = counts.get(item.corpus) ?? {
      files: 0,
      equal: 0,
      exempt: 0,
      failed: 0,
      errorOnly: 0,
    }
    counts.set(item.corpus, tally)
    tally.files++
    const expected = oracleA(item.filename, item.code)
    const actual = ours(item.filename, item.code)
    const planted: OracleResult =
      actual.code === null ? actual : { ...actual, code: plant(actual.code) }
    if (expected.error !== null) tally.errorOnly++
    const verdict = judge(item.filename, item.code, expected, planted)
    if (verdict.reason === null && verdict.exemption === null) {
      tally.equal++
    } else if (verdict.exemption !== null) {
      tally.exempt++
      exemptSeen.set(verdict.exemption, (exemptSeen.get(verdict.exemption) ?? 0) + 1)
    } else {
      tally.failed++
      if (problems.length < 20) problems.push(`${item.corpus} ${item.id}: ${verdict.reason}`)
    }
    // Oracle B skips the files an exemption covers: they run differently on purpose. The exemption
    // is judged on our real output, so a plant cannot move a file out of it (or into oracle B).
    const unplanted =
      args.plant === 'none' ? verdict : judge(item.filename, item.code, expected, actual)
    if (
      item.corpus === 'fuzz' &&
      unplanted.exemption === null &&
      expected.code !== null &&
      planted.code !== null
    ) {
      runnable.push({ id: item.id, expected: expected.code, actual: planted.code })
    }
  }
  for (const { id } of EXEMPTIONS) {
    if (!exemptSeen.has(id)) problems.push(`exemption ${id} no longer covers any file`)
  }
  for (const corpus of Object.keys(REQUESTED)) {
    if ((counts.get(corpus)?.files ?? 0) === 0) problems.push(`${corpus}: compared 0 files`)
  }
  // Oracle B: every fuzz file both transforms made code for (and no exemption covers), run beside
  // each other: about 0.65 s for 8,130 files, `local`, so none is left out. A file that neither side
  // can compile (decorators, `accessor`) is counted apart: it ran nothing.
  const start = process.hrtime.bigint()
  for (const file of runnable) {
    executed.offered++
    const [left, right] = await Promise.all([execute(file.expected), execute(file.actual)])
    const verdict = compareExecutions(left, right)
    if (verdict === 'notRunnable') {
      executed.notRunnable++
      continue
    }
    executed.checked++
    if (left.log.length > 0 || right.log.length > 0) executed.withLog++
    if (verdict === 'differ') {
      executed.differing++
      if (problems.length < 20) problems.push(`executed ${file.id} differs`)
    }
  }
  executed.ms = Math.round(Number(process.hrtime.bigint() - start) / 1e6)
  if (executed.checked === 0) problems.push('oracle B checked 0 files: nothing ran')
}

// ---- Speed -------------------------------------------------------------------------------------
const passes = args.passes
const ns = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1e6
const speed = {
  oracle: { median: 0, mean: 0 },
  ours: { median: 0, mean: 0 },
  route: 0,
  firstCallMs: 0,
  files: excalidraw.length,
}
if (!args.skipSpeed) {
  const oracleTimes = excalidraw.map(() => [] as number[])
  const ourTimes = excalidraw.map(() => [] as number[])
  const first = process.hrtime.bigint()
  toModuleRunner('/first.js', {
    ...pipeline.transform({
      filename: '/first.ts',
      source: 'export const a = 1',
      role: 'source',
      consumer: 'import',
      instrument: false,
    }),
  })
  speed.firstCallMs = ns(first)
  for (let pass = 0; pass < passes + 1; pass++) {
    for (let i = 0; i < excalidraw.length; i++) {
      const file = excalidraw[i]
      if (file === undefined) continue
      const record = {
        code: file.code,
        map: null,
        diagnostics: [],
        imports: [],
        staticMocks: [],
        lateDeps: [],
        format: 'esm' as const,
        hasTopLevelAwait: false,
        cacheKey: '',
      }
      // Alternate who goes first, so neither one always runs on a cold cache line.
      const order = (i + pass) % 2 === 0
      for (const which of order ? [0, 1] : [1, 0]) {
        const start = process.hrtime.bigint()
        if (which === 0) moduleRunnerTransformSync(file.filename, file.code, { sourcemap: true })
        else toModuleRunner(file.filename, record as never)
        const elapsed = ns(start)
        if (pass > 0) (which === 0 ? oracleTimes : ourTimes)[i]?.push(elapsed)
      }
    }
  }
  const summary = (all: number[][]): { median: number; mean: number } => {
    const per = all.map((times) => median(times))
    return { median: median(per), mean: per.reduce((a, b) => a + b, 0) / per.length }
  }
  speed.oracle = summary(oracleTimes)
  speed.ours = summary(ourTimes)
  // The route: the pipeline then the runner, per file, as the loader runs them on a cold cache.
  const route = excalidraw.map(() => [] as number[])
  const sources = readSources(args.root, manifest)
  const sourceOf = new Map(sources.map((s) => [s.filename, s.source]))
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < excalidraw.length; i++) {
      const file = excalidraw[i]
      const source = file === undefined ? undefined : sourceOf.get(file.filename)
      if (file === undefined || source === undefined) continue
      const start = process.hrtime.bigint()
      const record = pipeline.transform({
        filename: file.filename,
        source,
        role: 'source',
        consumer: 'import',
        instrument: false,
      })
      toModuleRunner(file.filename, record)
      route[i]?.push(ns(start))
    }
  }
  speed.route = median(route.map((times) => median(times)))
}

// Written `!(value <= bar)`, so a NaN measurement misses instead of passing.
const { median: maxMedian, mean: maxMean, route: maxRoute } = args.bars
if (maxMedian !== undefined && !(speed.ours.median <= maxMedian)) {
  problems.push(`median ${speed.ours.median.toFixed(3)} ms/file is above ${maxMedian}`)
}
if (maxMean !== undefined && !(speed.ours.mean <= maxMean)) {
  problems.push(`mean ${speed.ours.mean.toFixed(3)} ms/file is above ${maxMean}`)
}
if (maxRoute !== undefined && !(speed.route <= maxRoute)) {
  problems.push(`route median ${speed.route.toFixed(3)} ms/file is above ${maxRoute}`)
}
for (const [corpus, tally] of counts) {
  if (tally.failed > 0) problems.push(`${corpus}: ${tally.failed} files differ`)
}

const report = {
  label: 'local',
  node: process.version,
  corpora: Object.fromEntries(
    Object.entries(REQUESTED).map(([corpus, requested]) => {
      const { files, ...tally } = counts.get(corpus) ?? { files: 0 }
      return [corpus, { requested, compared: files, ...tally }]
    }),
  ),
  exemptions: EXEMPTIONS.map(({ id, reason }) => ({ id, reason, files: exemptSeen.get(id) ?? 0 })),
  executed,
  speed,
  problems,
}
if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
else {
  const lines = [`runner diff (local, Node ${process.version}, plant ${args.plant})`]
  for (const [corpus, t] of counts) {
    lines.push(
      `  ${corpus}: requested ${REQUESTED[corpus]}, compared ${t.files} (error-only ${t.errorOnly}), AST-equal ${t.equal}, exempt ${t.exempt}, differing ${t.failed}`,
    )
  }
  lines.push(`  exemption list: ${EXEMPTIONS.length} entries`)
  for (const { id, reason } of EXEMPTIONS)
    lines.push(`    ${id} (${exemptSeen.get(id) ?? 0} files): ${reason}`)
  if (!args.skipDiff) {
    lines.push(
      `  oracle B (stub linker) on ${executed.offered} fuzz files in ${executed.ms} ms: checked ${executed.checked} (with a log ${executed.withLog}), notRunnable ${executed.notRunnable}, differ ${executed.differing}`,
    )
  }
  if (!args.skipSpeed) {
    lines.push(
      `  excalidraw ESM ${speed.files} files, ${passes} interleaved passes:`,
      `    oracle A  median ${speed.oracle.median.toFixed(3)}  mean ${speed.oracle.mean.toFixed(3)} ms/file`,
      `    ours      median ${speed.ours.median.toFixed(3)}  mean ${speed.ours.mean.toFixed(3)} ms/file  (ratio ${(speed.ours.median / speed.oracle.median).toFixed(2)} median, ${(speed.ours.mean / speed.oracle.mean).toFixed(2)} mean)`,
      `    route (pipeline + runner) median ${speed.route.toFixed(3)} ms/file; first call ${speed.firstCallMs.toFixed(2)} ms`,
    )
  }
  for (const problem of problems) lines.push(`FAIL ${problem}`)
  process.stdout.write(`${lines.join('\n')}\n`)
}
process.exitCode = problems.length === 0 ? 0 : 1
