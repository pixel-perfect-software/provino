// `pnpm bench:vitest-config sample`: reads every manifest config with Vitest 5.0.5's
// `resolveConfig` and with ours, and compares the 30 most-used `test.*` keys (D28's terms;
// `compare.ts` says what and how). Each read is a child process of its own, with its working
// directory the config's: the network guard preloaded, Node's permission model on (reads
// anywhere; writes only to the results directory and the sample's own tree, where Vite writes
// its bundled config; native addons allowed), the proxy variables cleared, and a timeout. A config
// Vitest can't read is "unreadable" and not compared. No timing is taken.
//
// The bar: every readable config that needs no Vite plugin and that we don't refuse by design
// equal on the compared keys, and at least 200 readable (D28: fewer stops the work for a report).
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProcess } from '@provino/harness'
import { brief, type KeyDifference } from '../jest-config/compare.ts'
import { compareTest, TEST_BAR_KEYS } from './compare.ts'
import type { ProvinoOutcome, ReadOutcome } from './oracle.ts'
import type { SampleManifest } from './sample-manifest.ts'
import { MANIFEST_PATH, repoDir, SAMPLE_DIR } from './sample-paths.ts'
import type { SampleKind } from './sample-select.ts'

/** D28's floor: fewer readable configs than this stops the work. */
export const MIN_READABLE = 200

/** One config's result. */
export interface SampleResult {
  readonly id: string
  readonly repo: string
  readonly path: string
  readonly kind: SampleKind
  readonly fetched: boolean
  readonly vitest: ReadOutcome | null
  readonly provino: ProvinoOutcome | null
  readonly compared: readonly string[]
  readonly differences: readonly KeyDifference[]
}

const PROBE = fileURLToPath(new URL('sample-probe.ts', import.meta.url))
const GUARD = pathToFileURL(
  fileURLToPath(new URL('../jest-config/network-guard.ts', import.meta.url)),
).href

/** Variables std-env reads to tell an agent's shell or a CI provider: both sides run without them. */
const AGENT_VARIABLE = /^(CLAUDE|AI_AGENT|CURSOR_|CODEX|GEMINI_CLI|OPENCODE|AMP_|GITHUB_ACTIONS)/

/** The child's environment: the parent's, with every proxy variable and NODE_OPTIONS removed. */
function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/proxy/i.test(key) || key === 'NODE_OPTIONS' || key === 'NODE_USE_ENV_PROXY') continue
    // Vitest's defaults follow the agent and CI-provider variables (its reporter becomes `minimal`).
    if (AGENT_VARIABLE.test(key)) continue
    env[key] = value
  }
  return env
}

