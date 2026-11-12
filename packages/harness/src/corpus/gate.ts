// G0's report (Track 12 R3: "harness converts and self-diffs reference runs on the corpus, with the
// calibration diff explained by at most 30 exclusion rules in total"). Built from what the
// reference runs left on disk, as JSON and as text. It holds no Provino number: every timing is
// the reference runner's and `local` (DECISIONS D37, non-negotiable 7).
import type { ExclusionRule } from '../diff.ts'
import { ruleExcluded } from '../internal/diff-bars.ts'
import { countList, seconds } from './format.ts'
import type { InstallRecord } from './install.ts'
import type { CorpusRepo, CorpusSubject } from './manifest.ts'
import type { RunMeta } from './run.ts'
import type { SelfDiff } from './self-diff.ts'

/** G0's limit on exclusion rules, counted over the whole corpus (Track 12 R3). */
export const G0_MAX_EXCLUSION_RULES = 30

/** The reference runs G0 needs of each subject (`corpus run --runs` refuses fewer). */
export const MIN_REFERENCE_RUNS = 3

/** The normalization rules the harness shipped with (B15's nine); a rule beyond them was added by the corpus. */
export const BASELINE_NORMALIZATION_RULES: readonly string[] = [
  'ansi',
  'crlf',
  'file-url',
  'root',
  'windows-separators',
  'code-frames',
  'durations',
  'placeholders',
  'stack',
]

/**
 * What the report needs to know about one subject.
 * @public
 */
export interface GateInput {
  readonly repo: CorpusRepo
  readonly subject: CorpusSubject
  readonly install: InstallRecord | undefined
  readonly metas: readonly RunMeta[]
  readonly selfDiff: SelfDiff
  readonly flaky: readonly string[]
  readonly exclusions: readonly ExclusionRule[]
}

/**
 * One self-diff pair in the report.
 * @public
 */
export interface GatePair {
  readonly pair: string
  readonly statusParity: number
  readonly messageParity: number
  readonly snapshotParity: number
  readonly suitePass: boolean
  readonly unexplainedDiffs: number
  readonly pass: boolean
  readonly reasons: readonly string[]
}

/**
 * One subject in the report.
 * @public
 */
export interface GateSubject {
  readonly repo: string
  readonly subject: string
  readonly sha: string
  readonly packageManager: string
  readonly runner: string
  readonly runnerVersion: string
  /** `local`: milliseconds. */
  readonly installMs: number | undefined
  readonly offlineReinstall: 'ok' | 'failed' | 'not run'
  readonly runs: readonly {
    readonly n: number
    readonly tests: number
    readonly statuses: RunMeta['statuses']
    readonly runMs: number
    readonly prepareMs: number
  }[]
  /** |T|: the reference tests (run 1) left after exclusions. */
  readonly comparedTests: number
  readonly flaky: { readonly count: number; readonly share: number }
  readonly excluded: {
    /** Tests the rules removed from T (run 1 against run 2, the larger). */
    readonly tests: number
    readonly share: number
    readonly rules: readonly {
      readonly id: string
      readonly reason: string
      readonly used: number
    }[]
  }
  readonly selfDiffs: readonly GatePair[]
  /** For each normalization rule, in how many of the runs it changed any text. */
  readonly normalizationFired: Readonly<Record<string, number>>
  readonly sidecar: {
    readonly ok: boolean
    readonly filesWithOutput: number
    readonly missing: readonly string[]
  }
  readonly problems: readonly string[]
  readonly pass: boolean
}

/**
 * G0's report.
 * @public
 */
export interface GateReport {
  readonly today: string
  /** The corpus the report is about: every repository in the manifest, and the pilot's share of them. */
  readonly corpus: { readonly repositories: number; readonly pilot: number }
  readonly subjects: readonly GateSubject[]
  readonly totals: {
    /** Exclusion rules defined over the subjects (G0: at most 30 for the whole corpus). */
    readonly exclusionRules: number
    readonly exclusionRulesUnused: readonly string[]
    readonly largestFlakyShare: { readonly subject: string; readonly share: number } | undefined
    /** Normalization rules beyond the baseline the corpus added. */
    readonly normalizationRulesAdded: readonly string[]
    readonly problems: readonly string[]
  }
  readonly notCovered: readonly string[]
  readonly pass: boolean
}

function share(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole
}

