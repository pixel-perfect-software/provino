// T8.8: the real worker collects coverage and sends it, over each transport. Istanbul's counters
// arrive per file (maps once per worker); V8's arrive once, when the worker stops. The coordinator's
// store decodes both. A warm-transform-cache run gives the same V8 ranges as a cold one.
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, it } from 'node:test'
import { loadCoverageStore } from '@provino/orchestrator'
import type {
  IstanbulFileCoverageData,
  RawCoverage,
  SerializedCoverageConfig,
  WorkerEvent,
} from '@provino/types'
import { eventsOf, KINDS, runJobs, runtimeConfig, runtimeJob, trackedProjects } from './support.ts'

const project = trackedProjects()

const PRICING = [
  'export function price(quantity: number): number {',
  '  return quantity * 2',
  '}',
  'export function discount(total: number): number {',
  '  return total * 0.9',
  '}',
  '',
].join('\n')

const FILES = {
  'pricing.ts': PRICING,
  'a.test.ts': [
    "import { price } from './pricing.ts'",
    "test('prices', () => { expect(price(2)).toBe(4) })",
    '',
  ].join('\n'),
  'b.test.ts': [
    "import { price } from './pricing.ts'",
    "test('prices again', () => { expect(price(3)).toBe(6); expect(price(4)).toBe(8) })",
    '',
  ].join('\n'),
}

function coverageOf(
  dir: string,
  provider: 'v8' | 'istanbul',
  extra: Partial<SerializedCoverageConfig> = {},
): SerializedCoverageConfig {
  return {
    provider,
    globalRoot: dir,
    projectRoot: dir,
    include: [],
    includeRoot: true,
    force: [],
    testFiles: ['**/*.test.ts'],
    testRegex: [],
    testIgnorePatterns: [],
    excludePatterns: ['/node_modules/'],
    excludePaths: [],
    ...extra,
  }
}

const { createRawCoverageStore } = await loadCoverageStore()

/** What the coordinator's store makes of a run's `coverage` events (every event is worker 1's). */
function collect(events: readonly WorkerEvent[]): readonly RawCoverage[] {
  const store = createRawCoverageStore()
  for (const event of eventsOf(events, 'coverage')) store.add(1, event)
  return store.entries
}

/** The statement hit counts of `pricing.ts` in a take, by statement id; `undefined` when it has none. */
function pricingHits(raw: RawCoverage | undefined): Record<string, number> | undefined {
  if (raw?.kind !== 'istanbul') return undefined
  const entry = Object.entries(raw.data).find(([path]) => path.endsWith('pricing.ts'))?.[1] as
    | IstanbulFileCoverageData
    | undefined
  return entry?.s
}

for (const pool of KINDS) {
  describe(`${pool}: coverage collection`, () => {
    it('istanbul: each file sends its own counters, the test file is not counted', async () => {
      const p = await project(FILES)
      const config = runtimeConfig(p.dir, { coverage: coverageOf(p.dir, 'istanbul') })
      const jobs = [
        runtimeJob(config, p.path('a.test.ts')),
        runtimeJob(config, p.path('b.test.ts')),
      ]
      const run = await runJobs({ pool, config, jobs })
      assert.deepEqual(run.exit, { type: 'exit', code: 0 })
      const sent = eventsOf(run.events, 'coverage')
      assert.deepEqual(
        sent.map((event) => event.fileId),
        jobs.map((job) => job.fileId),
      )
      const takes = collect(run.events)
      assert.equal(takes.length, 2)
      const [first, second] = takes
      // `price` runs once in the first file and twice in the second; `discount` never.
      const hits = (take: RawCoverage | undefined): number[] =>
        Object.values(pricingHits(take) ?? {}).sort()
      assert.deepEqual(hits(first), [0, 1])
      assert.deepEqual(hits(second), [0, 2])
      // Only `pricing.ts`: the test files are not instrumented.
      for (const take of takes) {
        assert.deepEqual(
          take.kind === 'istanbul'
            ? Object.keys(take.data).map((path) => path.slice(p.dir.length + 1))
            : [],
          ['pricing.ts'],
        )
      }
    })

    // The worker-wide file registry shares one instance map under `none`; counters still go per file.
    for (const isolation of ['registry', 'none'] as const) {
      it(`istanbul under ${isolation}: a file's data equals that file run alone`, async () => {
        const p = await project(FILES)
        const config = runtimeConfig(p.dir, { coverage: coverageOf(p.dir, 'istanbul') })
        const both = await runJobs({
          pool,
          isolation,
          config,
          jobs: [runtimeJob(config, p.path('a.test.ts')), runtimeJob(config, p.path('b.test.ts'))],
        })
        const [, second] = collect(both.events)
        const alone = await runJobs({
          pool,
          isolation,
          config,
          jobs: [runtimeJob(config, p.path('b.test.ts'))],
        })
        const [only] = collect(alone.events)
        assert.deepEqual(
          second?.kind === 'istanbul' ? second.data : null,
          only?.kind === 'istanbul' ? only.data : undefined,
        )
      })
    }

    it('v8: one take when the worker stops, with the user modules and no test file', async () => {
      const p = await project(FILES)
      const config = runtimeConfig(p.dir, { coverage: coverageOf(p.dir, 'v8') })
      const run = await runJobs({
        pool,
        config,
        jobs: [runtimeJob(config, p.path('a.test.ts'))],
      })
      assert.deepEqual(run.exit, { type: 'exit', code: 0 })
      const sent = eventsOf(run.events, 'coverage')
      assert.deepEqual(
        sent.map((event) => event.fileId),
        [null],
      )
      const [take] = collect(run.events)
      assert.equal(take?.kind, 'v8')
      if (take?.kind !== 'v8') return
      const urls = take.scripts.map((script) => script.url.slice(script.url.lastIndexOf('/') + 1))
      assert.deepEqual(urls, ['pricing.ts'])
      assert.deepEqual(
        take.modules?.map((module) => module.url.endsWith('pricing.ts')),
        [true],
      )
      // `price` ran, `discount` did not.
      const counts = new Map(
        take.scripts[0]?.functions.map((fn) => [fn.functionName, fn.ranges[0]?.count]),
      )
      assert.equal(counts.get('price'), 1)
      assert.equal(counts.get('discount'), 0)
    })
  })
}

