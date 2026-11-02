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
import { compareStrings } from './internal/guards.ts'
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
   * |E|: the reference tests an exclusion removed from T, by an excluded `status` or
   * `missing-in-candidate` diff (`referenceTests - comparedTests`). An excluded error diff keeps
   * its test in T, so it does not count here.
   */
  readonly excluded: number
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

type Scope = 'test' | 'file' | 'snapshot'

interface RawDiff extends ParityDiff {
  readonly scope: Scope
}

const STATUS_FAMILY: ReadonlySet<DiffKind> = new Set<DiffKind>(['status', 'missing-in-candidate'])
const MESSAGE_FAMILY: ReadonlySet<DiffKind> = new Set<DiffKind>([
  'error-count',
  'message',
  'matcher',
  'user-frame',
])

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
    .map((char) =>
      char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&'),
    )
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
  diff: RawDiff,
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

function pushError(
  out: RawDiff[],
  key: string,
  kind: DiffKind,
  ref: string | undefined,
  cand: string | undefined,
  index?: number,
): void {
  out.push({
    scope: 'test',
    key,
    kind,
    ...(ref === undefined ? {} : { ref }),
    ...(cand === undefined ? {} : { cand }),
    ...(index === undefined ? {} : { index }),
  })
}

function diffErrors(
  out: RawDiff[],
  key: string,
  ref: readonly NormalizedError[],
  cand: readonly NormalizedError[],
  mode: DiffOptions['messageMode'],
): void {
  if (ref.length !== cand.length) {
    pushError(out, key, 'error-count', String(ref.length), String(cand.length))
    return
  }
  if (mode === 'none') return
  ref.forEach((r, index) => {
    const c = cand[index]
    if (c === undefined) return
    if (mode === 'exact' && r.message !== c.message) {
      pushError(out, key, 'message', r.message, c.message, index)
    }
    // A runner that reports no matcher name (Vitest's JSON) can't disagree about it.
    if (
      mode === 'matcher' &&
      r.matcher !== undefined &&
      c.matcher !== undefined &&
      r.matcher !== c.matcher
    ) {
      pushError(out, key, 'matcher', r.matcher, c.matcher, index)
    }
    if (r.userFrame !== c.userFrame) {
      pushError(out, key, 'user-frame', r.userFrame, c.userFrame, index)
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
  out: RawDiff[],
  key: string,
  r: NormalizedTest,
  c: NormalizedTest,
  options: DiffOptions,
): void {
  if (r.status !== c.status) pushError(out, key, 'status', r.status, c.status)
  if (r.status === 'failed' && c.status === 'failed') {
    diffErrors(out, key, r.errors, c.errors, options.messageMode)
  }
  // Only a runner that counts assertions (Jest, and Provino's Jest dialect) can disagree.
  if (
    r.passingAssertions !== undefined &&
    c.passingAssertions !== undefined &&
    r.passingAssertions !== c.passingAssertions
  ) {
    pushError(
      out,
      key,
      'passing-assertions',
      String(r.passingAssertions),
      String(c.passingAssertions),
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
  out: RawDiff[],
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
        out.push({ scope: 'test', key, kind: 'console', ref: joined(ref), cand: joined(cand) })
      }
    }
    const ref = consoleLines(rf.console)
    const cand = consoleLines(cf.console)
    if (!sameSequence(ref, cand)) {
      out.push({
        scope: 'file',
        key: rf.file,
        kind: 'console',
        ref: joined(ref),
        cand: joined(cand),
      })
    }
    return
  }
  const ref = fileConsole(rf).toSorted(compareStrings)
  const cand = fileConsole(cf).toSorted(compareStrings)
  if (!sameSequence(ref, cand)) {
    out.push({ scope: 'file', key: rf.file, kind: 'console', ref: joined(ref), cand: joined(cand) })
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

function diffSnapshots(out: RawDiff[], ref: NormalizedRun, cand: NormalizedRun): void {
  const candFiles = new Map((cand.snapshots?.files ?? []).map((f) => [f.file, f.sha256]))
  const refFiles = new Set<string>()
  for (const file of ref.snapshots?.files ?? []) {
    refFiles.add(file.file)
    const sha = candFiles.get(file.file)
    if (sha !== file.sha256) {
      out.push({
        scope: 'snapshot',
        key: file.file,
        kind: 'snapshot',
        ref: file.sha256,
        ...(sha === undefined ? {} : { cand: sha }),
      })
    }
  }
  // A file only the candidate left is reported, not counted.
  for (const [file, sha] of candFiles) {
    if (!refFiles.has(file)) out.push({ scope: 'snapshot', key: file, kind: 'snapshot', cand: sha })
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

function publicDiff(diff: RawDiff): ParityDiff {
  return {
    key: diff.key,
    kind: diff.kind,
    ...(diff.ref === undefined ? {} : { ref: diff.ref }),
    ...(diff.cand === undefined ? {} : { cand: diff.cand }),
    ...(diff.index === undefined ? {} : { index: diff.index }),
  }
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
  const raw: RawDiff[] = []
  const refTests = indexTests(ref, 'reference')
  const candTests = indexTests(cand, 'candidate')
  const candFiles = new Map(cand.files.map((f) => [f.file, f]))
  const refFileNames = new Set(ref.files.map((f) => f.file))

  for (const [key, r] of refTests) {
    const c = candTests.get(key)
    if (c === undefined) pushError(raw, key, 'missing-in-candidate', r.status, undefined)
    else diffTest(raw, key, r, c, options)
  }
  for (const [key, c] of candTests) {
    if (!refTests.has(key)) pushError(raw, key, 'missing-in-reference', undefined, c.status)
  }

  for (const rf of ref.files) {
    const cf = candFiles.get(rf.file)
    if (cf === undefined) {
      raw.push({
        scope: 'file',
        key: rf.file,
        kind: 'file-status',
        ref: rf.status,
        cand: 'missing',
      })
      continue
    }
    if (rf.status !== cf.status) {
      raw.push({
        scope: 'file',
        key: rf.file,
        kind: 'file-status',
        ref: rf.status,
        cand: cf.status,
      })
    }
    if (options.compareConsole) diffConsole(raw, rf, cf, candTests)
    if (options.compareTrace) {
      const refTrace = traceLines(rf.trace)
      const candTrace = traceLines(cf.trace)
      if (!sameSequence(refTrace, candTrace)) {
        raw.push({
          scope: 'file',
          key: rf.file,
          kind: 'trace',
          ref: joined(refTrace),
          cand: joined(candTrace),
        })
      }
    }
  }
  for (const cf of cand.files) {
    if (!refFileNames.has(cf.file)) {
      raw.push({
        scope: 'file',
        key: cf.file,
        kind: 'file-status',
        ref: 'missing',
        cand: cf.status,
      })
    }
  }
  diffSnapshots(raw, ref, cand)

  const pair = [ref.runner, cand.runner] as const
  const failing: RawDiff[] = []
  const excluded: ExcludedDiff[] = []
  for (const diff of raw) {
    const ruleId = matchRule(diff, active, pair)
    if (ruleId === undefined) failing.push(diff)
    else excluded.push({ ...publicDiff(diff), ruleId })
  }

  const keysOf = (diffs: readonly ParityDiff[], family: ReadonlySet<DiffKind>): Set<string> =>
    new Set(diffs.filter((d) => family.has(d.kind)).map((d) => d.key))
  const statusExcluded = keysOf(excluded, STATUS_FAMILY)
  const messageExcluded = keysOf(excluded, MESSAGE_FAMILY)
  const statusFailing = keysOf(failing, STATUS_FAMILY)
  const messageFailing = keysOf(failing, MESSAGE_FAMILY)

  const compared = [...refTests].filter(([key]) => !statusExcluded.has(key))
  const statusMatched = compared.filter(([key]) => !statusFailing.has(key)).length
  // A test leaves F only when every one of its message-family diffs is excluded. An excluded
  // `message` diff must not hide a failing `user-frame`, `matcher` or `error-count` diff.
  const failedInBoth = compared.filter(([key, r]) => {
    const c = candTests.get(key)
    const allExcluded = messageExcluded.has(key) && !messageFailing.has(key)
    return r.status === 'failed' && c?.status === 'failed' && !allExcluded
  })
  const messageMatched = failedInBoth.filter(([key]) => !messageFailing.has(key)).length

  const snapshotRef = (ref.snapshots?.files ?? []).filter(
    (f) => !excluded.some((d) => d.kind === 'snapshot' && d.key === f.file),
  )
  const snapshotFailing = new Set(failing.filter((d) => d.kind === 'snapshot').map((d) => d.key))
  const snapshotMatched = snapshotRef.filter((f) => !snapshotFailing.has(f.file)).length

  const allFiles = new Set([...refFileNames, ...candFiles.keys()])
  const fileFailing = new Set(failing.filter((d) => d.kind === 'file-status').map((d) => d.key))

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
      candidateOnlyTests: [...candTests.keys()].filter((key) => !refTests.has(key)).length,
      statusMatched,
      failedInBoth: failedInBoth.length,
      messageMatched,
      snapshotFiles: snapshotRef.length,
      snapshotMatched,
      files: allFiles.size,
      filesMatched: allFiles.size - fileFailing.size,
    },
    diffs: sortDiffs(failing.map(publicDiff)),
    excluded: sortDiffs(excluded),
    expiredExclusions: expired,
  }
}
