// D116: the in-place TypeScript strip (`typescript: 'blank'`) on the corpora.
//
// `check`: for every file of the fuzz corpus (`--files`, seeded), the statement-tail ASI corpus
// (`generateAsiCorpus`) and the excalidraw corpus (`.refs/excalidraw`, when it is there) that the
// strip blanks, the blanked text prints as the same JavaScript as Oxc's TypeScript transform gives, and every kept character keeps its offset;
// with `verbatimModuleSyntax` off (imports elided) and on. Exit 1 on a difference.
// `speed`: `createPipeline` with `typescript: 'blank'` against `'oxc'` (no hoisting, no cache: the
// strip, the source map Oxc makes and the import facts both read), file by file over the excalidraw
// `.ts` files the strip blanks, interleaved with the first side alternating by file and pass; one
// discarded pass, then `--passes`; the median ms per file of each, `local`. No bar (D116 asks for
// the medians).
//
// Usage: node --conditions=provino-source packages/transform/bench/blank.ts check|speed
//          [--files 10000] [--seed 1] [--passes 7] [--root <dir>]
import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import type { Pipeline } from '@provino/types'
import {
  BLANKED_FILE,
  type BlankCorpusReport,
  blankPipelines,
  type CorpusFile,
  checkBlankCorpus,
  generateAsiCorpus,
} from './blank-corpus.ts'
import {
  DEFAULT_ROOT,
  median,
  parseOrExitUsage,
  parsePositiveInt,
  readSources,
  UsageError,
} from './corpus.ts'
import { generateFuzzCorpus } from './fuzz-corpus.ts'

const args = parseOrExitUsage('bench:blank', () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      files: { type: 'string', default: '10000' },
      seed: { type: 'string', default: '1' },
      passes: { type: 'string', default: '7' },
      root: { type: 'string', default: DEFAULT_ROOT },
    },
  })
  const command = positionals[0]
  if (command !== 'check' && command !== 'speed') throw new UsageError('give `check` or `speed`')
  return {
    command,
    files: parsePositiveInt('files', values.files),
    seed: parsePositiveInt('seed', values.seed),
    passes: parsePositiveInt('passes', values.passes),
    root: values.root,
  }
})

function excalidraw(): readonly CorpusFile[] | null {
  return existsSync(args.root) ? readSources(args.root) : null
}

function printReport(name: string, report: BlankCorpusReport): boolean {
  const lines = [
    `${name}: ${report.requested} TypeScript files, ${report.valid} valid, ${report.blanked} blanked (${report.valid - report.blanked} fall back), ${report.different.length} different, ${report.moved.length} moved`,
    ...report.different.slice(0, 20).map((line) => `  DIFFERENT ${line}`),
    ...report.moved.slice(0, 20).map((line) => `  MOVED ${line}`),
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
  return report.different.length === 0 && report.moved.length === 0 && report.blanked > 0
}

function transformOne(pipeline: Pipeline, file: CorpusFile): void {
  pipeline.transform({
    filename: file.filename,
    source: file.source,
    role: 'source',
    consumer: 'import',
    instrument: false,
  })
}

if (args.command === 'check') {
  const corpora: [string, readonly CorpusFile[]][] = [
    [`fuzz (${args.files}, seed ${args.seed})`, generateFuzzCorpus(args.files, args.seed)],
    ['statement-tail ASI', generateAsiCorpus()],
  ]
  const real = excalidraw()
  if (real === null) process.stdout.write(`excalidraw: skipped, ${args.root} is not there\n`)
  else corpora.push(['excalidraw', real])
  let ok = true
  for (const [name, files] of corpora) {
    for (const verbatimModuleSyntax of [false, true]) {
      using pipelines = blankPipelines({ verbatimModuleSyntax })
      const mode = verbatimModuleSyntax ? 'verbatimModuleSyntax' : 'imports elided'
      ok = printReport(`${name}, ${mode}`, checkBlankCorpus(files, pipelines)) && ok
    }
  }
  process.exitCode = ok ? 0 : 1
} else {
  const real = excalidraw()
  if (real === null) {
    process.stderr.write(`bench:blank speed needs ${args.root}\n`)
    process.exit(2)
  }
  using pipelines = blankPipelines({})
  const typescript = real.filter(({ filename }) => BLANKED_FILE.test(filename))
  // The files the strip takes: its record has no map.
  const files = typescript.filter(
    (file) =>
      pipelines.blank.transform({
        filename: file.filename,
        source: file.source,
        role: 'source',
        consumer: 'import',
        instrument: false,
      }).map === null,
  )
  const time = (pipeline: Pipeline, file: CorpusFile): number => {
    const start = process.hrtime.bigint()
    transformOne(pipeline, file)
    return Number(process.hrtime.bigint() - start) / 1e6
  }
  const blankTimes: number[] = []
  const oxcTimes: number[] = []
  const blankPasses: number[] = []
  const oxcPasses: number[] = []
  for (let pass = 0; pass <= args.passes; pass++) {
    const blankPass: number[] = []
    const oxcPass: number[] = []
    files.forEach((file, index) => {
      const blankFirst = (index + pass) % 2 === 0
      const first = time(blankFirst ? pipelines.blank : pipelines.oxc, file)
      const second = time(blankFirst ? pipelines.oxc : pipelines.blank, file)
      blankPass.push(blankFirst ? first : second)
      oxcPass.push(blankFirst ? second : first)
    })
    // The first pass warms both up and is discarded.
    if (pass === 0) continue
    blankTimes.push(...blankPass)
    oxcTimes.push(...oxcPass)
    blankPasses.push(median(blankPass))
    oxcPasses.push(median(oxcPass))
  }
  const blankMs = median(blankTimes)
  const oxcMs = median(oxcTimes)
  const round = (value: number): number => Number(value.toFixed(4))
  process.stdout.write(
    `${JSON.stringify({
      label: 'local',
      node: process.version,
      files: files.length,
      of: typescript.length,
      passes: args.passes,
      blankMedianMs: round(blankMs),
      oxcMedianMs: round(oxcMs),
      ratio: Number((blankMs / oxcMs).toFixed(3)),
      blankPassMediansMs: blankPasses.map(round),
      oxcPassMediansMs: oxcPasses.map(round),
    })}\n`,
  )
}
