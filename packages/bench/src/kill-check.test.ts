import assert from 'node:assert/strict'
import { test } from 'node:test'
import type {
  BenchLabel,
  BenchRecord,
  BenchResult,
  IsolationMode,
  RunEnvironment,
} from '@provino/types'
import {
  evaluateKillCheck,
  formatKillCheck,
  ISOLATION_SUITE,
  KILL_CRITERION,
  type KillCheckSuite,
  R6_SUITES,
} from './kill-check.ts'
import type { StatusParity } from './parity.ts'
import { buildRecord } from './report.ts'
import { wallStats } from './stats.ts'

const environment: RunEnvironment = {
  os: 'darwin',
  osRelease: '27.2.0',
  arch: 'arm64',
  cpuModel: 'Test CPU',
  cpuCount: 8,
  memoryMb: 16384,
  node: 'v24.0.0',
  runners: { jest: '30.5.2' },
  ci: false,
}

const APP: readonly KillCheckSuite[] = [{ name: 'app-500' }]

type Wall = number | readonly number[]

interface Walls {
  readonly jest?: Wall
  readonly registry?: Wall
  readonly none?: Wall
}

function samples(value: Wall, cache: 'warm' | 'cold'): number[] {
  if (typeof value !== 'number') return [...value]
  return Array.from({ length: cache === 'warm' ? 10 : 5 }, () => value)
}

function result(
  bench: string,
  runner: string,
  isolation: IsolationMode,
  cache: 'warm' | 'cold',
  wall: Wall,
): BenchResult {
  return {
    benchId: bench,
    subject: { runner, version: '1.0.0', isolation, command: `run ${runner}` },
    cache,
    wall: wallStats(samples(wall, cache)),
    ok: true,
  }
}

// One suite's results for both cache states. Identical samples make a CI equal its ratio.
function suiteResults(
  bench: string,
  warm: Walls,
  cold: Walls = warm,
  runner = 'provino:jest',
): BenchResult[] {
  const out: BenchResult[] = []
  for (const [cache, walls] of [
    ['warm', warm],
    ['cold', cold],
  ] as const) {
    if (walls.jest !== undefined) {
      out.push(result(bench, 'jest', 'runner-default', cache, walls.jest))
    }
    if (walls.registry !== undefined) {
      out.push(result(bench, runner, 'registry', cache, walls.registry))
    }
    if (walls.none !== undefined) out.push(result(bench, runner, 'none', cache, walls.none))
  }
  return out
}

function recordOf(results: BenchResult[], label: BenchLabel = 'local'): BenchRecord {
  return buildRecord({
    label,
    ref: { sha: 'a'.repeat(40), date: '2026-11-02T10:00:00.000Z', dirty: false },
    environment,
    machineId: `${label}-darwin-arm64`,
    results,
  })
}

function parityOf(matched: number, total: number, extra: Partial<StatusParity> = {}): StatusParity {
  return {
    ok: matched === total,
    referenceTests: total,
    statusMatched: matched,
    candidateOnlyTests: 0,
    files: 1,
    filesMatched: 1,
    failing: [],
    assertionDiffs: [],
    ...extra,
  }
}

const GOOD_PARITY = new Map([['app-500', parityOf(4000, 4000)]])

function verdictOf(
  results: BenchResult[],
  options: {
    readonly suites?: readonly KillCheckSuite[]
    readonly parity?: ReadonlyMap<string, StatusParity>
    readonly dryRun?: boolean
    readonly label?: BenchLabel
  } = {},
) {
  return evaluateKillCheck({
    record: recordOf(results, options.label),
    suites: options.suites ?? APP,
    parity: options.parity ?? GOOD_PARITY,
    dryRun: options.dryRun ?? false,
  })
}

const passing = (): BenchResult[] =>
  suiteResults(
    'app-500',
    { jest: 100, registry: 30, none: 20 },
    { jest: 100, registry: 40, none: 30 },
  )

// Isolation kept comfortably passing so a test can vary only the speed.
const FINE_COLD: Walls = { jest: 100, registry: 10, none: 10 }

