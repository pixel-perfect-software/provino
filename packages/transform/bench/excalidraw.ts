// T3.5's acceptance corpus: every `.ts`/`.tsx` file under 200,000 bytes in excalidraw at the
// research commit (Track 3 F3; the count differs from the research's, see
// docs/plan/bundles/B05.md → Corpora). The file list is committed as `fixtures/excalidraw.json`.
// The source lives in `.refs/excalidraw` (GitHub's tarball of that commit; CI downloads it).
//
// Usage: node --conditions=provino-source packages/transform/bench/excalidraw.ts
//          [--root <dir>] [--max-median-ms 0.5] [--write-manifest] [--json]
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { createPipeline } from '@provino/transform'
import {
  DEFAULT_ROOT,
  MANIFEST_PATH,
  type Manifest,
  median,
  parseBar,
  parseOrExitUsage,
  readManifest,
  readSources,
} from './corpus.ts'

const REPO = 'excalidraw/excalidraw'
const COMMIT = 'b99a49dbebd25fbf85ad9ae33c9e361a16d5a39e'
const RULE = '.ts and .tsx files under 200,000 bytes, outside node_modules'
const MAX_BYTES = 200_000
const TIMED_PASSES = 3

const args = parseOrExitUsage('bench:excalidraw', () => {
  const { values } = parseArgs({
    options: {
      root: { type: 'string', default: DEFAULT_ROOT },
      'max-median-ms': { type: 'string' },
      'write-manifest': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  })
  return { ...values, maxMedianMs: parseBar('max-median-ms', values['max-median-ms']) }
})
const root = args.root

function listCorpus(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...listCorpus(path))
    else if (/\.tsx?$/.test(entry.name) && statSync(path).size < MAX_BYTES) {
      files.push(relative(root, path).split(sep).join('/'))
    }
  }
  return files.sort()
}

if (args['write-manifest']) {
  const manifest: Manifest = { repo: REPO, commit: COMMIT, rule: RULE, files: listCorpus(root) }
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`wrote ${manifest.files.length} files to ${MANIFEST_PATH}\n`)
  process.exit(0)
}

const manifest = readManifest()
const sources = readSources(root, manifest)
const pipeline = createPipeline({
  root,
  typescript: 'oxc',
  tsconfig: 'auto',
  hoist: null,
  cache: false,
})

/** One pass over the corpus: per-file times in ms, and the files with errors. */
function pass(): { readonly times: number[]; readonly failed: string[] } {
  const times: number[] = []
  const failed: string[] = []
  for (const { filename, source } of sources) {
    const start = process.hrtime.bigint()
    try {
      const record = pipeline.transform({
        filename,
        source,
        role: 'source',
        consumer: 'import',
        instrument: false,
      })
      times.push(Number(process.hrtime.bigint() - start) / 1e6)
      const errors = record.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
      if (errors.length > 0) failed.push(`${relative(root, filename)}: ${errors[0]?.message}`)
    } catch (error) {
      failed.push(`${relative(root, filename)}: threw ${String(error)}`)
    }
  }
  return { times, failed }
}

const warmup = pass()
const medians = Array.from({ length: TIMED_PASSES }, () => median(pass().times))
const medianMs = median(medians)
const bytes = sources.reduce((sum, { source }) => sum + Buffer.byteLength(source), 0)
const maxMedianMs = args.maxMedianMs

const failures: string[] = []
if (warmup.failed.length > 0) failures.push(`${warmup.failed.length} files failed`)
if (maxMedianMs !== undefined && !(medianMs <= maxMedianMs)) {
  failures.push(`median ${medianMs.toFixed(3)} ms/file is above ${maxMedianMs}`)
}

const report = {
  label: 'local',
  node: process.version,
  commit: manifest.commit,
  files: sources.length,
  megabytes: Number((bytes / 1e6).toFixed(2)),
  failed: warmup.failed,
  passMediansMs: medians.map((value) => Number(value.toFixed(3))),
  medianMsPerFile: Number(medianMs.toFixed(3)),
  failures,
}
if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
else {
  process.stdout.write(
    [
      `excalidraw corpus (local, Node ${process.version}, ${manifest.commit.slice(0, 7)})`,
      `  files ${sources.length} (${report.megabytes} MB), failed ${warmup.failed.length}`,
      ...warmup.failed.map((line) => `    ${line}`),
      `  median ${medianMs.toFixed(3)} ms/file (median of ${TIMED_PASSES} passes: ${report.passMediansMs.join(', ')})`,
      ...failures.map((failure) => `FAIL ${failure}`),
      '',
    ].join('\n'),
  )
}
process.exitCode = failures.length === 0 ? 0 : 1
