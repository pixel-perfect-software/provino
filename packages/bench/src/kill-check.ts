// The kill-check's gate: Track 12 R6, as a pure function of a `BenchRecord` and the parity reads.
//
// This code is final (build-plan brief 12): later bundles grow its inputs (more suites run, a
// pinned machine), never its rules. The criterion is DECISIONS D5 and is never edited to pass.
//
// The record `provino-bench kill-check` writes is exactly a `BenchRecord`. It carries no verdict and
// no parity field: the speed and isolation verdict is a pure function of `record.results` (so
// anyone can re-derive it from the file), and parity is printed, because `BenchRecord` doesn't
// hold it and `@provino/types` is not ours to change here.
import type { BenchLabel, BenchRecord, BenchResult } from '@provino/types'
import { BenchError } from './errors.ts'
import { pastLimit } from './internal/limits.ts'
import type { StatusParity } from './parity.ts'
import { formatRatio, table } from './report.ts'
import { type RatioInterval, ratioCi } from './stats.ts'

/**
 * R6's thresholds (DECISIONS D5). Never edited to make a run pass.
 * @public
 */
export interface KillCriterion {
  /** Provino's warm median over Jest's: the CI's upper bound must be at most this. */
  readonly warmMaxRatio: number
  /** The same for a cold run. */
  readonly coldMaxRatio: number
  /** registry over none, on the medians, at most this. */
  readonly isolationMaxRatio: number
  /** The share of Jest's tests whose status Provino matches, at least this (R2). */
  readonly minStatusParity: number
}

/**
 * The criterion: 0.50 warm, 0.80 cold, registry/none 3.0, status parity 0.90.
 * @public
 */
export const KILL_CRITERION: KillCriterion = {
  warmMaxRatio: 0.5,
  coldMaxRatio: 0.8,
  isolationMaxRatio: 3,
  minStatusParity: 0.9,
}

/**
 * One suite of the gate. `pending` says why it can't run yet; a pending suite is listed, never
 * measured, and keeps the verdict provisional.
 * @public
 */
export interface KillCheckSuite {
  readonly name: string
  readonly pending?: string
}

const CORPUS_PENDING =
  'corpus repo: needs the corpus pilot (B16) and the Jest config reader (T11.6, B14)'

/**
 * R6's seven suites: the two synthetic ones and the five corpus repos. The two synthetic ones run
 * today (`mock-heavy-500` from B13c, which gave the loader `jest.mock`).
 * @public
 */
export const R6_SUITES: readonly KillCheckSuite[] = [
  { name: 'app-500' },
  { name: 'mock-heavy-500' },
  { name: 'jest-extended', pending: CORPUS_PENDING },
  { name: 'react-hook-form', pending: CORPUS_PENDING },
  { name: 'mobx', pending: CORPUS_PENDING },
  { name: 'swr', pending: CORPUS_PENDING },
  { name: 'styled-components', pending: CORPUS_PENDING },
]

/**
 * The suite the registry/none ratio is read on.
 * @public
 */
export const ISOLATION_SUITE = 'app-500'

/**
 * The runner id Jest takes in a dry run, in Provino's place. It is never `provino:jest`, so a dry
 * run's record can't be taken for Provino's.
 * @public
 */
export const DRY_RUN_RUNNER = 'jest-as-provino'

type Cache = 'warm' | 'cold'

const MIN_PARITY_PERCENT = KILL_CRITERION.minStatusParity * 100

// A value to `base` decimals, raised past `limit` when it failed (`ok` false).
function shown(value: number, limit: number, ok: boolean, base = 3): string {
  return ok ? value.toFixed(base) : pastLimit(value, limit, base)
}

/**
 * Provino against Jest on one suite and cache state.
 * @public
 */
export interface SpeedCheck {
  readonly cache: Cache
  /** The most the CI's upper bound may be. */
  readonly limit: number
  readonly ok: boolean
  /** Absent when a result is missing or a run failed. */
  readonly ratio?: RatioInterval
  /** Why it failed, as a sentence; absent when it passed. */
  readonly reason?: string
}

/**
 * Status parity on one suite (R2).
 * @public
 */
export interface ParityCheck {
  /** `skipped` on a dry run, where Jest stands in for Provino. It never fails the gate. */
  readonly status: 'pass' | 'fail' | 'skipped'
  readonly matched: number
  readonly total: number
  /** `matched / total`; absent when there is nothing to divide. */
  readonly share?: number
  readonly reason?: string
}

/**
 * One suite's part of the verdict.
 * @public
 */
export type SuiteVerdict =
  | {
      readonly name: string
      /** Why the suite wasn't measured. */
      readonly pending: string
    }
  | {
      readonly name: string
      readonly parity: ParityCheck
      readonly warm: SpeedCheck
      readonly cold: SpeedCheck
    }