test('the criterion is D5 and R2, as fixed numbers', () => {
  assert.deepEqual(KILL_CRITERION, {
    warmMaxRatio: 0.5,
    coldMaxRatio: 0.8,
    isolationMaxRatio: 3,
    minStatusParity: 0.9,
  })
  assert.equal(ISOLATION_SUITE, 'app-500')
  assert.deepEqual(
    R6_SUITES.map((suite) => suite.name),
    [
      'app-500',
      'mock-heavy-500',
      'jest-extended',
      'react-hook-form',
      'mobx',
      'swr',
      'styled-components',
    ],
  )
  assert.deepEqual(
    R6_SUITES.filter((suite) => suite.pending === undefined).map((suite) => suite.name),
    ['app-500'],
  )
})

test('a passing app-500 is GO, provisional because six suites are pending', () => {
  const verdict = verdictOf(passing(), { suites: R6_SUITES })
  assert.equal(verdict.outcome, 'GO')
  assert.deepEqual(verdict.failures, [])
  assert.equal(verdict.provisional, true)
  assert.equal(verdict.measured, 1)
  assert.equal(verdict.pendingCount, 6)
})

test('warm: exactly 0.50 passes, a hair over fails', () => {
  const at = verdictOf(suiteResults('app-500', { jest: 100, registry: 50, none: 50 }, FINE_COLD))
  assert.equal(at.suites[0]?.warm?.ok, true)
  assert.equal(at.outcome, 'GO')
  const over = verdictOf(
    suiteResults('app-500', { jest: 100, registry: 50.1, none: 50 }, FINE_COLD),
  )
  assert.equal(over.suites[0]?.warm?.ok, false)
  assert.equal(over.outcome, 'NO-GO')
  assert.match(over.failures.join('\n'), /app-500 warm: .*upper bound 0\.501 is above 0\.50/)
})

test('cold: exactly 0.80 passes, a hair over fails', () => {
  const warm: Walls = { jest: 100, registry: 10, none: 10 }
  const at = verdictOf(suiteResults('app-500', warm, { jest: 100, registry: 80, none: 80 }))
  assert.equal(at.suites[0]?.cold?.ok, true)
  assert.equal(at.outcome, 'GO')
  const over = verdictOf(suiteResults('app-500', warm, { jest: 100, registry: 80.1, none: 80 }))
  assert.equal(over.suites[0]?.cold?.ok, false)
  assert.equal(over.outcome, 'NO-GO')
})

test('a median ratio under the limit with an upper bound over it is NO-GO', () => {
  const noisy = [30, 30, 30, 30, 45, 45, 45, 60, 60, 60]
  const verdict = verdictOf(
    suiteResults('app-500', { jest: 100, registry: noisy, none: 45 }, FINE_COLD),
  )
  const warm = verdict.suites[0]?.warm
  assert.ok(warm?.ratio)
  assert.ok(warm.ratio.ratio <= 0.5, `median ratio ${warm.ratio.ratio}`)
  assert.ok(warm.ratio.high > 0.5, `upper bound ${warm.ratio.high}`)
  assert.equal(warm.ok, false)
  assert.equal(verdict.outcome, 'NO-GO')
})

test('a failing run or a missing result fails with no ratio', () => {
  const failed = passing().map((entry) =>
    entry.cache === 'warm' && entry.subject.isolation === 'registry'
      ? { ...entry, ok: false }
      : entry,
  )
  const failedVerdict = verdictOf(failed)
  assert.equal(failedVerdict.suites[0]?.warm?.ok, false)
  assert.equal(failedVerdict.suites[0]?.warm?.ratio, undefined)
  assert.match(
    failedVerdict.failures.join('\n'),
    /app-500 warm: the Provino registry result has a failing run/,
  )
  assert.equal(failedVerdict.outcome, 'NO-GO')

  const noJest = verdictOf(passing().filter((entry) => entry.subject.runner !== 'jest'))
  assert.equal(noJest.suites[0]?.cold?.ratio, undefined)
  assert.match(noJest.failures.join('\n'), /app-500 cold: no Jest result/)
  assert.equal(noJest.outcome, 'NO-GO')

  const nothing = verdictOf([])
  assert.equal(nothing.outcome, 'NO-GO')
  assert.ok(nothing.isolation.every((check) => !check.ok && check.ratio === undefined))
})

