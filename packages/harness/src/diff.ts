import type {
  ConsoleEntry,
  NormalizedError,
  NormalizedFile,
  NormalizedRun,
  NormalizedTest,
  RunnerId,
  TraceEntry,
} from '@provino/types'
import { HarnessError } from './errors.ts'
import { compareStrings, escapeRegExp } from './internal/guards.ts'
import { testKey } from './normalize.ts'

/**
 * What differs between a reference run and a candidate run.
 *
 * - `status`: a test's status differs.
 * - `error-count`, `message`, `matcher`, `user-frame`: a test failed in both runs and its errors
 *   differ.
 * - `passing-assertions`: both runs report a count and the counts differ.
 * - `console`, `trace`: console output or the hook trace differs (only compared on request).
 * - `snapshot`: a snapshot file's sha256 differs, or it is missing from the candidate.
 * - `file-status`: a file's status differs, or the file is in one run only.
 * - `missing-in-candidate`, `missing-in-reference`: a test is in one run only.
 * @public
 */
export type DiffKind =
  | 'status'
  | 'error-count'
  | 'message'
  | 'matcher'
  | 'user-frame'
  | 'passing-assertions'
  | 'console'
  | 'snapshot'
  | 'trace'
  | 'file-status'
  | 'missing-in-candidate'
  | 'missing-in-reference'

/**
 * One checked-in exclusion (Track 12 R2). It removes the diffs it matches from the parity
 * numbers and lists them as excluded. `expires` is `YYYY-MM-DD`; a rule past its date excludes
 * nothing and is reported.
 * @public
 */
export interface ExclusionRule {
  readonly id: string
  readonly reason: string
  /** The kinds of diff it excludes. */
  readonly kinds: readonly DiffKind[]
  /** `*` matches any run of characters (`/` included), `?` one character. Default: every key. */
  readonly keyGlob?: string
  /** Only for this `[reference runner, candidate runner]` pair. Default: every pair. */
  readonly pair?: readonly [RunnerId, RunnerId]
  readonly expires?: string
  /**
   * The policy key whose dialect values explain the difference, where one does (Track 12 R2), as
   * its path in the policy: `core.hooks.beforeAllError`, `mock.resetTo`.
   */
  readonly policyKey?: string
}

/**
 * How `diffRuns` compares.
 *
 * `messageMode` decides what makes two failures equal: `exact` compares the error count, then
 * each error's normalized message and user frame; `matcher` the error count, then each error's
 * matcher (when both runs name one) and user frame; `none` only the error count.
 * @public
 */
export interface DiffOptions {
  readonly messageMode: 'exact' | 'matcher' | 'none'
  readonly compareConsole: boolean
  readonly compareTrace: boolean
  readonly exclusions: readonly ExclusionRule[]
  /**
   * Test keys whose reference status is flaky (Track 12 R1: it differs across reference runs).
   * They are left out of T, and nothing about them is reported as a diff. Default: none.
   */
  readonly flaky?: readonly string[]
}

/**
 * One difference between the runs. `key` is a test key (`file::a › b#0`) for a test, or a
 * POSIX file path for a file or a snapshot file.
 * @public
 */
export interface ParityDiff {
  readonly key: string
  readonly kind: DiffKind
  /** What the reference run had: a status, a message, a hash. Absent when it had nothing. */
  readonly ref?: string
  /** What the candidate run had. */
  readonly cand?: string
  /** Which error, when a test has more than one. */
  readonly index?: number
}

/**
 * A diff that an exclusion rule removed from the parity numbers.
 * @public
 */
export interface ExcludedDiff extends ParityDiff {
  /** The `id` of the first rule that matched. */
  readonly ruleId: string
}

/**
 * A rule past its `expires` date. It excludes nothing.
 * @public
 */
export interface ExpiredExclusion {
  readonly id: string
  readonly expires: string
}

/**
 * Who was compared.
 * @public
 */
export interface RunIdentity {
  readonly runner: RunnerId
  readonly runnerVersion: string
  readonly suite: string
}

/**
 * The sizes behind the parity numbers.
 * @public
 */