/** One subject's row. */
export function gateSubject(input: GateInput): GateSubject {
  const { repo, subject, install, metas, selfDiff, flaky, exclusions } = input
  const problems: string[] = []
  const first = selfDiff.pairs[0]
  const comparedTests = first?.report.counts.comparedTests ?? 0
  const referenceTests = first?.report.counts.referenceTests ?? 0
  const used = new Map<string, number>()
  let ruleTests = 0
  for (const { report } of selfDiff.pairs) {
    for (const excluded of report.excluded)
      used.set(excluded.ruleId, (used.get(excluded.ruleId) ?? 0) + 1)
    ruleTests = Math.max(ruleTests, ruleExcluded(report.counts))
  }
  const fired: Record<string, number> = {}
  for (const meta of metas) for (const id of meta.fired) fired[id] = (fired[id] ?? 0) + 1
  const missing = [...new Set(metas.flatMap((meta) => meta.sidecar.missing))].toSorted()
  const sidecarFiles = metas.reduce((most, meta) => Math.max(most, meta.sidecar.files), 0)
  const versions = new Set(metas.map((meta) => meta.runnerVersion))
  const offlineReinstall =
    install?.offline === undefined ? 'not run' : install.offline.ok ? 'ok' : 'failed'

  if (metas.length < MIN_REFERENCE_RUNS) {
    problems.push(`${metas.length} reference runs, ${MIN_REFERENCE_RUNS} needed`)
  }
  if (versions.size > 1)
    problems.push(`runs used different runner versions: ${[...versions].join(', ')}`)
  if (install === undefined) problems.push('no install record')
  // R2's cap on the excluded share (D65) is the self-diff's own bar, so a breach is in `selfDiff`'s
  // pair reasons and the subject fails here once, not again with the same share.
  if (missing.length > 0)
    problems.push(`the sidecar saw console output the run lacks for ${missing.length} file(s)`)
  if (!selfDiff.pass) problems.push('a self-diff fails')

  return {
    repo: repo.id,
    subject: subject.id,
    sha: repo.sha,
    packageManager: `${repo.install.name}@${repo.install.version}`,
    runner: subject.runner,
    runnerVersion: metas[0]?.runnerVersion ?? subject.runnerVersion,
    installMs: install?.wallMs,
    offlineReinstall,
    runs: metas.map((meta) => ({
      n: meta.n,
      tests: meta.tests,
      statuses: meta.statuses,
      runMs: meta.runMs,
      prepareMs: meta.prepareMs,
    })),
    comparedTests,
    flaky: { count: flaky.length, share: share(flaky.length, referenceTests) },
    excluded: {
      tests: ruleTests,
      share: share(ruleTests, referenceTests),
      rules: exclusions.map((rule) => ({
        id: rule.id,
        reason: rule.reason,
        used: used.get(rule.id) ?? 0,
      })),
    },
    selfDiffs: selfDiff.pairs.map(({ pair, report, reasons, pass }) => ({
      pair: `${pair[0]}-${pair[1]}`,
      statusParity: report.statusParity,
      messageParity: report.messageParity,
      snapshotParity: report.snapshotByteParity,
      suitePass: report.suitePass,
      unexplainedDiffs: report.diffs.length,
      pass,
      reasons,
    })),
    normalizationFired: fired,
    sidecar: { ok: missing.length === 0, filesWithOutput: sidecarFiles, missing },
    problems,
    pass: problems.length === 0 && selfDiff.pass && offlineReinstall === 'ok',
  }
}

/**
 * Builds G0's report from the subjects' rows: at most 30 exclusion rules in total, each used at
 * least once, every subject passing, and the rules added to the normalizer listed.
 * @public
 */