async function readSide<T extends ReadOutcome>(
  sampleDir: string,
  side: 'vitest' | 'provino' | 'defaults',
  target: string,
  cwd: string,
  resultsDir: string,
  id: string,
  timeoutMs: number,
): Promise<T | Extract<ReadOutcome, { ok: false }>> {
  const out = join(resultsDir, `${id}.${side}.json`)
  rmSync(out, { force: true })
  const result = await runProcess(
    process.execPath,
    [
      '--conditions=provino-source',
      '--permission',
      '--allow-fs-read=*',
      `--allow-fs-write=${resultsDir}`,
      `--allow-fs-write=${sampleDir}`,
      '--allow-addons',
      '--allow-worker',
      '--import',
      GUARD,
      PROBE,
      side,
      target,
      out,
    ],
    { cwd, env: childEnvironment(), timeoutMs, tailChars: 2000 },
  )
  if (existsSync(out)) return JSON.parse(readFileSync(out, 'utf8')) as T
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
  // Real paths throughout: the permission model matches real paths, and Vitest's root is `process.cwd()`.
  mkdirSync(SAMPLE_DIR, { recursive: true })
  const sampleDir = realpathSync(SAMPLE_DIR)
  const resultsDir = join(sampleDir, 'results')
  mkdirSync(resultsDir, { recursive: true })
  // What Vitest resolves for a directory with no config: a key equal to it was not set.
  const emptyRoot = join(sampleDir, 'empty-root')
  mkdirSync(emptyRoot, { recursive: true })
  const defaults = await readSide(
    sampleDir,
    'defaults',
    emptyRoot,
    emptyRoot,
    resultsDir,
    'defaults',
    options.timeoutMs,
  )
  if (!defaults.ok) {
    options.log(`FAIL can't resolve Vitest's defaults: ${defaults.error.slice(0, 400)}`)
    return 1
  }
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
      const unresolved = join(repoDir(entry.repo), entry.path)
      if (!existsSync(unresolved)) {
        results.push({
          id,
          ...entry,
          fetched: false,
          vitest: null,
          provino: null,
          compared: [],
          differences: [],
        })
        continue
      }
      // The child's working directory is a real path: Vitest's root is `process.cwd()`.
      const config = realpathSync(unresolved)
      const cwd = dirname(config)
      const vitest = await readSide<ReadOutcome>(
        sampleDir,
        'vitest',
        config,
        cwd,
        resultsDir,
        id,
        options.timeoutMs,
      )
      const provino = await readSide<ProvinoOutcome>(
        sampleDir,
        'provino',
        config,
        cwd,
        resultsDir,
        id,
        options.timeoutMs,
      )
      const comparison =
        vitest.ok && provino.ok && !provino.needsVite
          ? compareTest(
              provino.test,
              vitest.test,
              vitest.root,
              defaults.test,
              defaults.root,
              new Set(provino.given),
              vitest.alias,
            )
          : { compared: [], differences: [] }
      results.push({ id, ...entry, fetched: true, vitest, provino, ...comparison })
    }
  })
  await Promise.all(workers)
  results.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  writeFileSync(join(SAMPLE_DIR, 'result.json'), `${JSON.stringify(results, null, 2)}\n`)

  const fetched = results.filter((result) => result.fetched)
  const readable = fetched.filter((result) => result.vitest?.ok === true)
  const refused = readable.filter(
    (result) => result.provino?.ok === false && result.provino.code === 'VITEST_CONFIG_UNSUPPORTED',
  )
  const needsVite = readable.filter(
    (result) => result.provino?.ok === true && result.provino.needsVite,
  )
  const oursFailed = readable.filter(
    (result) => result.provino?.ok !== true && !refused.includes(result),
  )
  const judged = readable.filter(
    (result) => result.provino?.ok === true && !result.provino.needsVite,
  )
  const equal = judged.filter((result) => result.differences.length === 0)
  const perKey = new Map<string, { compared: number; equal: number }>(
    TEST_BAR_KEYS.map((key) => [key, { compared: 0, equal: 0 }]),
  )
  for (const result of judged) {
    for (const key of result.compared) {
      const row = perKey.get(key)
      if (row === undefined) continue
      row.compared++
      if (!result.differences.some((difference) => difference.key === key)) row.equal++
    }
  }
  const lines = [
    `vitest-config sample (local, Node ${process.version}, manifest ${manifest.generated}, ${manifest.repos.length} repositories)`,
    `  configs: ${selected.length} in the manifest${options.only === undefined ? '' : ` (--only ${options.only})`}, ${fetched.length} fetched`,
    `  readable by Vitest's resolveConfig: ${readable.length}   (unreadable: ${fetched.length - readable.length})`,
    `  compared (readable, no plugins, not refused): ${judged.length}   (needs Vite, B25d: ${needsVite.length}; refused by design: ${refused.length}; ours failed: ${oursFailed.length})`,
    `  equal on every compared key: ${equal.length} of ${judged.length}`,
    '  per key (configs that set it: equal/compared):',
    ...[...perKey.entries()].map(([key, row]) => `    ${key}: ${row.equal}/${row.compared}`),
  ]
  for (const result of oursFailed) {
    const error = result.provino?.ok === false ? result.provino.error : 'no result'
    lines.push(
      `  FAIL ${result.repo}:${result.path}: ours failed: ${error.split('\n').slice(0, 2).join(' ⏎ ').slice(0, 300)}`,
    )
  }
  for (const result of judged) {
    for (const difference of result.differences) {
      lines.push(
        `  FAIL ${result.repo}:${result.path}: ${difference.key}: ours ${brief(difference.ours)} vitest ${brief(difference.theirs)}`,
      )
    }
  }
  const enough = options.only !== undefined || readable.length >= MIN_READABLE
  if (!enough) {
    lines.push(
      `STOP fewer than ${MIN_READABLE} configs are readable (${readable.length}); D28 says report`,
    )
  }
  const pass = enough && oursFailed.length === 0 && equal.length === judged.length
  lines.push(pass ? 'PASS every compared config is equal on the compared keys' : 'FAIL')
  lines.push(`wrote ${join(SAMPLE_DIR, 'result.json')}`)
  options.log(lines.join('\n'))
  return pass ? 0 : 1
}