export interface ParityCounts {
  /** Tests in the reference run. */
  readonly referenceTests: number
  /** |T|: the reference tests left after exclusions. */
  readonly comparedTests: number
  /**
   * |E|: the reference tests removed from T (`referenceTests - comparedTests`): the flaky ones,
   * and those with an excluded `status` or `missing-in-candidate` diff. An excluded error diff
   * keeps its test in T, so it does not count here.
   */
  readonly excluded: number
  /** The reference tests in E because `DiffOptions.flaky` names them. */
  readonly flaky: number
  /** Tests that only the candidate has. Reported, never counted. */
  readonly candidateOnlyTests: number
  /** Tests in T whose status matches. */
  readonly statusMatched: number
  /** |F|: tests in T that failed in both runs. */
  readonly failedInBoth: number
  /** Tests in F whose errors are equal under `messageMode`. */
  readonly messageMatched: number
  /** |S|: snapshot files the reference left, minus excluded ones. */
  readonly snapshotFiles: number
  readonly snapshotMatched: number
  /** Files in either run. */
  readonly files: number
  readonly filesMatched: number
}

/**
 * The result of `diffRuns` (Track 12 R1 and R2). A parity is a share between 0 and 1; when its
 * denominator is empty it is 1, and `counts` shows the zero.
 *
 * - `statusParity`: |{t in T: same status}| / |T|, where T is the reference tests minus the ones
 *   with an excluded `status` or `missing-in-candidate` diff. A test the candidate lacks is a
 *   mismatch.
 * - `messageParity`: over the tests in T that failed in both runs, minus the ones with an excluded
 *   error diff, the share whose errors are equal under `messageMode`.
 * - `snapshotByteParity`: over the snapshot files the reference left, the share the candidate
 *   left with the same sha256.
 * - `suitePass`: the runs agree on every file's status.
 * @public
 */
export interface ParityReport {
  readonly reference: RunIdentity
  readonly candidate: RunIdentity
  readonly messageMode: DiffOptions['messageMode']
  readonly statusParity: number
  readonly messageParity: number
  readonly snapshotByteParity: number
  readonly suitePass: boolean
  readonly counts: ParityCounts
  /** The diffs no rule excluded, sorted by key. These fail the comparison. */
  readonly diffs: readonly ParityDiff[]
  readonly excluded: readonly ExcludedDiff[]
  readonly expiredExclusions: readonly ExpiredExclusion[]
}

const STATUS_FAMILY: ReadonlySet<DiffKind> = new Set<DiffKind>(['status', 'missing-in-candidate'])
const MESSAGE_FAMILY: ReadonlySet<DiffKind> = new Set<DiffKind>([
  'error-count',
  'message',
  'matcher',
  'user-frame',
])

const SNAPSHOT_FAMILY: ReadonlySet<DiffKind> = new Set<DiffKind>(['snapshot'])
const FILE_STATUS_FAMILY: ReadonlySet<DiffKind> = new Set<DiffKind>(['file-status'])

const KIND_ORDER: readonly DiffKind[] = [
  'file-status',
  'missing-in-candidate',
  'missing-in-reference',
  'status',
  'error-count',
  'message',
  'matcher',
  'user-frame',
  'passing-assertions',
  'console',
  'trace',
  'snapshot',
]

/**
 * Every diff kind, in the order a report lists them.
 * @public
 */
export const DIFF_KINDS: readonly DiffKind[] = KIND_ORDER

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function checkDate(value: string, label: string): string {
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new HarnessError(
      'HARNESS_BAD_DATE',
      `${label} must be a YYYY-MM-DD date, got "${value}"`,
      {
        path: label,
      },
    )
  }
  return value
}

function globToRegExp(glob: string): RegExp {
  const source = [...glob]
    .map((char) => (char === '*' ? '.*' : char === '?' ? '.' : escapeRegExp(char)))
    .join('')
  return new RegExp(`^${source}$`, 's')
}

interface CompiledRule {
  readonly rule: ExclusionRule
  readonly glob: RegExp | undefined
}

function compileRules(
  exclusions: readonly ExclusionRule[],
  today: string,
): { active: CompiledRule[]; expired: ExpiredExclusion[] } {
  const active: CompiledRule[] = []
  const expired: ExpiredExclusion[] = []
  for (const rule of exclusions) {
    if (
      rule.expires !== undefined &&
      checkDate(rule.expires, `exclusion ${rule.id} expires`) < today
    ) {
      expired.push({ id: rule.id, expires: rule.expires })
    } else {
      active.push({
        rule,
        glob: rule.keyGlob === undefined ? undefined : globToRegExp(rule.keyGlob),
      })
    }
  }
  return { active, expired }
}