export function buildGateReport(
  subjects: readonly GateSubject[],
  options: {
    readonly today: string
    readonly normalizationRules: readonly string[]
    readonly corpus: GateReport['corpus']
  },
): GateReport {
  const defined = subjects.flatMap((row) =>
    row.excluded.rules.map((rule) => ({ ...rule, subject: row.subject })),
  )
  const unused = defined
    .filter((rule) => rule.used === 0)
    .map((rule) => `${rule.subject}: ${rule.id}`)
  const flakiest = subjects.toSorted((a, b) => b.flaky.share - a.flaky.share)[0]
  const added = options.normalizationRules.filter(
    (id) => !BASELINE_NORMALIZATION_RULES.includes(id),
  )
  const problems: string[] = []
  if (defined.length > G0_MAX_EXCLUSION_RULES) {
    problems.push(`${defined.length} exclusion rules, more than G0's ${G0_MAX_EXCLUSION_RULES}`)
  }
  if (unused.length > 0) problems.push(`rules used by no self-diff: ${unused.join(', ')}`)
  for (const row of subjects)
    if (!row.pass) problems.push(`${row.subject}: ${row.problems.join('; ') || 'a check fails'}`)
  return {
    today: options.today,
    corpus: options.corpus,
    subjects,
    totals: {
      exclusionRules: defined.length,
      exclusionRulesUnused: unused,
      largestFlakyShare:
        flakiest === undefined
          ? undefined
          : { subject: flakiest.subject, share: flakiest.flaky.share },
      normalizationRulesAdded: added,
      problems,
    },
    notCovered: [
      'Jest baselines on the pinned machine (DECISIONS D37; B18)',
      `the ${options.corpus.repositories - options.corpus.pilot} repositories outside the pilot (B22)`,
    ],
    pass: problems.length === 0,
  }
}

function duration(ms: number | undefined): string {
  return ms === undefined ? 'n/a' : seconds(ms)
}

function percent(value: number): string {
  return `${(value * 100).toFixed(value === 1 ? 0 : 2)}%`
}

/**
 * The report as text, for a person and for B16's close-out. Every time is the reference
 * runner's and `local`.
 * @public
 */
export function formatGateReport(report: GateReport): string {
  const lines: string[] = [
    `G0 gate report (${report.today}); all timings are \`local\`, the reference runners'`,
    '',
  ]
  for (const row of report.subjects) {
    lines.push(
      `${row.subject}: ${row.pass ? 'PASS' : 'FAIL'}`,
      `  ${row.repo} @ ${row.sha.slice(0, 7)}, ${row.packageManager}, ${row.runner} ${row.runnerVersion}`,
      `  install ${duration(row.installMs)}; offline re-install ${row.offlineReinstall}`,
    )
    for (const run of row.runs) {
      const statuses = countList(run.statuses)
      lines.push(
        `  run ${run.n}: T ${run.tests} (${statuses}); ${duration(run.runMs)}, prepare ${duration(run.prepareMs)}`,
      )
    }
    lines.push(
      `  flaky ${row.flaky.count} (${percent(row.flaky.share)}); excluded by rules ${row.excluded.tests} (${percent(row.excluded.share)})`,
    )
    for (const rule of row.excluded.rules)
      lines.push(`  rule ${rule.id} used ${rule.used}: ${rule.reason}`)
    for (const pair of row.selfDiffs) {
      lines.push(
        `  self-diff ${pair.pair}: status ${percent(pair.statusParity)}, message ${percent(pair.messageParity)}, snapshot ${percent(pair.snapshotParity)}, suite pass ${pair.suitePass ? 'yes' : 'no'}, unexplained diffs ${pair.unexplainedDiffs} ${pair.pass ? '' : `FAIL: ${pair.reasons.join('; ')}`}`.trimEnd(),
      )
    }
    const fired = countList(row.normalizationFired)
    lines.push(`  normalization fired (runs): ${fired === '' ? '(none)' : fired}`)
    lines.push(
      `  sidecar: ${row.sidecar.ok ? 'ok' : `missing console for ${row.sidecar.missing.join(', ')}`} (${row.sidecar.filesWithOutput} files with output)`,
    )
    for (const problem of row.problems) lines.push(`  problem: ${problem}`)
    lines.push('')
  }
  const { totals } = report
  lines.push(
    'Totals',
    `  exclusion rules in the pilot: ${totals.exclusionRules} of G0's ${G0_MAX_EXCLUSION_RULES} for all ${report.corpus.repositories} repositories`,
    `  largest flaky share: ${totals.largestFlakyShare === undefined ? 'n/a' : `${percent(totals.largestFlakyShare.share)} (${totals.largestFlakyShare.subject})`}`,
    `  normalization rules added: ${totals.normalizationRulesAdded.length === 0 ? '(none)' : totals.normalizationRulesAdded.join(', ')}`,
    '',
    'Not covered by this gate',
    ...report.notCovered.map((item) => `  ${item}`),
    '',
    ...totals.problems.map((problem) => `problem: ${problem}`),
    report.pass ? 'G0 on the pilot: PASS' : 'G0 on the pilot: FAIL',
  )
  return `${lines.join('\n')}\n`
}