test('isolation: 3.0 passes, over fails, on the point ratio', () => {
  const at = verdictOf(suiteResults('app-500', { jest: 1000, registry: 300, none: 100 }))
  assert.ok(at.isolation.every((check) => check.ok))
  assert.equal(at.outcome, 'GO')
  const over = verdictOf(
    suiteResults(
      'app-500',
      { jest: 1000, registry: 301, none: 100 },
      { jest: 1000, registry: 300, none: 100 },
    ),
  )
  assert.deepEqual(
    over.isolation.map((check) => check.ok),
    [false, true],
  )
  assert.equal(over.outcome, 'NO-GO')
  assert.ok(over.isolation[0]?.ratio, 'the CI is reported beside the point ratio')
})

test('isolation needs warm and cold: warm passing with cold failing is NO-GO', () => {
  const verdict = verdictOf(
    suiteResults(
      'app-500',
      { jest: 1000, registry: 200, none: 100 },
      { jest: 1000, registry: 400, none: 100 },
    ),
  )
  assert.deepEqual(
    verdict.isolation.map((check) => [check.cache, check.ok]),
    [
      ['warm', true],
      ['cold', false],
    ],
  )
  assert.equal(verdict.outcome, 'NO-GO')
  assert.match(
    verdict.failures.join('\n'),
    /isolation app-500 cold: registry\/none median ratio 4\.000 is above 3\.0/,
  )
})

test('a failed none run or a missing none result fails isolation', () => {
  const failed = passing().map((entry) =>
    entry.subject.isolation === 'none' && entry.cache === 'cold' ? { ...entry, ok: false } : entry,
  )
  assert.equal(verdictOf(failed).outcome, 'NO-GO')
  const verdict = verdictOf(passing().filter((entry) => entry.subject.isolation !== 'none'))
  assert.equal(verdict.outcome, 'NO-GO')
  assert.match(verdict.failures.join('\n'), /no Provino none result/)
})

test('parity: 9/10 passes, 899/1000 fails, and anything unreadable fails', () => {
  const run = (read: StatusParity | undefined) =>
    verdictOf(passing(), { parity: new Map(read === undefined ? [] : [['app-500', read]]) })
  assert.equal(run(parityOf(9, 10)).outcome, 'GO')
  const low = run(parityOf(899, 1000))
  assert.equal(low.outcome, 'NO-GO')
  assert.match(low.failures.join('\n'), /app-500 parity: 899\/1000 .*89\.9%.* below 90%/)
  assert.equal(run(parityOf(0, 10, { unavailable: 'HARNESS_X: no' })).outcome, 'NO-GO')
  assert.equal(run(parityOf(10, 10, { unavailable: 'set' })).outcome, 'NO-GO')
  assert.equal(run(parityOf(0, 0)).outcome, 'NO-GO')
  assert.equal(run(undefined).outcome, 'NO-GO')
  assert.match(run(undefined).failures.join('\n'), /no parity was read/)
})

test('a dry run skips parity and never fails on it', () => {
  const verdict = verdictOf(passing(), { parity: new Map(), dryRun: true })
  assert.equal(verdict.suites[0]?.parity?.status, 'skipped')
  assert.equal(verdict.outcome, 'GO')
  assert.equal(verdict.provisional, true)
})

test('pending suites are listed and never measured', () => {
  const verdict = verdictOf(passing(), { suites: R6_SUITES })
  const pending = verdict.suites.filter((suite) => suite.pending !== undefined)
  assert.equal(pending.length, 6)
  for (const suite of pending) {
    assert.equal(suite.warm, undefined)
    assert.equal(suite.cold, undefined)
    assert.equal(suite.parity, undefined)
  }
})