type MeasuredVerdict = Exclude<SuiteVerdict, { readonly pending: string }>

function isMeasured(verdict: SuiteVerdict): verdict is MeasuredVerdict {
  return !('pending' in verdict)
}

/**
 * The registry/none check on `ISOLATION_SUITE`, for one cache state. `ratio.ratio` is the point
 * ratio of the medians, which is what is held to the limit; its CI is reported beside it.
 * @public
 */
export interface IsolationCheck extends Omit<SpeedCheck, 'cache'> {
  readonly suite: string
  readonly cache: Cache
}

/**
 * What the gate decided.
 * @public
 */
export interface KillCheckVerdict {
  readonly label: BenchLabel
  readonly dryRun: boolean
  readonly suites: readonly SuiteVerdict[]
  readonly isolation: readonly IsolationCheck[]
  /** One sentence per failed check. Empty exactly when the outcome is `GO`. */
  readonly failures: readonly string[]
  readonly outcome: 'GO' | 'NO-GO'
  /** True unless the record is pinned, every suite ran, and it isn't a dry run. */
  readonly provisional: boolean
  /** R6: the speed condition failed on two or more suites, so Phase 1 stops for a redesign. */
  readonly redesign: boolean
  /** How many suites the speed condition failed on. */
  readonly speedFailedSuites: number
}

// The result a role stands for: `baseline` is Jest, `candidate` is the tier R6 fixes (`registry`),
// and `none` is the same runner with no isolation.
function find(
  record: BenchRecord,
  suite: string,
  cache: Cache,
  role: 'baseline' | 'candidate' | 'none',
): BenchResult | undefined {
  return record.results.find(
    ({ benchId, subject, cache: resultCache }) =>
      benchId === suite &&
      resultCache === cache &&
      (role === 'baseline'
        ? subject.runner === 'jest'
        : subject.isolation === (role === 'candidate' ? 'registry' : 'none')),
  )
}

type Ratio = { readonly ratio: RatioInterval } | { readonly reason: string }

// The ratio of two results, or why there is none: a missing result or a failed run is no number.
function ratioOf(
  numerator: BenchResult | undefined,
  numeratorName: string,
  denominator: BenchResult | undefined,
  denominatorName: string,
): Ratio {
  if (numerator === undefined) return { reason: `no ${numeratorName} result` }
  if (denominator === undefined) return { reason: `no ${denominatorName} result` }
  if (!numerator.ok) return { reason: `the ${numeratorName} result has a failing run` }
  if (!denominator.ok) return { reason: `the ${denominatorName} result has a failing run` }
  try {
    return { ratio: ratioCi(numerator.wall.samplesMs, denominator.wall.samplesMs) }
  } catch (error) {
    if (!(error instanceof BenchError)) throw error
    return { reason: `no ratio from the samples: ${error.message}` }
  }
}

// One check of a ratio against its limit. `held` picks the number held to the limit, `failure` words
// a miss from that number (raised past the limit) and the interval. No ratio is a failure, said so.
function gate(
  record: BenchRecord,
  where: { readonly suite: string; readonly cache: Cache; readonly prefix: string },
  against: { readonly role: 'baseline' | 'none'; readonly name: string },
  limit: number,
  held: (ratio: RatioInterval) => number,
  failure: (heldText: string, ratio: RatioInterval) => string,
): Omit<SpeedCheck, 'cache'> {
  const { suite, cache, prefix } = where
  const got = ratioOf(
    find(record, suite, cache, 'candidate'),
    'Provino registry',
    find(record, suite, cache, against.role),
    against.name,
  )
  if ('reason' in got) {
    return { limit, ok: false, reason: `${prefix}: ${got.reason}, so there is no ratio` }
  }
  const { ratio } = got
  const ok = held(ratio) <= limit
  return {
    limit,
    ok,
    ratio,
    ...(ok ? {} : { reason: `${prefix}: ${failure(shown(held(ratio), limit, false), ratio)}` }),
  }
}

function speed(record: BenchRecord, suite: string, cache: Cache): SpeedCheck {
  const limit = cache === 'warm' ? KILL_CRITERION.warmMaxRatio : KILL_CRITERION.coldMaxRatio
  return {
    cache,
    ...gate(
      record,
      { suite, cache, prefix: `${suite} ${cache}` },
      { role: 'baseline', name: 'Jest' },
      limit,
      // The upper bound, not the median: exactly at the limit passes.
      (ratio) => ratio.high,
      (high, ratio) =>
        `the 95% CI's upper bound ${high} is above ${limit.toFixed(2)} (median ratio ${ratio.ratio.toFixed(3)})`,
    ),
  }
}

