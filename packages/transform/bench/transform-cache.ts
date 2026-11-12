// T3.6's acceptance bench: the cost of a warm transform cache over the excalidraw corpus of T3.5
// (the same file list, `fixtures/excalidraw.json`, from `.refs/excalidraw`). One cold pass fills a
// fresh cache directory; then each timed pass opens the directory again (a new pipeline, as a new
// worker would) and transforms every file, which must be served from the cache. The number is the
// median over files, then over passes, of one `transform` call (the key, the read and the parse of
// a record; the source is already in memory). Every number is `local`.
//
// Usage: node --conditions=provino-source packages/transform/bench/transform-cache.ts
//          [--root <dir>] [--max-warm-ms 0.05] [--json]
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createPipeline, toModuleRunner } from '@provino/transform'
import type { TransformRecord } from '@provino/types'
import { moduleRunnerTransformSync } from 'oxc-transform'
import { DEFAULT_ROOT, median, readManifest, readSources } from './corpus.ts'

const TIMED_PASSES = 15

const { values: args } = parseArgs({
  options: {
    root: { type: 'string', default: DEFAULT_ROOT },
    'max-warm-ms': { type: 'string' },
    json: { type: 'boolean', default: false },
  },
})
const root = args.root

const manifest = readManifest()
const sources = readSources(root, manifest)

const cacheDir = mkdtempSync(join(tmpdir(), 'provino-transform-cache-bench-'))

function pipelineWith(cache: false | { readonly dir: string }): ReturnType<typeof createPipeline> {
  return createPipeline({ root, typescript: 'oxc', tsconfig: 'auto', hoist: null, cache })
}

interface Pass {
  readonly times: number[]
  readonly records: TransformRecord[]
}

function pass(pipeline: ReturnType<typeof createPipeline>): Pass {
  const times: number[] = []
  const records: TransformRecord[] = []
  for (const { filename, source } of sources) {
    const start = process.hrtime.bigint()
    const record = pipeline.transform({
      filename,
      source,
      role: 'source',
      consumer: 'import',
      instrument: false,
    })
    times.push(Number(process.hrtime.bigint() - start) / 1e6)
    records.push(record)
  }
  return { times, records }
}

