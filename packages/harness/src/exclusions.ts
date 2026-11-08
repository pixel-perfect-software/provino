import { DIFF_KINDS, type DiffKind, type ExclusionRule } from './diff.ts'
import { HarnessError } from './errors.ts'
import { isRecord } from './internal/guards.ts'

/**
 * R2's limits as `parseExclusions` applies them.
 * @public
 */
export interface ExclusionLimits {
  /** `YYYY-MM-DD`: the day the limits are measured from. */
  readonly today: string
  /**
   * Lifts R2's expiry rule, for the harness self-test's calibration rules only (DECISIONS D30):
   * they pin inherent differences between Jest and Vitest, so they have nothing to be re-reviewed
   * against. Corpus runs never pass it.
   */
  readonly calibration?: boolean
}

/**
 * How long an exclusion may stay before it must be re-reviewed (Track 12 R2).
 * @public
 */
export const EXCLUSION_MAX_DAYS = 90

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000
const RULE_KEYS: ReadonlySet<string> = new Set([
  'id',
  'reason',
  'kinds',
  'keyGlob',
  'pair',
  'expires',
  'policyKey',
])

function invalid(source: string, message: string): HarnessError {
  return new HarnessError('HARNESS_EXCLUSIONS_INVALID', `${source}: ${message}`, { path: source })
}

/** A `YYYY-MM-DD` date as epoch milliseconds at UTC midnight, or `undefined` if it isn't one. */
function dayOf(value: string): number | undefined {
  if (!ISO_DATE.test(value)) return undefined
  const time = Date.parse(`${value}T00:00:00Z`)
  // `Date.parse` accepts 2026-02-31 as 2026-03-03; a real date prints back the same.
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value) return undefined
  return time
}

function nonEmptyString(value: unknown, at: string, source: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(source, `${at} must be a non-empty string`)
  }
  return value
}

function kindsOf(value: unknown, at: string, source: string): DiffKind[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid(source, `${at} must be a non-empty array of diff kinds`)
  }
  const kinds: DiffKind[] = []
  for (const kind of value) {
    const known = DIFF_KINDS.find((k) => k === kind)
    if (known === undefined) {
      throw invalid(
        source,
        `${at} has ${JSON.stringify(kind)}, not one of ${DIFF_KINDS.join(', ')}`,
      )
    }
    kinds.push(known)
  }
  return kinds
}

function pairOf(value: unknown, at: string, source: string): readonly [string, string] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== 'string' ||
    typeof value[1] !== 'string'
  ) {
    throw invalid(source, `${at} must be [reference runner, candidate runner]`)
  }
  return [value[0], value[1]]
}

function ruleOf(
  value: unknown,
  index: number,
  source: string,
  limits: ExclusionLimits,
  today: number,
): ExclusionRule {
  const at = `rules[${index}]`
  if (!isRecord(value)) throw invalid(source, `${at} must be an object`)
  for (const key of Object.keys(value)) {
    if (!RULE_KEYS.has(key)) throw invalid(source, `${at} has an unknown key "${key}"`)
  }
  const id = nonEmptyString(value.id, `${at}.id`, source)
  const reason = nonEmptyString(value.reason, `${at}.reason`, source)
  const kinds = kindsOf(value.kinds, `${at}.kinds`, source)
  const keyGlob =
    value.keyGlob === undefined ? undefined : nonEmptyString(value.keyGlob, `${at}.keyGlob`, source)
  const pair = value.pair === undefined ? undefined : pairOf(value.pair, `${at}.pair`, source)
  const policyKey =
    value.policyKey === undefined
      ? undefined
      : nonEmptyString(value.policyKey, `${at}.policyKey`, source)
  let expires: string | undefined
  if (value.expires !== undefined) {
    const day = typeof value.expires === 'string' ? dayOf(value.expires) : undefined
    if (typeof value.expires !== 'string' || day === undefined) {
      throw invalid(source, `${at}.expires must be a YYYY-MM-DD date`)
    }
    expires = value.expires
    if (limits.calibration !== true && day - today > EXCLUSION_MAX_DAYS * DAY_MS) {
      throw invalid(
        source,
        `${id} expires ${expires}, more than ${EXCLUSION_MAX_DAYS} days after ${limits.today} (Track 12 R2)`,
      )
    }
  } else if (limits.calibration !== true) {
    throw invalid(
      source,
      `${id} has no "expires": every exclusion must expire within ${EXCLUSION_MAX_DAYS} days (Track 12 R2)`,
    )
  }
  return {
    id,
    reason,
    kinds,
    ...(keyGlob === undefined ? {} : { keyGlob }),
    ...(pair === undefined ? {} : { pair }),
    ...(expires === undefined ? {} : { expires }),
    ...(policyKey === undefined ? {} : { policyKey }),
  }
}

/**
 * Reads an exclusions file, `{ "rules": [ExclusionRule, ...] }`, and checks Track 12 R2's limit on
 * each rule: an `expires` date no more than 90 days after `limits.today`. A rule already past its
 * date is accepted here; `diffRuns` lists it as expired and lets it exclude nothing. With
 * `limits.calibration` a rule may have no date or a later one (DECISIONS D30). Ids must be unique,
 * kinds known and keys known. Anything else is `HARNESS_EXCLUSIONS_INVALID` naming the rule.
 * @public
 */
export function parseExclusions(
  text: string,
  source: string,
  limits: ExclusionLimits,
): ExclusionRule[] {
  const today = dayOf(limits.today)
  if (today === undefined) {
    throw new HarnessError(
      'HARNESS_BAD_DATE',
      `today must be a YYYY-MM-DD date, got "${limits.today}"`,
    )
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new HarnessError('HARNESS_EXCLUSIONS_INVALID', `${source} is not valid JSON`, {
      path: source,
      cause,
    })
  }
  if (!isRecord(value) || !Array.isArray(value.rules)) {
    throw invalid(source, 'must be an object with a "rules" array')
  }
  for (const key of Object.keys(value)) {
    if (key !== 'rules') throw invalid(source, `has an unknown key "${key}"`)
  }
  const rules = value.rules.map((rule, index) => ruleOf(rule, index, source, limits, today))
  const seen = new Set<string>()
  for (const rule of rules) {
    if (seen.has(rule.id)) throw invalid(source, `two rules have the id "${rule.id}"`)
    seen.add(rule.id)
  }
  return rules
}

/**
 * Reads a flaky list, `{ "keys": ["file::a › b#0", ...] }` (the file B16's reference runs write;
 * Track 12 R1). `HARNESS_FLAKY_INVALID` for anything else.
 * @public
 */
export function parseFlaky(text: string, source: string): string[] {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new HarnessError('HARNESS_FLAKY_INVALID', `${source} is not valid JSON`, {
      path: source,
      cause,
    })
  }
  const keys = isRecord(value) ? value.keys : undefined
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== 'keys') ||
    !Array.isArray(keys) ||
    !keys.every((key): key is string => typeof key === 'string' && key.includes('::'))
  ) {
    throw new HarnessError(
      'HARNESS_FLAKY_INVALID',
      `${source} must be { "keys": [test key, ...] }, each key a test key (file::path#n)`,
      { path: source },
    )
  }
  return keys
}
