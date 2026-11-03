// T3.5's acceptance corpus: every `.ts`/`.tsx` file under 200,000 bytes in excalidraw at the
// research commit (Track 3 F3; the count differs from the research's, see
// docs/plan/bundles/B05.md → Corpora). The file list is committed as `fixtures/excalidraw.json`.
// The source lives in `.refs/excalidraw` (GitHub's tarball of that commit; CI downloads it).
//
// Usage: node --conditions=provino-source packages/transform/bench/excalidraw.ts
//          [--root <dir>] [--max-median-ms 0.5] [--write-manifest] [--json]
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createPipeline } from '@provino/transform'

const REPO = 'excalidraw/excalidraw'
const COMMIT = 'b99a49dbebd25fbf85ad9ae33c9e361a16d5a39e'
const RULE = '.ts and .tsx files under 200,000 bytes, outside node_modules'
const MAX_BYTES = 200_000
const TIMED_PASSES = 3

interface Manifest {
  readonly repo: string
  readonly commit: string
  readonly rule: string
  readonly files: readonly string[]
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const manifestPath = fileURLToPath(new URL('../fixtures/excalidraw.json', import.meta.url))
const { values: args } = parseArgs({
  options: {
    root: { type: 'string', default: join(repoRoot, '.refs/excalidraw') },
    'max-median-ms': { type: 'string' },
    'write-manifest': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
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
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`wrote ${manifest.files.length} files to ${manifestPath}\n`)
  process.exit(0)
}

const manifest: Manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const sources = manifest.files.map((file) => ({
  filename: join(root, file),
  source: readFileSync(join(root, file), 'utf8'),
}))
const pipeline = createPipeline({
  root,
  typescript: 'oxc',
  tsconfig: 'auto',
  hoist: null,
  cache: false,
})

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

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
const maxMedianMs = args['max-median-ms'] === undefined ? undefined : Number(args['max-median-ms'])

const failures: string[] = []
if (warmup.failed.length > 0) failures.push(`${warmup.failed.length} files failed`)
if (maxMedianMs !== undefined && medianMs > maxMedianMs) {
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
