// T8.9, Jest's part: coverage is the same however the run is cut. Under Istanbul and under V8, the
// two shards of a run (`--shard 1/2` and `2/2`), each on three forked workers, are finished
// together from the takes their workers sent (`RunCoverageHooks.onTake`, `finishCoverage`) and
// give the map and the totals of the whole run on one worker. V8 runs under the Jest dialect's
// `v8HitCounts: true`: with hits only, a statement two workers ran would count 2 against 1.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import type { ResolvedProject } from '@provino/config'
import { loadFinishCoverage } from '@provino/orchestrator'
import type { RawCoverage, SerializedCoverageConfig } from '@provino/types'
import { run, runtimeProject, trackedProjects } from './support.ts'

const { finishCoverage } = await loadFinishCoverage()
const project = trackedProjects()

const PRICING = [
  'export function price(quantity: number, unit = 2): number {',
  '  if (quantity < 0) throw new RangeError("negative quantity")',
  '  return quantity * unit',
  '}',
  'export function discount(total: number, rate?: number): number {',
  '  const applied = rate ?? 0.1',
  '  return total > 100 ? total * (1 - applied) : total',
  '}',
  'export interface Line {',
  '  readonly quantity: number',
  '}',
  '',
].join('\n')

const FORMAT = [
  'export function label(value: number | null): string {',
  '  return value === null ? "none" : value > 0 ? "positive" : "other"',
  '}',
  "export const money = (amount: number): string => '€' + amount.toFixed(2)",
  '',
].join('\n')

/** Six test files, each a different mix of calls, so each shard counts something of its own. */
const TESTS: Readonly<Record<string, readonly string[]>> = {
  'a.test.ts': ['price(3)', 'price(4, 5)'],
  'b.test.ts': ['discount(50)', 'label(null)'],
  'c.test.ts': ['discount(500, 0.5)', 'money(2)'],
  'd.test.ts': ['label(3)', 'label(-1)', 'price(1)'],
  'e.test.ts': ['money(1)', 'money(3)', 'discount(200)'],
  'f.test.ts': ['price(2)', 'label(0)'],
}

const FILES: Readonly<Record<string, string>> = {
  'src/pricing.ts': PRICING,
  'src/format.ts': FORMAT,
  'src/untested.ts': 'export const never = (flag: boolean): string => (flag ? "yes" : "no")\n',
  ...Object.fromEntries(
    Object.entries(TESTS).map(([file, calls]) => [
      file,
      [
        "import { discount, price } from './src/pricing.ts'",
        "import { label, money } from './src/format.ts'",
        `test('${file}', () => {`,
        ...calls.map((call) => `  expect(typeof ${call}).toBe(typeof ${call})`),
        '})',
        '',
      ].join('\n'),
    ]),
  ),
}

function withCoverage(dir: string, provider: 'istanbul' | 'v8'): ResolvedProject {
  const base = runtimeProject(dir, {
    include: ['**/*.test.ts'],
    policy: { coverage: { v8Conversion: 'v8-to-istanbul', v8HitCounts: true } },
  })
  const coverage: SerializedCoverageConfig = {
    provider,
    globalRoot: dir,
    projectRoot: dir,
    include: ['src/**/*.ts'],
    includeRoot: true,
    force: [],
    testFiles: ['**/*.test.ts'],
    testRegex: [],
    testIgnorePatterns: [],
    excludePatterns: ['/node_modules/'],
    excludePaths: [],
  }
  return { ...base, config: { ...base.config, coverage } }
}

/** The files a run ran, by their path from the root. */
function ranFiles(summary: Awaited<ReturnType<typeof run>>['summary']): string[] {
  return summary.files.map((file) => file.file.path).sort()
}

for (const provider of ['istanbul', 'v8'] as const) {
  describe(`${provider}: two shards on three workers each merge to one run on one worker`, () => {
    it('the same map and the same totals', async () => {
      const p = await project(FILES)
      const covered = withCoverage(p.dir, provider)

      const wholeTakes: RawCoverage[] = []
      const whole = await run(covered, {
        pool: { kind: 'forks', maxWorkers: 1 },
        coverage: { onTake: (take) => void wholeTakes.push(take) },
      })
      assert.equal(whole.summary.reason, 'passed', whole.stderr.text)
      const expected = whole.summary.coverage
      assert.ok(expected !== undefined)
      assert.equal(new Set(wholeTakes.map((take) => take.workerId)).size, 1)

      const takes: RawCoverage[] = []
      const shards: string[][] = []
      const workers = new Set<string>()
      for (const index of [1, 2]) {
        const shard = await run(covered, {
          pool: { kind: 'forks', maxWorkers: 3 },
          shard: { index, count: 2 },
          coverage: {
            onTake: (take) => {
              takes.push(take)
              workers.add(`${index}:${take.workerId}`)
            },
          },
        })
        assert.equal(shard.summary.reason, 'passed', shard.stderr.text)
        shards.push(ranFiles(shard.summary))
      }
      // Each shard ran three of the six files, on more than one worker, and together they ran all.
      assert.deepEqual(
        shards.map((files) => files.length),
        [3, 3],
      )
      assert.deepEqual([...shards.flat()].sort(), ranFiles(whole.summary))
      assert.ok(workers.size > 2, `the shards ran on ${workers.size} workers`)
      assert.ok(takes.length > 2, `${takes.length} takes`)

      const merged = await finishCoverage({ entries: takes }, [covered])
      assert.deepEqual(Object.keys(merged.map).sort(), [
        p.path('src/format.ts'),
        p.path('src/pricing.ts'),
        p.path('src/untested.ts'),
      ])
      assert.deepEqual(merged.map, expected.map)
      assert.deepEqual(merged.totals, expected.totals)
    })
  })
}

describe("v8: a module's code and map cross once per run", () => {
  it('a worker started after another sent them names the module only, and the map is the same', async () => {
    const p = await project(FILES)
    const covered = withCoverage(p.dir, 'v8')
    const pricing = pathToFileURL(p.path('src/pricing.ts')).href

    const once = await run(covered, { pool: { kind: 'forks', maxWorkers: 1 } })
    assert.equal(once.summary.reason, 'passed', once.stderr.text)

    // One file per worker: each later worker starts after the ones before it sent their take.
    const takes: RawCoverage[] = []
    const recycled = await run(covered, {
      pool: { kind: 'forks', maxWorkers: 1, recycle: { maxFilesPerWorker: 1 } },
      coverage: { onTake: (take) => void takes.push(take) },
    })
    assert.equal(recycled.summary.reason, 'passed', recycled.stderr.text)
    assert.equal(new Set(takes.map((take) => take.workerId)).size, takes.length)
    assert.ok(takes.length > 2, `${takes.length} takes`)
    /** Whether each take, as its worker sent it, carried `pricing.ts`'s code. */
    const carried = takes.map((take) => {
      const info = take.kind === 'v8' ? take.modules?.find((m) => m.url === pricing) : undefined
      assert.ok(info !== undefined, `worker ${take.workerId} names pricing.ts`)
      return 'code' in info
    })
    assert.deepEqual(carried, [true, ...takes.slice(1).map(() => false)])
    assert.deepEqual(recycled.summary.coverage?.map, once.summary.coverage?.map)
    assert.deepEqual(recycled.summary.coverage?.totals, once.summary.coverage?.totals)
  })
})