function matchRule(
  diff: ParityDiff,
  rules: readonly CompiledRule[],
  pair: readonly [RunnerId, RunnerId],
): string | undefined {
  for (const { rule, glob } of rules) {
    if (!rule.kinds.includes(diff.kind)) continue
    if (rule.pair !== undefined && (rule.pair[0] !== pair[0] || rule.pair[1] !== pair[1])) continue
    if (glob !== undefined && !glob.test(diff.key)) continue
    return rule.id
  }
  return undefined
}

/** Records a diff. A `ref`, `cand` or `index` that is `undefined` is left off. */
function add(
  out: ParityDiff[],
  key: string,
  kind: DiffKind,
  ref?: string,
  cand?: string,
  index?: number,
): void {
  out.push({
    key,
    kind,
    ...(ref === undefined ? {} : { ref }),
    ...(cand === undefined ? {} : { cand }),
    ...(index === undefined ? {} : { index }),
  })
}

/**
 * A Provino candidate reports what Jest's JSON reports (matcher names, passing-assertion counts),
 * so one that leaves a field out is a difference; Vitest's JSON has neither field, so for any other
 * candidate a missing field can't disagree. Read by name only here, in a dev package (S4).
 */
function holdsToEveryField(cand: NormalizedRun): boolean {
  return cand.runner.startsWith('provino:')
}

function diffErrors(
  out: ParityDiff[],
  key: string,
  ref: readonly NormalizedError[],
  cand: readonly NormalizedError[],
  mode: DiffOptions['messageMode'],
  strict: boolean,
): void {
  if (ref.length !== cand.length) {
    add(out, key, 'error-count', String(ref.length), String(cand.length))
    return
  }
  if (mode === 'none') return
  ref.forEach((r, index) => {
    const c = cand[index]
    if (c === undefined) return
    if (mode === 'exact' && r.message !== c.message) {
      add(out, key, 'message', r.message, c.message, index)
    }
    // A runner that reports no matcher name (Vitest's JSON) can't disagree about it; a Provino
    // candidate that names none where the reference names one does.
    if (
      mode === 'matcher' &&
      r.matcher !== undefined &&
      (c.matcher === undefined ? strict : r.matcher !== c.matcher)
    ) {
      add(out, key, 'matcher', r.matcher, c.matcher, index)
    }
    if (r.userFrame !== c.userFrame) {
      add(out, key, 'user-frame', r.userFrame, c.userFrame, index)
    }
  })
}

function consoleLines(entries: readonly ConsoleEntry[] | undefined): string[] {
  return (entries ?? []).map((entry) => `${entry.stream}: ${entry.text}`)
}

function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i])
}

function fileConsole(file: NormalizedFile): string[] {
  return [...consoleLines(file.console), ...file.tests.flatMap((t) => consoleLines(t.console))]
}

function traceLines(entries: readonly TraceEntry[] | undefined): string[] {
  return (entries ?? []).map(
    (e) =>
      `${e.kind} ${e.owner.join(' › ')}${e.label === undefined ? '' : ` ${e.label}`}${e.outcome === undefined ? '' : ` ${e.outcome}`}`,
  )
}

function joined(lines: readonly string[]): string {
  return lines.join('\n')
}

function diffTest(
  out: ParityDiff[],
  key: string,
  r: NormalizedTest,
  c: NormalizedTest,
  options: DiffOptions,
  strict: boolean,
): void {
  if (r.status !== c.status) add(out, key, 'status', r.status, c.status)
  if (r.status === 'failed' && c.status === 'failed') {
    diffErrors(out, key, r.errors, c.errors, options.messageMode, strict)
  }
  // Only a runner that counts assertions (Jest, and Provino's Jest dialect) can disagree; a
  // Provino candidate that has no count where the reference has one disagrees too.
  if (
    r.passingAssertions !== undefined &&
    (c.passingAssertions === undefined ? strict : r.passingAssertions !== c.passingAssertions)
  ) {
    add(
      out,
      key,
      'passing-assertions',
      String(r.passingAssertions),
      c.passingAssertions === undefined ? undefined : String(c.passingAssertions),
    )
  }
}

/**
 * Console output is compared per test when both runs attribute any to tests in the file, else for
 * the file as a whole, as a sorted multiset (Jest attributes nothing; concurrent tests have no
 * defined order). The model has no marker for concurrent tests, so attributed output is compared
 * in sequence.
 */