describe('forceCoverageMatch on a test file', () => {
  const FORCED = {
    'sum.t.js': [
      'function sum(a, b) { return a + b }',
      "test('sums', () => { expect(sum(1, 2)).toBe(3) })",
      '',
    ].join('\n'),
  }
  const names = (raw: RawCoverage | undefined): string[] => {
    if (raw?.kind === 'istanbul') return Object.keys(raw.data).map((path) => basename(path))
    if (raw?.kind === 'v8') return raw.scripts.map((script) => basename(script.url))
    return []
  }
  for (const provider of ['istanbul', 'v8'] as const) {
    for (const [what, force, expected] of [
      ['counts a test file the force globs match', ['**/*.t.js'], ['sum.t.js']],
      ['leaves a test file alone otherwise', [], []],
    ] as const) {
      it(`${provider}: ${what}`, async () => {
        const p = await project(FORCED)
        const config = runtimeConfig(p.dir, {
          coverage: coverageOf(p.dir, provider, { testFiles: ['**/*.t.js'], force }),
        })
        const run = await runJobs({
          pool: 'forks',
          config,
          jobs: [runtimeJob(config, p.path('sum.t.js'))],
        })
        assert.deepEqual(run.exit, { type: 'exit', code: 0 })
        assert.deepEqual(names(collect(run.events)[0]), expected)
      })
    }
  }
})

describe('a warm transform cache', () => {
  it('v8: gives the same ranges as a cold run', async () => {
    const p = await project(FILES)
    const cacheDir = realpathSync(mkdtempSync(join(tmpdir(), 'provino-coverage-cache-')))
    const base = runtimeConfig(p.dir)
    const config = runtimeConfig(p.dir, {
      coverage: coverageOf(p.dir, 'v8'),
      loader: { ...base.loader, cacheDir },
    })
    const once = async (): Promise<RawCoverage | undefined> => {
      const run = await runJobs({
        pool: 'forks',
        config,
        jobs: [runtimeJob(config, p.path('a.test.ts'))],
      })
      return collect(run.events)[0]
    }
    const cold = await once()
    const warm = await once()
    assert.equal(cold?.kind, 'v8')
    // V8 numbers its scripts as they compile, so a script id is the one thing that may differ.
    const withoutIds = (raw: RawCoverage | undefined): unknown =>
      raw?.kind === 'v8'
        ? { ...raw, scripts: raw.scripts.map(({ scriptId: _id, ...rest }) => rest) }
        : raw
    assert.deepEqual(withoutIds(warm), withoutIds(cold))
  })

  it('istanbul: gives the same data as a cold run', async () => {
    const p = await project(FILES)
    const cacheDir = realpathSync(mkdtempSync(join(tmpdir(), 'provino-coverage-cache-')))
    const base = runtimeConfig(p.dir)
    const config = runtimeConfig(p.dir, {
      coverage: coverageOf(p.dir, 'istanbul'),
      loader: { ...base.loader, cacheDir },
    })
    const once = async (): Promise<RawCoverage | undefined> => {
      const run = await runJobs({
        pool: 'forks',
        config,
        jobs: [runtimeJob(config, p.path('a.test.ts'))],
      })
      return collect(run.events)[0]
    }
    const cold = await once()
    const warm = await once()
    assert.equal(cold?.kind, 'istanbul')
    assert.deepEqual(warm, cold)
  })
})
