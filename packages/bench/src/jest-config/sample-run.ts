// `pnpm bench:jest-config sample`: reads every manifest config with real jest-config 30.5.2 and
// with ours, and compares them (D28; `compare.ts` says what and how). Each read is a child process
// of its own, with its working directory the config's: the network guard preloaded, Node's
// permission model on (reads anywhere; writes only to the results directory; no child processes,
// no workers; native addons allowed, since both resolvers are native), the proxy variables
// cleared, and a timeout. A config jest-config can't read is "unreadable" and not compared.
//
// The bar: every readable config equal on the 55 keys, and at least 200 readable (D28: fewer stops
// the work for a report). Results go to `.refs/jest-config-sample/result.json`.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProcess } from '@provino/harness'
import { brief, compareReads, type KeyDifference } from './compare.ts'
import type { ReadOutcome } from './oracle.ts'
import type { SampleManifest } from './sample-manifest.ts'
import { MANIFEST_PATH, repoDir, SAMPLE_DIR } from './sample-paths.ts'
import type { SampleFormat } from './sample-select.ts'

/** D28's floor: fewer readable configs than this stops the work. */
export const MIN_READABLE = 200

/** One config's result. */
export interface SampleResult {
  readonly id: string
  readonly repo: string
  readonly path: string
  readonly format: SampleFormat
  readonly fetched: boolean
  readonly jest: ReadOutcome | null
  readonly provino: ReadOutcome | null
  readonly bar: readonly KeyDifference[]
  readonly other: readonly KeyDifference[]
}

const PROBE = fileURLToPath(new URL('sample-probe.ts', import.meta.url))
const GUARD = pathToFileURL(fileURLToPath(new URL('network-guard.ts', import.meta.url))).href

/** The child's environment: the parent's, with every proxy variable and NODE_OPTIONS removed. */
function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/proxy/i.test(key) || key === 'NODE_OPTIONS' || key === 'NODE_USE_ENV_PROXY') continue
    env[key] = value
  }
  return env
}

async function readSide(
  side: 'jest' | 'provino',
  config: string,
  resultsDir: string,
  id: string,
  timeoutMs: number,
): Promise<ReadOutcome> {
  const out = join(resultsDir, `${id}.${side}.json`)
  rmSync(out, { force: true })
  const result = await runProcess(
    process.execPath,
    [
      '--conditions=provino-source',
      '--permission',
      '--allow-fs-read=*',
      `--allow-fs-write=${resultsDir}`,
      '--allow-addons',
      '--import',
      GUARD,
      PROBE,
      side,
      config,
      out,
    ],
    { cwd: dirname(config), env: childEnvironment(), timeoutMs, tailChars: 2000 },
  )
  if (existsSync(out)) return JSON.parse(readFileSync(out, 'utf8')) as ReadOutcome
  const why = result.timedOut
    ? `timed out after ${timeoutMs} ms`
    : `exited ${result.exitCode ?? result.signal} with no result: ${result.output.trim().slice(-400)}`
  return { ok: false, error: why, code: result.timedOut ? 'TIMEOUT' : 'NO_RESULT' }
}

function idOf(repo: string, path: string): string {
  return `${repo.replace('/', '__')}__${path.replaceAll('/', '__')}`
}