// R6 3.3 gives the ratio of the medians, with no cache qualifier, while its configuration has both
// a warm and a cold state. The fail-closed reading: both must hold. (R3's upper-bound G-isolation
// is a different gate.)
function isolation(record: BenchRecord, cache: Cache): IsolationCheck {
  const suite = ISOLATION_SUITE
  const limit = KILL_CRITERION.isolationMaxRatio
  return {
    suite,
    cache,
    ...gate(
      record,
      { suite, cache, prefix: `isolation ${suite} ${cache}` },
      { role: 'none', name: 'Provino none' },
      limit,
      (ratio) => ratio.ratio,
      (median) => `registry/none median ratio ${median} is above ${limit.toFixed(1)}`,
    ),
  }
}

// A share as a percentage to one decimal; a failed share never prints as the minimum.
function percent(share: number, ok: boolean): string {
  return `${shown(share * 100, MIN_PARITY_PERCENT, ok, 1)}%`
}

function parityOf(
  suite: string,
  parity: ReadonlyMap<string, StatusParity>,
  dryRun: boolean,
): ParityCheck {
  // Jest against itself proves nothing, so a dry run doesn't read parity and doesn't fail on it.
  if (dryRun) return { status: 'skipped', matched: 0, total: 0 }
  const read = parity.get(suite)
  const fail = (reason: string, matched = 0, total = 0): ParityCheck => ({
    status: 'fail',
    matched,
    total,
    reason: `${suite} parity: ${reason}`,
  })
  if (read === undefined) return fail('no parity was read')
  if (read.unavailable !== undefined) return fail(`could not compare: ${read.unavailable}`)
  if (read.referenceTests === 0) return fail('Jest reported no tests to compare')
  const share = read.statusMatched / read.referenceTests
  const counts = `${read.statusMatched}/${read.referenceTests}`
  const minimum = `${MIN_PARITY_PERCENT.toFixed(0)}%`
  if (share < KILL_CRITERION.minStatusParity) {
    return {
      ...fail(
        `${counts} tests have Jest's status (${percent(share, false)}), below ${minimum}`,
        read.statusMatched,
        read.referenceTests,
      ),
      share,
    }
  }
  return { status: 'pass', matched: read.statusMatched, total: read.referenceTests, share }
}

/**
 * Applies R6 to a record. It reads `record.results` only, finding each result by suite
 * (`benchId`), cache state and role: Jest is the baseline, Provino at `registry` the candidate and
 * at `none` the no-isolation subject.
 *
 * - Speed, per measured suite, warm and cold: the upper bound of the 95% CI of the candidate/Jest
 *   median ratio is at most the threshold. A missing result or a failing run fails with no ratio.
 * - Isolation, on `ISOLATION_SUITE`: the registry/none ratio of the medians is at most 3.0, warm
 *   and cold.
 * - Parity (R2): at least 90% of Jest's tests have Provino's status on every measured suite, and
 *   anything unreadable fails. A dry run skips it.
 *
 * The outcome is `NO-GO` if any check fails, or if no suite was measured. It stays `provisional`
 * unless the record is pinned, every one of `R6_SUITES` was measured (judged against that list,
 * not the caller's) and it isn't a dry run. `redesign` needs a real speed miss (a ratio over its
 * limit) on two suites and is never set by a dry run.
 * @public
 */
export function evaluateKillCheck(input: {
  readonly record: BenchRecord
  readonly suites: readonly KillCheckSuite[]
  readonly parity: ReadonlyMap<string, StatusParity>
  readonly dryRun: boolean
}): KillCheckVerdict {
  const { record, suites, parity, dryRun } = input
  const verdicts: SuiteVerdict[] = suites.map((suite) =>
    suite.pending === undefined
      ? {
          name: suite.name,
          parity: parityOf(suite.name, parity, dryRun),
          warm: speed(record, suite.name, 'warm'),
          cold: speed(record, suite.name, 'cold'),
        }
      : { name: suite.name, pending: suite.pending },
  )
  const measured = verdicts.filter(isMeasured)
  const isolationChecks = [isolation(record, 'warm'), isolation(record, 'cold')]

  const failures: string[] = []
  let speedFailedSuites = 0
  for (const verdict of measured) {
    const checks = [verdict.warm, verdict.cold]
    // Only a measured ratio over its limit is a speed miss: no result or a failing run timed nothing.
    if (checks.some((check) => check.ratio !== undefined && !check.ok)) speedFailedSuites += 1
    failures.push(...checks.flatMap((check) => (check.reason === undefined ? [] : [check.reason])))
    if (verdict.parity.reason !== undefined) failures.push(verdict.parity.reason)
  }
  for (const check of isolationChecks) {
    if (check.reason !== undefined) failures.push(check.reason)
  }

  if (measured.length === 0) failures.push('no suite was measured, so there is nothing to judge')
  // Completeness is R6's seven suites, not whatever list the caller passed.
  const complete = R6_SUITES.every((required) =>
    suites.some(({ name, pending }) => name === required.name && pending === undefined),
  )
  return {
    label: record.label,
    dryRun,
    suites: verdicts,
    isolation: isolationChecks,
    failures,
    outcome: failures.length === 0 ? 'GO' : 'NO-GO',
    provisional: !(record.label === 'pinned' && complete && !dryRun),
    // R6's last paragraph: two failed suites mean a redesign, not another tuning pass. A dry run
    // is Jest against itself, so it decides nothing.
    redesign: !dryRun && speedFailedSuites >= 2,
    speedFailedSuites,
  }
}

