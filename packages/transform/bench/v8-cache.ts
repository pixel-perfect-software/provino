// T3.7's bench: what a V8 code cache saves on compiling a large script, rebuilt from the research
// spike (`bench-cached-data.mjs`): `typescript/lib/typescript.js` (9 MB) compiled in a fresh
// process, without a cache and through `createV8Cache(...).loadScript` against a directory a first,
// discarded process filled. Compile time is measured inside each child with `performance.now()`
// (the cached variant includes reading the entry); each child then runs the script's top level,
// reported as a second line. The two variants are interleaved (no cache, cached, no cache, ...),
// `--runs` of each (default 5), every one a fresh process, and the medians are printed with every
// sample. The research's number (`local`): 130 ms without, 20 ms with, 6.8x. Every number is `local`.
//
// Usage: node --conditions=provino-source packages/transform/bench/v8-cache.ts
//          [--runs 5] [--min-speedup 5]
// Exit 0 when no bar is missed (or none is set), 1 when the median compile ratio is below
// `--min-speedup` or a child fails (a cached run that V8 didn't accept fails loudly), 2 on usage.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { constants, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { median, parseBar, parseOrExitUsage, parsePositiveInt } from './corpus.ts'

const DEFAULT_RUNS = 5

// Parsed before any work, so a mistyped flag stops the run.
const args = parseOrExitUsage('bench:v8-cache', () => {
  const { values } = parseArgs({
    options: {
      runs: { type: 'string', default: String(DEFAULT_RUNS) },
      'min-speedup': { type: 'string' },
    },
  })
  return {
    runs: parsePositiveInt('runs', values.runs),
    minSpeedup: parseBar('min-speedup', values['min-speedup']),
  }
})

const require = createRequire(import.meta.url)
const scriptPath = require.resolve('typescript/lib/typescript.js')
const scriptVersion = (require('typescript/package.json') as { version: string }).version
const code = readFileSync(scriptPath, 'utf8')
// What the transform record's cache key is: a hash of exactly this text.
const key = createHash('sha256').update(code).digest('hex').slice(0, 32)
const child = fileURLToPath(new URL('v8-cache-child.ts', import.meta.url))

const dir = mkdtempSync(join(tmpdir(), 'provino-v8-cache-bench-'))
let current: ReturnType<typeof spawn> | undefined
function cleanUp(): void {
  current?.kill('SIGKILL')
  rmSync(dir, { recursive: true, force: true })
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    cleanUp()
    process.exit(128 + constants.signals[signal])
  })
}

interface Sample {
  readonly compileMs: number
  readonly runMs: number
}

/** One fresh process; waited for, so none outlives the run. */
function measure(variant: 'plain' | 'fill' | 'cached'): Promise<Sample> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ['--conditions=provino-source', child, variant, dir, scriptPath, key],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    current = proc
    let out = ''
    let err = ''
    proc.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk
    })
    proc.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      err += chunk
    })
    proc.on('error', reject)
    proc.on('close', (status) => {
      current = undefined
      if (status !== 0) {
        reject(new Error(`the ${variant} child exited ${String(status)}:\n${err}${out}`))
        return
      }
      resolve(JSON.parse(out) as Sample)
    })
  })
}

function entrySizeMb(): number {
  let largest = 0
  for (const name of readdirSync(dir, { recursive: true })) {
    const size = statSync(join(dir, String(name)), { throwIfNoEntry: false })
    if (size?.isFile() && String(name).endsWith(key)) largest = size.size
  }
  return largest / 1e6
}

const plain: Sample[] = []
const cached: Sample[] = []
const failures: string[] = []
let entryMb = 0
try {
  // The first process fills the directory; its timings are discarded.
  await measure('fill')
  entryMb = entrySizeMb()
  for (let run = 0; run < args.runs; run++) {
    plain.push(await measure('plain'))
    cached.push(await measure('cached'))
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
} finally {
  cleanUp()
}

const fixed = (values: readonly number[]): string => values.map((v) => v.toFixed(1)).join(' ')
if (failures.length === 0) {
  const compile = (samples: readonly Sample[]): number[] => samples.map((s) => s.compileMs)
  const total = (samples: readonly Sample[]): number[] => samples.map((s) => s.compileMs + s.runMs)
  const ratio = median(compile(plain)) / median(compile(cached))
  const lines = [
    `v8-cache bench (local, Node ${process.version}, V8 ${process.versions.v8}, ${process.platform} ${process.arch}; ${args.runs} fresh processes per variant, interleaved, median; typescript ${scriptVersion} lib/typescript.js ${(code.length / 1e6).toFixed(1)} MB, cache entry ${entryMb.toFixed(1)} MB)`,
    `  compile, no cache        ${median(compile(plain)).toFixed(1).padStart(8)} ms   (${fixed(compile(plain))})`,
    `  compile, cachedData      ${median(compile(cached)).toFixed(1).padStart(8)} ms   (${fixed(compile(cached))})`,
    `  ratio (no cache / cached) ${ratio.toFixed(2).padStart(7)}x${args.minSpeedup === undefined ? '' : `   (bar >= ${args.minSpeedup}x)`}`,
    `  compile + top level, no cache   ${median(total(plain)).toFixed(1).padStart(8)} ms   (${fixed(total(plain))})`,
    `  compile + top level, cachedData ${median(total(cached)).toFixed(1).padStart(8)} ms   (${fixed(total(cached))})`,
    '  compile is `new vm.Script` against `createV8Cache(...).loadScript` (entry read included); the research spike measured 130 ms and 20 ms (6.8x), `local`',
  ]
  if (args.minSpeedup !== undefined && !(ratio >= args.minSpeedup)) {
    failures.push(`median compile ratio ${ratio.toFixed(2)}x is below ${args.minSpeedup}x`)
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}
for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`)
process.exitCode = failures.length === 0 ? 0 : 1