test('provisional unless pinned, complete and not a dry run', () => {
  const all: KillCheckSuite[] = R6_SUITES.map((suite) => ({ name: suite.name }))
  const everything = (): BenchResult[] =>
    all.flatMap((suite) => {
      const none = suite.name === ISOLATION_SUITE ? { none: 20 } : {}
      return suiteResults(
        suite.name,
        { jest: 100, registry: 30, ...none },
        { jest: 100, registry: 40, ...none },
      )
    })
  const parity = new Map(all.map((suite) => [suite.name, parityOf(10, 10)]))
  for (const label of ['local', 'desktop'] as const) {
    assert.equal(verdictOf(passing(), { label, suites: R6_SUITES }).provisional, true, label)
    assert.equal(verdictOf(everything(), { label, suites: all, parity }).provisional, true, label)
  }
  assert.equal(verdictOf(passing(), { label: 'pinned', suites: R6_SUITES }).provisional, true)
  assert.equal(
    verdictOf(everything(), { label: 'pinned', suites: all, parity, dryRun: true }).provisional,
    true,
  )
  const final = verdictOf(everything(), { label: 'pinned', suites: all, parity })
  assert.equal(final.outcome, 'GO')
  assert.equal(final.provisional, false)
  assert.ok(formatKillCheck(final).includes('[pinned] VERDICT: GO'))
})

test('redesign is false on one suite failing speed and true on two', () => {
  const both: KillCheckSuite[] = [{ name: 'app-500' }, { name: 'other' }]
  const parity = new Map([
    ['app-500', parityOf(10, 10)],
    ['other', parityOf(10, 10)],
  ])
  const slow = (bench: string) => suiteResults(bench, { jest: 100, registry: 90 })
  const fast = (bench: string) => suiteResults(bench, { jest: 100, registry: 30 })
  // registry/none on app-500 stays under 3.0 either way
  const none = suiteResults('app-500', { none: 90 })
  const one = verdictOf([...slow('app-500'), ...fast('other'), ...none], { suites: both, parity })
  assert.equal(one.redesign, false)
  assert.equal(one.speedFailedSuites, 1)
  const two = verdictOf([...slow('app-500'), ...slow('other'), ...none], { suites: both, parity })
  assert.equal(two.redesign, true)
  assert.match(
    formatKillCheck(two).join('\n'),
    /R6: the speed condition failed on 2 suites, so Phase 1 stops for a redesign/,
  )
  assert.doesNotMatch(formatKillCheck(one).join('\n'), /redesign/)
})

const EVERY: KillCheckSuite[] = R6_SUITES.map((suite) => ({ name: suite.name }))
const everyParity = new Map(EVERY.map((suite) => [suite.name, parityOf(10, 10)]))
const everyResults = (): BenchResult[] =>
  EVERY.flatMap((suite) => {
    const none = suite.name === ISOLATION_SUITE ? { none: 20 } : {}
    return suiteResults(
      suite.name,
      { jest: 100, registry: 30, ...none },
      { jest: 100, registry: 40, ...none },
    )
  })

test('provisional is judged against the seven R6 suites, not the caller list', () => {
  const pinned = (
    results: BenchResult[],
    suites: readonly KillCheckSuite[],
    parity = GOOD_PARITY,
  ) => verdictOf(results, { label: 'pinned', suites, parity })
  const subset = pinned(passing(), [{ name: 'app-500' }])
  assert.equal(subset.outcome, 'GO')
  assert.equal(subset.provisional, true)
  assert.doesNotMatch(formatKillCheck(subset).join('\n'), /all 1 suites measured/)

  const empty = pinned([], [])
  assert.equal(empty.outcome, 'NO-GO')
  assert.equal(empty.measured, 0)
  assert.match(empty.failures.join('\n'), /no suite was measured/)

  const pending = pinned(
    passing(),
    R6_SUITES.map((suite) => ({ name: suite.name, pending: 'later' })),
  )
  assert.equal(pending.outcome, 'NO-GO')
  assert.match(pending.failures.join('\n'), /no suite was measured/)

  const final = pinned(everyResults(), EVERY, everyParity)
  assert.equal(final.outcome, 'GO')
  assert.equal(final.provisional, false)
})