function diffConsole(
  out: ParityDiff[],
  rf: NormalizedFile,
  cf: NormalizedFile,
  tests: ReadonlyMap<string, NormalizedTest>,
): void {
  const attributed = (file: NormalizedFile): boolean =>
    file.tests.some((t) => (t.console?.length ?? 0) > 0)
  if (attributed(rf) && attributed(cf)) {
    for (const r of rf.tests) {
      const key = testKey(r.id)
      const c = tests.get(key)
      if (c === undefined) continue
      const ref = consoleLines(r.console)
      const cand = consoleLines(c.console)
      if (!sameSequence(ref, cand)) {
        add(out, key, 'console', joined(ref), joined(cand))
      }
    }
    const ref = consoleLines(rf.console)
    const cand = consoleLines(cf.console)
    if (!sameSequence(ref, cand)) {
      add(out, rf.file, 'console', joined(ref), joined(cand))
    }
    return
  }
  const ref = fileConsole(rf).toSorted(compareStrings)
  const cand = fileConsole(cf).toSorted(compareStrings)
  if (!sameSequence(ref, cand)) {
    add(out, rf.file, 'console', joined(ref), joined(cand))
  }
}

/** Tests by key. Two tests with one key would hide each other, so that is an error. */
function indexTests(
  run: NormalizedRun,
  side: 'reference' | 'candidate',
): Map<string, NormalizedTest> {
  const tests = new Map<string, NormalizedTest>()
  for (const file of run.files) {
    for (const test of file.tests) {
      const key = testKey(test.id)
      if (tests.has(key)) {
        throw new HarnessError(
          'HARNESS_DUPLICATE_TEST_KEY',
          `the ${side} run (${run.runner}, suite ${run.suite}) has two tests with the key "${key}"`,
          { path: file.file },
        )
      }
      tests.set(key, test)
    }
  }
  return tests
}

function diffSnapshots(out: ParityDiff[], ref: NormalizedRun, cand: NormalizedRun): void {
  const candFiles = new Map((cand.snapshots?.files ?? []).map((f) => [f.file, f.sha256]))
  const refFiles = new Set<string>()
  for (const file of ref.snapshots?.files ?? []) {
    refFiles.add(file.file)
    const sha = candFiles.get(file.file)
    if (sha !== file.sha256) add(out, file.file, 'snapshot', file.sha256, sha)
  }
  // A file only the candidate left is reported, not counted.
  for (const [file, sha] of candFiles) {
    if (!refFiles.has(file)) add(out, file, 'snapshot', undefined, sha)
  }
}

function sortDiffs<T extends ParityDiff>(diffs: readonly T[]): T[] {
  return diffs.toSorted(
    (a, b) =>
      compareStrings(a.key, b.key) ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      (a.index ?? 0) - (b.index ?? 0),
  )
}

function share(matched: number, total: number): number {
  return total === 0 ? 1 : matched / total
}

function identityOf(run: NormalizedRun): RunIdentity {
  return { runner: run.runner, runnerVersion: run.runnerVersion, suite: run.suite }
}

/**
 * Compares a candidate run with a reference run, test by test, by `testKey` (Track 12 R1 and
 * R2). Durations are recorded, never compared. `today` is `YYYY-MM-DD` and decides which
 * exclusions have expired; it defaults to the current UTC date.
 * @public
 */