/** The step. */
export async function runSample(options: {
  readonly log: (line: string) => void
  readonly concurrency: number
  readonly timeoutMs: number
  readonly only?: string
}): Promise<number> {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as SampleManifest
  const resultsDir = join(SAMPLE_DIR, 'results')
  mkdirSync(resultsDir, { recursive: true })
  const entries = manifest.repos.flatMap((repo) =>
    repo.configs.map((config) => ({ repo: repo.repo, ...config })),
  )
  const selected = entries.filter(
    (entry) =>
      options.only === undefined ||
      entry.repo === options.only ||
      `${entry.repo}:${entry.path}` === options.only,
  )
  const results: SampleResult[] = []
  const queue = [...selected]
  const workers = Array.from({ length: options.concurrency }, async () => {
    for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
      const id = idOf(entry.repo, entry.path)
      const config = join(repoDir(entry.repo), entry.path)
      const fetched = existsSync(config)
      if (!fetched) {
        results.push({ id, ...entry, fetched, jest: null, provino: null, bar: [], other: [] })
        continue
      }
      const jest = await readSide('jest', config, resultsDir, id, options.timeoutMs)
      const provino = await readSide('provino', config, resultsDir, id, options.timeoutMs)
      const { bar, other } =
        jest.ok && provino.ok ? compareReads(provino.read, jest.read) : { bar: [], other: [] }
      results.push({ id, ...entry, fetched, jest, provino, bar, other })
    }
  })
  await Promise.all(workers)
  results.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  writeFileSync(join(SAMPLE_DIR, 'result.json'), `${JSON.stringify(results, null, 2)}\n`)

  const fetched = results.filter((result) => result.fetched)
  const readable = fetched.filter((result) => result.jest?.ok === true)
  const oursFailed = readable.filter((result) => result.provino?.ok !== true)
  const barEqual = readable.filter(
    (result) => result.provino?.ok === true && result.bar.length === 0,
  )
  const allEqual = barEqual.filter((result) => result.other.length === 0)
  const unreadableBoth = fetched.filter(
    (result) => result.jest?.ok !== true && result.provino?.ok !== true,
  )
  const oursOnly = fetched.filter(
    (result) => result.jest?.ok !== true && result.provino?.ok === true,
  )
  const byFormat = new Map<string, { readable: number; equal: number; total: number }>()
  for (const result of fetched) {
    const row = byFormat.get(result.format) ?? { readable: 0, equal: 0, total: 0 }
    row.total++
    if (result.jest?.ok === true) row.readable++
    if (barEqual.includes(result)) row.equal++
    byFormat.set(result.format, row)
  }
  const lines = [
    `jest-config sample (local, Node ${process.version}, manifest ${manifest.generated}, ${manifest.repos.length} repositories)`,
    `  configs: ${selected.length} in the manifest${options.only === undefined ? '' : ` (--only ${options.only})`}, ${fetched.length} fetched`,
    `  readable by jest-config: ${readable.length}   (unreadable: ${fetched.length - readable.length}; of those, ours also fails on ${unreadableBoth.length} and reads ${oursOnly.length})`,
    `  equal on the 55 keys: ${barEqual.length} of ${readable.length}   (ours failed on ${oursFailed.length})`,
    `  equal on every key: ${allEqual.length} of ${readable.length}`,
    `  by format: ${[...byFormat.entries()].map(([format, row]) => `${format} ${row.equal}/${row.readable}/${row.total}`).join(', ')} (equal/readable/fetched)`,
  ]
  for (const result of readable) {
    if (result.provino?.ok !== true) {
      lines.push(
        `  FAIL ${result.repo}:${result.path}: ours failed: ${(result.provino as { error?: string } | null)?.error?.split('\n').slice(0, 3).join(' ⏎ ')}`,
      )
      continue
    }
    for (const difference of result.bar) {
      lines.push(
        `  FAIL ${result.repo}:${result.path}: ${difference.key}: ours ${brief(difference.ours)} jest ${brief(difference.theirs)}`,
      )
    }
  }
  const otherKeys = new Map<string, number>()
  for (const result of barEqual) {
    for (const difference of result.other)
      otherKeys.set(difference.key, (otherKeys.get(difference.key) ?? 0) + 1)
  }
  if (otherKeys.size > 0) {
    lines.push(
      `  outside the bar, keys that differ (configs): ${[...otherKeys.entries()].map(([key, count]) => `${key} ${count}`).join(', ')}`,
    )
  }
  const enough = options.only !== undefined || readable.length >= MIN_READABLE
  if (!enough)
    lines.push(
      `STOP fewer than ${MIN_READABLE} configs are readable (${readable.length}); D28 says report`,
    )
  const pass = enough && barEqual.length === readable.length
  lines.push(pass ? 'PASS every readable config is equal on the 55 keys' : 'FAIL')
  lines.push(`wrote ${join(SAMPLE_DIR, 'result.json')}`)
  options.log(lines.join('\n'))
  return pass ? 0 : 1
}