test('redesign counts only a real speed miss, never a missing result or a dry run', () => {
  const both: KillCheckSuite[] = [{ name: 'app-500' }, { name: 'other' }]
  const parity = new Map([
    ['app-500', parityOf(10, 10)],
    ['other', parityOf(10, 10)],
  ])
  const failing = (bench: string) =>
    suiteResults(bench, { jest: 100, registry: 30 }).map((entry) => ({ ...entry, ok: false }))
  const none = suiteResults('app-500', { none: 20 })
  const broken = verdictOf([...failing('app-500'), ...failing('other'), ...none], {
    suites: both,
    parity,
  })
  assert.equal(broken.outcome, 'NO-GO')
  assert.equal(broken.speedFailedSuites, 0)
  assert.equal(broken.redesign, false)
  const missing = verdictOf(none, { suites: both, parity })
  assert.equal(missing.outcome, 'NO-GO')
  assert.equal(missing.redesign, false)

  const slow = (bench: string) => suiteResults(bench, { jest: 100, registry: 90 })
  const slowNone = suiteResults('app-500', { none: 90 })
  const over = verdictOf([...slow('app-500'), ...slow('other'), ...slowNone], {
    suites: both,
    parity,
  })
  assert.equal(over.speedFailedSuites, 2)
  assert.equal(over.redesign, true)
  assert.match(
    formatKillCheck(over).join('\n'),
    /stops for a redesign \(Track 2\)\. \(provisional: only a pinned run of all 7 decides that\)/,
  )
  const dry = verdictOf([...slow('app-500'), ...slow('other'), ...slowNone], {
    suites: both,
    parity,
    dryRun: true,
  })
  assert.equal(dry.redesign, false)
  assert.doesNotMatch(formatKillCheck(dry).join('\n'), /redesign/)
})