export function diffRuns(
  ref: NormalizedRun,
  cand: NormalizedRun,
  options: DiffOptions,
  today: string = new Date().toISOString().slice(0, 10),
): ParityReport {
  const { active, expired } = compileRules(options.exclusions, checkDate(today, 'today'))
  const found: ParityDiff[] = []
  const refTests = indexTests(ref, 'reference')
  const candTests = indexTests(cand, 'candidate')
  const candFiles = new Map(cand.files.map((f) => [f.file, f]))
  const refFileNames = new Set(ref.files.map((f) => f.file))
  const strict = holdsToEveryField(cand)
  const flaky = new Set(options.flaky ?? [])

  for (const [key, r] of refTests) {
    const c = candTests.get(key)
    if (c === undefined) add(found, key, 'missing-in-candidate', r.status, undefined)
    else diffTest(found, key, r, c, options, strict)
  }
  for (const [key, c] of candTests) {
    if (!refTests.has(key)) add(found, key, 'missing-in-reference', undefined, c.status)
  }

  for (const rf of ref.files) {
    const cf = candFiles.get(rf.file)
    if (cf === undefined) {
      add(found, rf.file, 'file-status', rf.status, 'missing')
      continue
    }
    if (rf.status !== cf.status) {
      add(found, rf.file, 'file-status', rf.status, cf.status)
    }
    if (options.compareConsole) diffConsole(found, rf, cf, candTests)
    if (options.compareTrace) {
      const refTrace = traceLines(rf.trace)
      const candTrace = traceLines(cf.trace)
      if (!sameSequence(refTrace, candTrace)) {
        add(found, rf.file, 'trace', joined(refTrace), joined(candTrace))
      }
    }
  }
  for (const cf of cand.files) {
    if (!refFileNames.has(cf.file)) {
      add(found, cf.file, 'file-status', 'missing', cf.status)
    }
  }
  diffSnapshots(found, ref, cand)

  const pair = [ref.runner, cand.runner] as const
  const failing: ParityDiff[] = []
  const excluded: ExcludedDiff[] = []
  // A flaky test is out of parity altogether (R1): its diffs are neither failing nor excluded.
  // Test keys hold `::` and file keys don't, so this never drops a file's diff.
  for (const diff of found.filter((d) => !flaky.has(d.key))) {
    const ruleId = matchRule(diff, active, pair)
    if (ruleId === undefined) failing.push(diff)
    else excluded.push({ ...diff, ruleId })
  }

  const keysOf = (diffs: readonly ParityDiff[], family: ReadonlySet<DiffKind>): Set<string> =>
    new Set(diffs.filter((d) => family.has(d.kind)).map((d) => d.key))
  const statusExcluded = keysOf(excluded, STATUS_FAMILY)
  const messageExcluded = keysOf(excluded, MESSAGE_FAMILY)
  const statusFailing = keysOf(failing, STATUS_FAMILY)
  const messageFailing = keysOf(failing, MESSAGE_FAMILY)

  const compared = [...refTests].filter(([key]) => !statusExcluded.has(key) && !flaky.has(key))
  const flakyInReference = [...refTests.keys()].filter((key) => flaky.has(key)).length
  const statusMatched = compared.filter(([key]) => !statusFailing.has(key)).length
  // A test leaves F only when every one of its message-family diffs is excluded. An excluded
  // `message` diff must not hide a failing `user-frame`, `matcher` or `error-count` diff.
  const failedInBoth = compared.filter(([key, r]) => {
    const c = candTests.get(key)
    const allExcluded = messageExcluded.has(key) && !messageFailing.has(key)
    return r.status === 'failed' && c?.status === 'failed' && !allExcluded
  })
  const messageMatched = failedInBoth.filter(([key]) => !messageFailing.has(key)).length

  const snapshotExcluded = keysOf(excluded, SNAPSHOT_FAMILY)
  const snapshotRef = (ref.snapshots?.files ?? []).filter((f) => !snapshotExcluded.has(f.file))
  const snapshotFailing = keysOf(failing, SNAPSHOT_FAMILY)
  const snapshotMatched = snapshotRef.filter((f) => !snapshotFailing.has(f.file)).length

  const allFiles = new Set([...refFileNames, ...candFiles.keys()])
  const fileFailing = keysOf(failing, FILE_STATUS_FAMILY)

  return {
    reference: identityOf(ref),
    candidate: identityOf(cand),
    messageMode: options.messageMode,
    statusParity: share(statusMatched, compared.length),
    messageParity: share(messageMatched, failedInBoth.length),
    snapshotByteParity: share(snapshotMatched, snapshotRef.length),
    suitePass: fileFailing.size === 0,
    counts: {
      referenceTests: refTests.size,
      comparedTests: compared.length,
      excluded: refTests.size - compared.length,
      flaky: flakyInReference,
      candidateOnlyTests: [...candTests.keys()].filter((key) => !refTests.has(key)).length,
      statusMatched,
      failedInBoth: failedInBoth.length,
      messageMatched,
      snapshotFiles: snapshotRef.length,
      snapshotMatched,
      files: allFiles.size,
      filesMatched: allFiles.size - fileFailing.size,
    },
    diffs: sortDiffs(failing),
    excluded: sortDiffs(excluded),
    expiredExclusions: expired,
  }
}
