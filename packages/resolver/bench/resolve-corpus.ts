// T3.2's acceptance workload, rebuilt (the spike's bench-resolve.mjs is gone; see
// docs/plan/bundles/B05.md → Corpora). Requests: every installed third-party package's bare name plus
// every literal `exports` subpath, from pnpm's hoisted store. The workspace's own packages, which pnpm
// links into that store, are left out and counted (their targets depend on whether a build ran: CI
// runs this with no `dist/`), and a target whose file is missing is no answer (`requests.ts`). Baseline: Node's own ESM resolution
// (`import.meta.resolve` with a parent in that store). Bar: at least 531 compared requests and an
// agreement ratio of at least 529/531; with `--max-warm-us`, the warm cost per request too.
//
// Usage: node --conditions=provino-source packages/resolver/bench/resolve-corpus.ts
//          [--max-warm-us 15] [--json]
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createResolver } from '@provino/resolver'
import type { ResolveContext } from '@provino/types'
import { collectRequests, type NodeAnswer, withoutMissingTargets } from './requests.ts'

const MIN_COMPARED = 531
const AGREEMENT = 529 / 531
const WARM_PASSES = 5

const { values: args } = parseArgs({
  options: { 'max-warm-us': { type: 'string' }, json: { type: 'boolean', default: false } },
})
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const store = join(repoRoot, 'node_modules/.pnpm/node_modules')
if (!existsSync(store)) throw new Error(`no pnpm hoisted store at ${store}; run pnpm install`)
const parentFile = join(store, '__provino_resolve_parent__.mjs')

/** Node's answers, from a child process (the parent argument needs the flag). */
function nodeAnswers(requests: readonly string[]): NodeAnswer[] {
  const script = `
    import { fileURLToPath } from 'node:url'
    let input = ''
    for await (const chunk of process.stdin) input += chunk
    const { parent, requests } = JSON.parse(input)
    const out = requests.map((request) => {
      try {
        const url = import.meta.resolve(request, parent)
        return { request, path: url.startsWith('file:') ? fileURLToPath(url) : url, error: null }
      } catch (error) {
        return { request, path: null, error: error.code ?? String(error) }
      }
    })
    process.stdout.write(JSON.stringify(out))
  `
  const child = spawnSync(
    process.execPath,
    ['--experimental-import-meta-resolve', '--input-type=module', '-e', script],
    {
      input: JSON.stringify({ parent: new URL(`file://${parentFile}`).href, requests }),
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    },
  )
  if (child.status !== 0) throw new Error(`the Node baseline failed:\n${child.stderr}`)
  // import.meta.resolve answers a path for an exports target whose file is missing: not an answer.
  return withoutMissingTargets(JSON.parse(child.stdout))
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

const { requests, workspace } = collectRequests(store)
const node = nodeAnswers(requests)
const compared = node.filter((answer) => answer.path !== null)
const excluded = node.length - compared.length

// Node's default ESM conditions are node, import and module-sync; the call kind adds `import`.
const resolveContext: ResolveContext = {
  importer: parentFile,
  kind: 'import',
  conditions: ['node', 'module-sync'],
}
const resolver = createResolver({
  root: repoRoot,
  mappers: [],
  extensions: ['.js', '.json', '.node'],
  tsconfig: false,
})

function ours(request: string): string | null {
  const result = resolver.resolve(request, resolveContext)
  if (result.type === 'file') return realpathSync(result.path)
  if (result.type === 'builtin') return result.id
  return null
}

function timePass(): number {
  const start = process.hrtime.bigint()
  for (const answer of compared) resolver.resolve(answer.request, resolveContext)
  return Number(process.hrtime.bigint() - start) / 1000 / compared.length
}

const coldUs = timePass()
const warmUs = median(Array.from({ length: WARM_PASSES }, timePass))
const disagreements = compared
  .map((answer) => ({ request: answer.request, node: answer.path, provino: ours(answer.request) }))
  .filter((row) => row.node !== row.provino)
const agreed = compared.length - disagreements.length
const ratio = compared.length === 0 ? 0 : agreed / compared.length
const maxWarmUs = args['max-warm-us'] === undefined ? undefined : Number(args['max-warm-us'])

const failures: string[] = []
if (compared.length < MIN_COMPARED) {
  failures.push(`compared ${compared.length} requests; the bar needs at least ${MIN_COMPARED}`)
}
if (ratio < AGREEMENT) {
  failures.push(`agreement ${agreed}/${compared.length} is below 529/531`)
}
if (maxWarmUs !== undefined && warmUs > maxWarmUs) {
  failures.push(`warm ${warmUs.toFixed(2)} µs/request is above ${maxWarmUs}`)
}

const report = {
  label: 'local',
  node: process.version,
  requests: requests.length,
  compared: compared.length,
  excludedNodeErrors: excluded,
  excludedWorkspacePackages: workspace,
  agreed,
  disagreements,
  coldUsPerRequest: Number(coldUs.toFixed(2)),
  warmUsPerRequest: Number(warmUs.toFixed(2)),
  failures,
}
if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
else {
  process.stdout.write(
    [
      `resolve corpus (local, Node ${process.version})`,
      `  requests ${requests.length}, compared ${compared.length}, excluded (Node errors, or a target whose file is missing) ${excluded}`,
      `  left out: ${workspace.length} workspace packages (the workspace's own, whose targets depend on whether a build ran)`,
      `  agreed ${agreed}/${compared.length}`,
      ...disagreements.map(
        (row) => `    ${row.request}: node ${row.node} | provino ${row.provino}`,
      ),
      `  cold ${coldUs.toFixed(2)} µs/request, warm ${warmUs.toFixed(2)} µs/request (median of ${WARM_PASSES})`,
      ...failures.map((failure) => `FAIL ${failure}`),
      '',
    ].join('\n'),
  )
}
process.exitCode = failures.length === 0 ? 0 : 1
