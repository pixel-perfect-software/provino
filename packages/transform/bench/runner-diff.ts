// B20 (T3.13): our module-runner transform against oracle A (oxc's `moduleRunnerTransformSync`)
// on three corpora, and its speed.
//
//   1. the fuzz corpus of `bench:runner-fuzz` (10,000 TypeScript files, seed 1, through the pipeline);
//   2. excalidraw at b99a49d (the ESM files, through the pipeline);
//   3. the scoping corpus: the hand-written cases and 5,000 generated programs.
//
// Each file's output is compared as an AST (positions, raw text and comments dropped) with oracle
// A's, with the errors, `deps` as sets, `dynamicDeps` and the export names. A difference needs an
// entry in `src/runner/test-exemptions.ts`; an entry that is no longer needed fails the check. Then
// the two transforms are timed on the excalidraw ESM files, interleaved, and the bars apply.
//
// Usage: node --conditions=provino-source packages/transform/bench/runner-diff.ts
//          [--root <dir>] [--fuzz-files 10000] [--scoping-files 5000] [--passes 7]
//          [--max-median-ms 0.15] [--max-mean-ms 0.35] [--max-route-median-ms 0.5]
//          [--plant none|scope|order] [--skip-diff] [--skip-speed] [--json]
import { parseArgs } from 'node:util'
import { createPipeline, toModuleRunner } from '@provino/transform'
import { moduleRunnerTransformSync } from 'oxc-transform'
import { DEFAULT_ROOT, median, readManifest, readSources } from './corpus.ts'
import { generateFuzzCorpus } from './fuzz-corpus.ts'
import { EXEMPTIONS } from './runner-exemptions.ts'
import { execute, judge, oracleA, ours } from './runner-oracle.ts'
import { generateScopingPrograms, SCOPING_CASES } from './scoping-corpus.ts'

const { values: args } = parseArgs({
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

/** A deliberate bug, to show the check can fail (`--plant`). */
function plant(code: string): string {
  if (args.plant === 'scope')
    return code.replace(/\(([a-z])\) => \1/, '($1) => __vite_ssr_import_0__.$1')
  if (args.plant === 'order') {
    return code.replace(
      /(const __vite_ssr_import_0__ = [^\n]*\n)(const __vite_ssr_import_1__ = [^\n]*\n)/,
      '$2$1',
    )
  }
  return code
}

const items: Item[] = []
for (const file of generateFuzzCorpus(Number(args['fuzz-files']), 1)) {
  const code = stripped(file.filename, file.source, 'test')
  if (code !== null)
    items.push({ corpus: 'fuzz', id: file.filename, filename: file.filename, code })
}
const fuzzCount = items.length
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
for (const { id, source } of [
  ...SCOPING_CASES,
  ...generateScopingPrograms(Number(args['scoping-files']), 1),
]) {
  items.push({ corpus: 'scoping', id, filename: `/${id}.js`, code: source })
}

const problems: string[] = []
const counts = new Map<string, { files: number; equal: number; exempt: number; failed: number }>()
const exemptSeen = new Map<string, number>()
const executed = { checked: 0, differing: 0 }
if (!args['skip-diff']) {
  for (const item of items) {
    const tally = counts.get(item.corpus) ?? { files: 0, equal: 0, exempt: 0, failed: 0 }
    counts.set(item.corpus, tally)
    tally.files++
    const expected = oracleA(item.filename, item.code)
    const actual = ours(item.filename, item.code)
    const planted = actual.code === null ? actual : { ...actual, code: plant(actual.code) }
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
  }
  for (const { id } of EXEMPTIONS) {
    if (!exemptSeen.has(id)) problems.push(`exemption ${id} no longer covers any file`)
  }
  // Oracle B on the fuzz files that run (the first 2,000).
  for (const item of items.slice(0, Math.min(2000, fuzzCount))) {
    const expected = oracleA(item.filename, item.code)
    const actual = ours(item.filename, item.code)
    if (expected.code === null || actual.code === null) continue
    if (judge(item.filename, item.code, expected, actual).exemption !== null) continue
    executed.checked++
    const [left, right] = await Promise.all([execute(expected.code), execute(actual.code)])
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      executed.differing++
      if (problems.length < 20) problems.push(`executed ${item.id} differs`)
    }
  }
}

// ---- Speed -------------------------------------------------------------------------------------
const passes = Number(args.passes)
const ns = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1e6
const speed = {
  oracle: { median: 0, mean: 0 },
  ours: { median: 0, mean: 0 },
  route: 0,
  firstCallMs: 0,
  files: excalidraw.length,
}
if (!args['skip-speed']) {
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

const limit = (name: string): number | undefined =>
  args[name as 'max-median-ms'] === undefined ? undefined : Number(args[name as 'max-median-ms'])
const maxMedian = limit('max-median-ms')
const maxMean = limit('max-mean-ms')
const maxRoute = limit('max-route-median-ms')
if (maxMedian !== undefined && speed.ours.median > maxMedian) {
  problems.push(`median ${speed.ours.median.toFixed(3)} ms/file is above ${maxMedian}`)
}
if (maxMean !== undefined && speed.ours.mean > maxMean) {
  problems.push(`mean ${speed.ours.mean.toFixed(3)} ms/file is above ${maxMean}`)
}
if (maxRoute !== undefined && speed.route > maxRoute) {
  problems.push(`route median ${speed.route.toFixed(3)} ms/file is above ${maxRoute}`)
}
for (const [corpus, tally] of counts) {
  if (tally.failed > 0) problems.push(`${corpus}: ${tally.failed} files differ`)
}

const report = {
  label: 'local',
  node: process.version,
  corpora: Object.fromEntries(counts),
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
      `  ${corpus}: ${t.files} files, AST-equal ${t.equal}, exempt ${t.exempt}, differing ${t.failed}`,
    )
  }
  lines.push(`  exemption list: ${EXEMPTIONS.length} entries`)
  for (const { id, reason } of EXEMPTIONS)
    lines.push(`    ${id} (${exemptSeen.get(id) ?? 0} files): ${reason}`)
  lines.push(
    `  executed in the stub linker: ${executed.checked} fuzz files, ${executed.differing} differ`,
  )
  if (!args['skip-speed']) {
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