function ratioCell(check: SpeedCheck): string {
  const { ratio } = check
  if (ratio === undefined) return 'no ratio'
  return formatRatio(ratio, 'cell', { high: shown(ratio.high, check.limit, check.ok) })
}

function parityCell(parity: ParityCheck): string {
  if (parity.status === 'skipped') return 'skipped'
  if (parity.share === undefined) return 'no data FAIL'
  const share = `${percent(parity.share, parity.status === 'pass')} (${parity.matched}/${parity.total})`
  return parity.status === 'pass' ? share : `${share} FAIL`
}

/**
 * The gate's report, as lines that each start with the record's label in brackets: the per-suite
 * table (parity, then the warm and cold ratios with their CIs), a PENDING line for each suite that
 * can't run yet, the registry/none lines, one line per failed check, and the verdict. Ratios
 * print to three decimals.
 * @public
 */
export function formatKillCheck(verdict: KillCheckVerdict): readonly string[] {
  const tag = `[${verdict.label}]`
  const warmLimit = `<=${KILL_CRITERION.warmMaxRatio.toFixed(2)}`
  const coldLimit = `<=${KILL_CRITERION.coldMaxRatio.toFixed(2)}`
  const parityHeader = `parity (>=${MIN_PARITY_PERCENT.toFixed(0)}%)`
  const status = (check: SpeedCheck): string => (check.ok ? 'pass' : 'FAIL')
  const measured = verdict.suites.filter(isMeasured)
  const rows: (readonly string[])[] = [
    ['suite', parityHeader, 'warm ratio (95% CI)', warmLimit, 'cold ratio (95% CI)', coldLimit],
    ...measured.map((suite) => [
      suite.name,
      parityCell(suite.parity),
      ratioCell(suite.warm),
      status(suite.warm),
      ratioCell(suite.cold),
      status(suite.cold),
    ]),
  ]
  const out = [
    `${tag} kill-check (Track 12 R6): result reuse off (D19): the results cache only orders files, and every run is a fresh process`,
    ...table(rows).map((line) => `${tag} ${line}`),
  ]
  for (const suite of verdict.suites) {
    if ('pending' in suite) out.push(`${tag} ${suite.name}  PENDING: ${suite.pending}`)
  }
  for (const check of verdict.isolation) {
    const detail =
      check.ratio === undefined
        ? 'no ratio'
        : formatRatio(check.ratio, 'sentence', {
            ratio: shown(check.ratio.ratio, check.limit, check.ok),
          })
    out.push(
      `${tag} isolation ${check.suite} registry/none ${check.cache}: ${detail}, <=${check.limit.toFixed(1)} ${check.ok ? 'pass' : 'FAIL'}`,
    )
  }
  for (const failure of verdict.failures) out.push(`${tag} NO-GO: ${failure}`)
  if (verdict.redesign) {
    out.push(
      `${tag} R6: the speed condition failed on ${verdict.speedFailedSuites} suites, so Phase 1 stops for a redesign (Track 2).${verdict.provisional ? ` (provisional: only a pinned run of all ${R6_SUITES.length} decides that)` : ''}`,
    )
  }
  if (verdict.dryRun) {
    out.push(
      `${tag} DRY RUN: Jest stood in for Provino (runner ${DRY_RUN_RUNNER}), so these ratios are Jest against itself. Parity was not read.`,
    )
  }
  out.push(
    `${tag} VERDICT: ${verdict.outcome}${verdict.provisional ? `, PROVISIONAL (${verdict.label})` : ''}${verdict.dryRun ? ', DRY RUN' : ''}`,
  )
  const total = R6_SUITES.length
  const pending = verdict.suites.length - measured.length
  if (pending > 0 || measured.length < total) {
    out.push(
      `${tag} ${measured.length} of ${total} suites measured${pending > 0 ? `, ${pending} PENDING` : ''}: only a pinned run of all ${total} decides GO.`,
    )
  } else if (verdict.provisional) {
    out.push(`${tag} all ${total} suites measured, but only a pinned run decides GO.`)
  }
  return out
}
