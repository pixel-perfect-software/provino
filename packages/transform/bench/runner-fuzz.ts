// T2.4's acceptance check: 10,000 generated TypeScript files go through the pipeline and then the
// guarded module-runner transform (`toModuleRunner`) in this one process. The TS conformance
// corpus isn't vendored, so the brief's fallback applies: a seeded generator mixes TS constructs,
// including type-only re-exports (oxc's runner transform aborts the process on those when they
// are left unstripped), and makes 2% of the files deliberately broken.
// Bar: the process finishes, and every failure comes back as a per-file error naming the file.
//
// Usage: node --conditions=provino-source packages/transform/bench/runner-fuzz.ts
//          [--files 10000] [--seed 1] [--json]
import { parseArgs } from 'node:util'
import { createPipeline, TransformError, toModuleRunner } from '@provino/transform'
import { generateFuzzCorpus } from './fuzz-corpus.ts'

const { values: args } = parseArgs({
  options: {
    files: { type: 'string', default: '10000' },
    seed: { type: 'string', default: '1' },
    json: { type: 'boolean', default: false },
  },
})
const FILES = Number(args.files)

const corpus = generateFuzzCorpus(FILES, Number(args.seed))

const pipeline = createPipeline({
  root: '/fuzz',
  typescript: 'oxc',
  tsconfig: false,
  hoist: null,
  cache: false,
})

const failures: { readonly file: string; readonly stage: string; readonly message: string }[] = []
const uncoded: string[] = []
let transformed = 0
const start = process.hrtime.bigint()
for (const file of corpus) {
  try {
    const record = pipeline.transform({
      filename: file.filename,
      source: file.source,
      role: 'test',
      consumer: 'import',
      instrument: false,
    })
    const error = record.diagnostics.find((diagnostic) => diagnostic.severity === 'error')
    if (error !== undefined) {
      failures.push({ file: file.filename, stage: 'strip', message: error.message })
      continue
    }
    toModuleRunner(file.filename, record)
    transformed++
  } catch (error) {
    if (error instanceof TransformError && error.message.includes(file.filename)) {
      failures.push({ file: file.filename, stage: 'runner', message: error.message })
    } else uncoded.push(`${file.filename}: ${String(error)}`)
  }
}
const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6

const failed = new Set(failures.map((failure) => failure.file))
const brokenFiles = corpus.filter((file) => file.broken)
// Two `export default`s are invalid JavaScript: a generator accident (B20) that oxc's runner
// transform let through by parsing the stripped code as TypeScript, and ours reports per file.
const duplicateFiles = corpus.filter((file) => !file.broken && file.duplicateDefault)
const expectedFiles = new Set([...brokenFiles, ...duplicateFiles].map((file) => file.filename))
const brokenMissed = [...brokenFiles, ...duplicateFiles].filter(
  (file) => !failed.has(file.filename),
)
const unexpected = failures.filter((failure) => !expectedFiles.has(failure.file))
const problems: string[] = []
if (brokenMissed.length > 0) problems.push(`${brokenMissed.length} broken files were not reported`)
if (uncoded.length > 0)
  problems.push(`${uncoded.length} failures were not per-file TransformErrors`)

const report = {
  label: 'local',
  node: process.version,
  files: corpus.length,
  transformed,
  failedPerFile: failures.length,
  brokenOnPurpose: brokenFiles.length,
  unexpectedFailures: unexpected.slice(0, 20),
  uncoded: uncoded.slice(0, 20),
  elapsedMs: Math.round(elapsedMs),
  problems,
}
if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
else {
  process.stdout.write(
    [
      `runner fuzz (local, Node ${process.version}, seed ${args.seed})`,
      `  files ${corpus.length}: transformed ${transformed}, failed per file ${failures.length} (${brokenFiles.length} broken on purpose, ${duplicateFiles.length} with two default exports)`,
      `  unexpected failures ${unexpected.length}`,
      ...unexpected.slice(0, 10).map((failure) => `    ${failure.stage} ${failure.message}`),
      `  ${Math.round(elapsedMs)} ms total; the process did not abort`,
      ...problems.map((problem) => `FAIL ${problem}`),
      '',
    ].join('\n'),
  )
}
process.exitCode = problems.length === 0 ? 0 : 1