test('failure text never rounds a miss onto the limit', () => {
  // 3599/4000 is 89.975%, which toFixed(1) prints as 90.0%
  const low = verdictOf(passing(), { parity: new Map([['app-500', parityOf(3599, 4000)]]) })
  assert.equal(low.outcome, 'NO-GO')
  const lowText = [...low.failures, ...formatKillCheck(low)].join('\n')
  assert.doesNotMatch(lowText, /\b90\.0%/)
  assert.match(lowText, /\(89\.98%\), below 90%/)
  assert.match(lowText, /89\.98% \(3599\/4000\) FAIL/)

  // 0.500004 prints as 0.500, over the 0.50 limit
  const warm = verdictOf(
    suiteResults('app-500', { jest: 1000000, registry: 500004, none: 500004 }, FINE_COLD),
  )
  assert.equal(warm.outcome, 'NO-GO')
  const warmText = [...warm.failures, ...formatKillCheck(warm)].join('\n')
  assert.match(warmText, /upper bound 0\.500004 is above 0\.50/)
  assert.match(warmText, /0\.500 \(0\.500-0\.500004\) +FAIL/)

  // 3.0004 prints as 3.000, over the 3.0 limit
  const iso = verdictOf(suiteResults('app-500', { jest: 1000000, registry: 300040, none: 100000 }))
  assert.equal(iso.outcome, 'NO-GO')
  const isoText = [...iso.failures, ...formatKillCheck(iso)].join('\n')
  assert.match(isoText, /registry\/none median ratio 3\.0004 is above 3\.0/)
  assert.match(isoText, /registry\/none warm: median ratio 3\.0004 \(.*\), <=3\.0 FAIL/)
  // a passing value keeps its three decimals
  assert.match(formatKillCheck(verdictOf(passing())).join('\n'), /median ratio 1\.500 \(95% CI/)
})

test('isolation is held to the point ratio, not the CI upper bound', () => {
  const noisy = [100, 100, 100, 100, 290, 290, 290, 500, 500, 500]
  const warm: Walls = { jest: 1000, registry: noisy, none: 100 }
  const verdict = verdictOf(suiteResults('app-500', warm, { jest: 1000, registry: 200, none: 100 }))
  const check = verdict.isolation[0]
  assert.ok(check?.ratio)
  assert.ok(check.ratio.ratio <= 3, `point ratio ${check.ratio.ratio}`)
  assert.ok(check.ratio.high > 3, `upper bound ${check.ratio.high}`)
  assert.equal(check.ok, true)
  assert.equal(verdict.outcome, 'GO')
})

test('each ratio is matched on suite and cache: Jest differs by both', () => {
  const both: KillCheckSuite[] = [{ name: 'app-500' }, { name: 'other' }]
  const parity = new Map([
    ['app-500', parityOf(10, 10)],
    ['other', parityOf(10, 10)],
  ])
  const verdict = verdictOf(
    [
      ...suiteResults(
        'app-500',
        { jest: 100, registry: 40, none: 20 },
        { jest: 400, registry: 200, none: 100 },
      ),
      ...suiteResults('other', { jest: 1000, registry: 300 }, { jest: 200, registry: 100 }),
    ],
    { suites: both, parity },
  )
  assert.equal(verdict.outcome, 'GO')
  const ratios = verdict.suites.map((suite) => [suite.warm?.ratio?.ratio, suite.cold?.ratio?.ratio])
  assert.deepEqual(ratios, [
    [0.4, 0.5],
    [0.3, 0.5],
  ])
})

test('a ratio of 1.0 is NO-GO', () => {
  const verdict = verdictOf(suiteResults('app-500', { jest: 100, registry: 100, none: 100 }), {
    dryRun: true,
  })
  assert.equal(verdict.outcome, 'NO-GO')
  assert.equal(verdict.suites[0]?.warm?.ratio?.ratio, 1)
})

test('the report has the literal strings, three decimals, and the label on every line', () => {
  const lines = formatKillCheck(verdictOf(passing(), { suites: R6_SUITES }))
  assert.ok(lines.length > 8)
  assert.ok(
    lines.every((line) => line.startsWith('[local] ')),
    lines.join('\n'),
  )
  const text = lines.join('\n')
  assert.match(
    text,
    /\[local\] suite +parity \(>=90%\) +warm ratio \(95% CI\) +<=0\.50 +cold ratio \(95% CI\) +<=0\.80/,
  )
  assert.match(
    text,
    /app-500 +100\.0% \(4000\/4000\) +0\.300 \(0\.300-0\.300\) +pass +0\.400 \(0\.400-0\.400\) +pass/,
  )
  assert.match(text, /mock-heavy-500 +PENDING: Provino has no jest\.mock until B13c/)
  assert.equal(text.match(/ {2}PENDING:/g)?.length, 6)
  assert.match(
    text,
    /isolation app-500 registry\/none warm: median ratio 1\.500 \(95% CI 1\.500-1\.500\), <=3\.0 pass/,
  )
  assert.match(text, /isolation app-500 registry\/none cold: median ratio 1\.333/)
  assert.match(text, /\[local\] VERDICT: GO, PROVISIONAL \(local\)$/m)
  assert.match(text, /1 of 7 suites measured, 6 PENDING: only a pinned run of all 7 decides GO\./)

  const slow = suiteResults('app-500', { jest: 100, registry: 100, none: 100 })
  const bad = formatKillCheck(verdictOf(slow))
  assert.ok(bad.every((line) => line.startsWith('[local] ')))
  assert.match(bad.join('\n'), /\[local\] NO-GO: app-500 warm/)
  assert.ok(bad.includes('[local] VERDICT: NO-GO, PROVISIONAL (local)'))

  const parityText = (read: StatusParity): string =>
    formatKillCheck(verdictOf(passing(), { parity: new Map([['app-500', read]]) })).join('\n')
  assert.match(parityText(parityOf(899, 1000)), /app-500 +89\.9% \(899\/1000\) FAIL +0\.300/)
  assert.match(parityText(parityOf(0, 0)), /app-500 +no data FAIL +0\.300/)

  const dry = formatKillCheck(
    verdictOf(
      suiteResults(
        'app-500',
        { jest: 100, registry: 100, none: 100 },
        undefined,
        'jest-as-provino',
      ),
      { dryRun: true },
    ),
  )
  assert.ok(dry.includes('[local] VERDICT: NO-GO, PROVISIONAL (local), DRY RUN'))
  assert.match(
    dry.join('\n'),
    /DRY RUN: Jest stood in for Provino \(runner jest-as-provino\).*Parity was not read\./,
  )

  const desktop = formatKillCheck(verdictOf(passing(), { label: 'desktop' }))
  assert.ok(desktop.includes('[desktop] VERDICT: GO, PROVISIONAL (desktop)'))
})