const failures: string[] = []
try {
  const uncached = pass(pipelineWith(false))
  const uncachedMedianMs = median(pass(pipelineWith(false)).times)
  const cold = pass(pipelineWith({ dir: cacheDir }))
  const coldNotFromCache = cold.records.filter((record) => !record.fromCache).length
  if (coldNotFromCache !== sources.length) failures.push('the cold pass was served from the cache')

  const warm = Array.from({ length: TIMED_PASSES }, () => pass(pipelineWith({ dir: cacheDir })))
  const medians = warm.map((one) => median(one.times))
  const warmMedianMs = median(medians)

  // The cache must be a cache: every warm record is a hit, and equal to the one the work made.
  let misses = 0
  let different = 0
  for (const one of warm) {
    one.records.forEach((record, index) => {
      if (!record.fromCache) misses++
      const original = uncached.records[index]
      const same =
        original !== undefined &&
        JSON.stringify({ ...record, fromCache: false }) ===
          JSON.stringify({ ...original, fromCache: false })
      if (!same) different++
    })
  }
  if (misses > 0) failures.push(`${misses} warm transforms missed the cache`)
  if (different > 0) failures.push(`${different} warm records differ from the uncached ones`)

  const maxWarmMs = args['max-warm-ms'] === undefined ? undefined : Number(args['max-warm-ms'])
  if (maxWarmMs !== undefined && warmMedianMs > maxWarmMs) {
    failures.push(`warm median ${warmMedianMs.toFixed(4)} ms/file is above ${maxWarmMs}`)
  }

  // B20 Q3: the whole warm route per ES module, `transform` (a hit) then the module-runner step as
  // the loader runs it. Three ways, interleaved file by file: (1) oxc's runner transform, which
  // production used before B20; (2) our transform, run on every warm hit; (3) the runner form read
  // from the cache (`runnerForm: true`), where the step is skipped.
  const formDir = mkdtempSync(join(tmpdir(), 'provino-transform-cache-bench-form-'))
  const route = {
    oxc: [] as number[][],
    ours: [] as number[][],
    cached: [] as number[][],
    esmFiles: 0,
  }
  try {
    const withForm = (): ReturnType<typeof createPipeline> =>
      createPipeline({
        root,
        typescript: 'oxc',
        tsconfig: 'auto',
        hoist: null,
        cache: { dir: formDir },
        runnerForm: true,
      })
    pass(withForm())
    const request = (filename: string, source: string) =>
      ({ filename, source, role: 'source', consumer: 'import', instrument: false }) as const
    const esm = sources.filter(({ filename, source }) => {
      const record = pipelineWith({ dir: cacheDir }).transform(request(filename, source))
      return record.format === 'esm'
    })
    for (let i = 0; i < TIMED_PASSES; i++) {
      const plain = pipelineWith({ dir: cacheDir })
      const form = withForm()
      const oxc: number[] = []
      const ours: number[] = []
      const cached: number[] = []
      for (const { filename, source } of esm) {
        let start = process.hrtime.bigint()
        const a = plain.transform(request(filename, source))
        moduleRunnerTransformSync(filename, a.code, { sourcemap: true })
        oxc.push(Number(process.hrtime.bigint() - start) / 1e6)
        start = process.hrtime.bigint()
        toModuleRunner(filename, plain.transform(request(filename, source)))
        ours.push(Number(process.hrtime.bigint() - start) / 1e6)
        start = process.hrtime.bigint()
        const c = form.transform(request(filename, source))
        toModuleRunner(filename, c)
        cached.push(Number(process.hrtime.bigint() - start) / 1e6)
        if (c.runner === undefined || !c.fromCache)
          failures.push(`${filename}: no cached runner form`)
      }
      route.oxc.push(oxc)
      route.ours.push(ours)
      route.cached.push(cached)
    }
    route.esmFiles = esm.length
  } finally {
    rmSync(formDir, { recursive: true, force: true })
  }
  const routeStats = (passes: number[][]) => ({
    median: Number(median(passes.map((times) => median(times))).toFixed(4)),
    mean: Number((passes.flat().reduce((a, b) => a + b, 0) / passes.flat().length).toFixed(4)),
  })

  const bytes = sources.reduce((sum, { source }) => sum + Buffer.byteLength(source), 0)
  const report = {
    label: 'local',
    node: process.version,
    commit: manifest.commit,
    files: sources.length,
    megabytes: Number((bytes / 1e6).toFixed(2)),
    uncachedMedianMsPerFile: Number(uncachedMedianMs.toFixed(4)),
    coldMedianMsPerFile: Number(median(cold.times).toFixed(4)),
    warmPassMediansMs: medians.map((value) => Number(value.toFixed(4))),
    warmMedianMsPerFile: Number(warmMedianMs.toFixed(4)),
    warmMeanMsPerFile: Number(
      (
        warm.flatMap((one) => one.times).reduce((a, b) => a + b, 0) /
        (warm.length * sources.length)
      ).toFixed(4),
    ),
    warmRoute: {
      esmFiles: route.esmFiles,
      oxcRunner: routeStats(route.oxc),
      ourRunner: routeStats(route.ours),
      cachedRunnerForm: routeStats(route.cached),
    },
    failures,
  }
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else {
    process.stdout.write(
      [
        `transform cache over the excalidraw corpus (local, Node ${process.version}, ${manifest.commit.slice(0, 7)})`,
        `  files ${report.files} (${report.megabytes} MB)`,
        `  no cache  median ${report.uncachedMedianMsPerFile} ms/file`,
        `  cold fill median ${report.coldMedianMsPerFile} ms/file`,
        `  warm      median ${report.warmMedianMsPerFile} ms/file (mean ${report.warmMeanMsPerFile}; passes: ${report.warmPassMediansMs.join(', ')})`,
        `  warm route (hit + runner step, ${report.warmRoute.esmFiles} ES modules, ms/file):`,
        `    oxc's runner transform (before B20)  median ${report.warmRoute.oxcRunner.median}  mean ${report.warmRoute.oxcRunner.mean}`,
        `    our transform, run on every hit      median ${report.warmRoute.ourRunner.median}  mean ${report.warmRoute.ourRunner.mean}`,
        `    runner form from the cache (Q3)      median ${report.warmRoute.cachedRunnerForm.median}  mean ${report.warmRoute.cachedRunnerForm.mean}`,
        ...failures.map((failure) => `FAIL ${failure}`),
        '',
      ].join('\n'),
    )
  }
} finally {
  rmSync(cacheDir, { recursive: true, force: true })
}
process.exitCode = failures.length === 0 ? 0 : 1
