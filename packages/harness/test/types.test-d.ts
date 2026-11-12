import type { ChildProcess } from 'node:child_process'
import type { AggregatedResult, FormattedTestResults } from '@jest/test-result'
import {
  convertJest,
  convertProvino,
  convertVitest,
  DIFF_KINDS,
  type DiffKind,
  type DiffOptions,
  diffRuns,
  EXCLUSION_MAX_DAYS,
  type ExclusionLimits,
  type ExclusionRule,
  exitOnSignals,
  type FixtureProfile,
  type FixtureRunner,
  type Golden,
  type GroupExit,
  type GroupedChild,
  type HarnessErrorCode,
  type JestConvertOptions,
  type NormalizeContext,
  normalizeError,
  normalizeText,
  type ParityReport,
  type ProcessOptions,
  type ProcessResult,
  type ProvinoConvertOptions,
  parseExclusions,
  parseFlaky,
  parseJestJson,
  parseNormalizedRun,
  parseSidecar,
  parseVitestJson,
  type RecordOptions,
  type RecordOutcome,
  type RecordResult,
  type Rule,
  type RunnerPackage,
  readRunEnvironment,
  recordFixture,
  resolveRunnerPackage,
  rules,
  runProcess,
  runSubject,
  SCHEMA_VERSION,
  SIDECAR_ENV,
  type SidecarEntry,
  type SpawnInGroupOptions,
  type SubjectOptions,
  type SubjectResult,
  type SubjectRunner,
  sidecarReporterPath,
  spawnInGroup,
  testKey,
  type VitestConvertOptions,
  vitestMockPolicy,
} from '@provino/harness'
import {
  type CorpusDeps,
  type CorpusManifest,
  type CorpusRepo,
  type CorpusRunner,
  type CorpusSelection,
  type CorpusSubject,
  type FetchResult,
  fetchRepo,
  flakyKeys,
  type GateReport,
  type GateSubject,
  type InstallPlan,
  type InstallRecord,
  installPlan,
  installRepo,
  type PinChange,
  type ProbeAttempt,
  type ProbeName,
  type ProbeVerdict,
  parseCorpusManifest,
  pinManifest,
  type RunMeta,
  type RunReferenceOptions,
  readCorpusManifest,
  repoPaths,
  runProbe,
  runReference,
  type SelfDiff,
  selectRepos,
  selfDiff,
  tarballUrl,
} from '@provino/harness/corpus'
import type {
  ApiRow,
  ApiSupport,
  BenchLabel,
  BenchRecord,
  ParitySummary,
  RunRef,
  SiteIndex,
} from '@provino/harness/site'
import type {
  MockPolicy,
  NormalizedError,
  NormalizedRun,
  NormalizedTest,
  RunEnvironment,
  RunnerId,
  SchemaVersion,
  TestIdentity,
  TestStatus,
  BenchRecord as TypesBenchRecord,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'
import type { JsonTestResults } from 'vitest/node'

// Track 12 §Types: the converters, the result model and the diff.
expectTypeOf(convertJest).parameter(0).toEqualTypeOf<AggregatedResult | FormattedTestResults>()
expectTypeOf(convertVitest).parameter(0).toEqualTypeOf<JsonTestResults>()
expectTypeOf(convertJest).returns.toEqualTypeOf<NormalizedRun>()
expectTypeOf(convertVitest).returns.toEqualTypeOf<NormalizedRun>()
expectTypeOf<TestStatus>().toEqualTypeOf<'passed' | 'failed' | 'skipped' | 'todo' | 'notRun'>()
expectTypeOf(diffRuns).returns.toEqualTypeOf<ParityReport>()
expectTypeOf<NormalizedTest['id']['path']>().toEqualTypeOf<readonly string[]>()
// @ts-expect-error optional fields reject explicit undefined under exactOptionalPropertyTypes
const bad: NormalizedTest = {
  id: { file: 'a', path: ['x'], dupIndex: 0 },
  status: 'passed',
  errors: [],
  passingAssertions: undefined,
}
void bad
expectTypeOf<ApiRow['tests'][number]['status']>().toEqualTypeOf<'passed' | 'failed'>()

// The Harness API.
expectTypeOf(SCHEMA_VERSION).toEqualTypeOf<SchemaVersion>()
expectTypeOf(rules).toEqualTypeOf<readonly Rule[]>()
expectTypeOf<Rule['apply']>().toEqualTypeOf<(s: string, ctx: NormalizeContext) => string>()
expectTypeOf<Rule['scope']>().toEqualTypeOf<'path' | 'message' | 'stack'>()
expectTypeOf(normalizeText).returns.toEqualTypeOf<string>()
expectTypeOf(normalizeText).parameter(2).toEqualTypeOf<Set<string> | undefined>()
expectTypeOf(normalizeError).returns.toEqualTypeOf<NormalizedError>()
expectTypeOf(normalizeError).parameter(2).toEqualTypeOf<string | undefined>()
expectTypeOf(testKey).parameters.toEqualTypeOf<[id: TestIdentity]>()
expectTypeOf(testKey).returns.toEqualTypeOf<string>()
expectTypeOf(convertJest).parameter(1).toEqualTypeOf<JestConvertOptions>()
expectTypeOf(convertVitest).parameter(1).toEqualTypeOf<VitestConvertOptions>()
expectTypeOf(diffRuns).parameter(2).toEqualTypeOf<DiffOptions>()
expectTypeOf(diffRuns).parameter(3).toEqualTypeOf<string | undefined>()

// Diff options and kinds.
expectTypeOf<DiffOptions['messageMode']>().toEqualTypeOf<'exact' | 'matcher' | 'none'>()
expectTypeOf<ExclusionRule['kinds']>().toEqualTypeOf<readonly DiffKind[]>()
expectTypeOf<ExclusionRule['pair']>().toEqualTypeOf<readonly [RunnerId, RunnerId] | undefined>()
expectTypeOf<DiffKind>().toEqualTypeOf<
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
>()
expectTypeOf<ParityReport['statusParity']>().toEqualTypeOf<number>()
expectTypeOf<ParityReport['suitePass']>().toEqualTypeOf<boolean>()
expectTypeOf<ParityReport['diffs'][number]['kind']>().toEqualTypeOf<DiffKind>()
expectTypeOf<ParityReport['excluded'][number]['ruleId']>().toEqualTypeOf<string>()

const goodRule: ExclusionRule = {
  id: 'E1',
  reason: 'why',
  kinds: ['message'],
  expires: '2027-01-01',
}
void goodRule

// @ts-expect-error 'text' is not a DiffKind
const badKind: DiffKind = 'text'
void badKind

const badMode: DiffOptions = {
  // @ts-expect-error 'loose' is not a messageMode
  messageMode: 'loose',
  compareConsole: false,
  compareTrace: false,
  exclusions: [],
}
void badMode

// @ts-expect-error an exclusion has to say which kinds of diff it covers
const noKinds: ExclusionRule = { id: 'E2', reason: 'why' }
void noKinds

// @ts-expect-error a rule's pair is two runners
const onePair: ExclusionRule = { id: 'E3', reason: 'why', kinds: ['status'], pair: ['jest'] }
void onePair

// @ts-expect-error DiffOptions has no defaults: every field is required
const partialOptions: DiffOptions = { messageMode: 'exact' }
void partialOptions

// Convert options.
expectTypeOf<JestConvertOptions['rootDir']>().toEqualTypeOf<string>()
expectTypeOf<JestConvertOptions['startedAt']>().toEqualTypeOf<string | undefined>()
expectTypeOf<JestConvertOptions>().toEqualTypeOf<VitestConvertOptions>()
declare const env: RunEnvironment
// @ts-expect-error rootDir is required
const noRoot: JestConvertOptions = { suite: 's', runnerVersion: '1', env }
void noRoot

// The fixture format and the recorder.
expectTypeOf<FixtureRunner>().toEqualTypeOf<'jest' | 'vitest'>()
expectTypeOf<FixtureProfile>().toEqualTypeOf<'jest' | 'vitest' | 'vitest-list'>()
expectTypeOf<FixtureRunner>().toExtend<FixtureProfile>()
expectTypeOf(recordFixture).returns.toEqualTypeOf<Promise<RecordResult>>()
expectTypeOf(recordFixture).parameter(0).toEqualTypeOf<string>()
expectTypeOf(recordFixture).parameter(1).toEqualTypeOf<FixtureProfile>()
expectTypeOf<RecordResult['runner']>().toEqualTypeOf<FixtureRunner>()
expectTypeOf<RecordResult['profile']>().toEqualTypeOf<FixtureProfile>()
expectTypeOf<RecordOptions['check']>().toEqualTypeOf<boolean | undefined>()
expectTypeOf<RecordOptions['keepWorkDir']>().toEqualTypeOf<boolean | undefined>()
// The deadline, the work root and the environment are the recorder's own.
expectTypeOf<RecordOptions>().not.toHaveProperty('timeoutMs')
expectTypeOf<RecordOptions>().not.toHaveProperty('workRoot')
expectTypeOf<RecordOptions>().not.toHaveProperty('env')
expectTypeOf<RecordOutcome>().toEqualTypeOf<
  'written' | 'unchanged' | 'matches' | 'drift' | 'missing'
>()
expectTypeOf<RecordResult['outcome']>().toEqualTypeOf<RecordOutcome>()
expectTypeOf<HarnessErrorCode>().toExtend<string>()
expectTypeOf<
  'HARNESS_RUN_INCOMPLETE' | 'HARNESS_GOLDEN_LEAKS_PATH' | 'HARNESS_DUPLICATE_TEST_KEY'
>().toExtend<HarnessErrorCode>()
// @ts-expect-error 'HARNESS_NOPE' is not a harness error code
const noSuchCode: HarnessErrorCode = 'HARNESS_NOPE'
void noSuchCode
expectTypeOf<ParityReport['counts']['excluded']>().toEqualTypeOf<number>()
// A golden has no startedAt, env, durations or raw text.
expectTypeOf<Golden>().not.toHaveProperty('startedAt')
expectTypeOf<Golden>().not.toHaveProperty('env')
expectTypeOf<Golden['files'][number]['tests'][number]>().not.toHaveProperty('durationMs')
expectTypeOf<Golden['runErrors'][number]>().not.toHaveProperty('raw')
// The Vitest mock profile the bench shares is a whole `MockPolicy` slice.
expectTypeOf(vitestMockPolicy).toEqualTypeOf<MockPolicy>()
// The profile and the traced steps are optional, and the steps are plain strings.
expectTypeOf<Golden['profile']>().toEqualTypeOf<FixtureProfile | undefined>()
expectTypeOf<Golden['trace']>().toEqualTypeOf<readonly string[] | undefined>()

// @ts-expect-error a recorder option the recorder does not have
const badRecordOptions: RecordOptions = { timeoutMs: 1000 }
void badRecordOptions

// @ts-expect-error 'mocha' is not a fixture runner
const mocha: FixtureRunner = 'mocha'
void mocha

// @ts-expect-error 'vitest-list' is a recording profile, not a runner
const vitestList: FixtureRunner = 'vitest-list'
void vitestList

// @ts-expect-error fixtures are recorded under jest, vitest or vitest-list only
void recordFixture('/fixtures/a/b', 'bun')

// @ts-expect-error the profile is vitest-list, not vitest-stack
void recordFixture('/fixtures/a/b', 'vitest-stack')

// The result files the runners write.
expectTypeOf(parseJestJson).parameter(0).toEqualTypeOf<string>()
expectTypeOf(parseJestJson).returns.toEqualTypeOf<FormattedTestResults>()
expectTypeOf(parseVitestJson).parameter(0).toEqualTypeOf<string>()
expectTypeOf(parseVitestJson).returns.toEqualTypeOf<JsonTestResults>()

// @ts-expect-error the text of the file, not a path or a parsed value
void parseJestJson({ testResults: [] })

// The file Provino's `normalized-json` reporter writes (and `convertJest` and `convertVitest`
// return): the text and where it came from, both required, giving a `NormalizedRun`.
expectTypeOf(parseNormalizedRun).parameters.toEqualTypeOf<[text: string, source: string]>()
expectTypeOf(parseNormalizedRun).returns.toEqualTypeOf<NormalizedRun>()

// @ts-expect-error the source is named in every error, so it is required
void parseNormalizedRun('{}')
declare const parsedRun: NormalizedRun
// @ts-expect-error the text of the file, not a parsed run
void parseNormalizedRun(parsedRun, 'run')

// Process groups, shared with the bench.
expectTypeOf(spawnInGroup).parameters.toEqualTypeOf<
  [command: string, args: readonly string[], options: SpawnInGroupOptions]
>()
expectTypeOf(spawnInGroup).returns.toEqualTypeOf<GroupedChild>()
expectTypeOf<GroupedChild['child']>().toEqualTypeOf<ChildProcess>()
expectTypeOf<GroupedChild['exited']>().toEqualTypeOf<Promise<GroupExit>>()
expectTypeOf<SpawnInGroupOptions['stdio']>().not.toBeUndefined()
expectTypeOf<SpawnInGroupOptions['timeoutMs']>().toEqualTypeOf<number | undefined>()
expectTypeOf<SpawnInGroupOptions['killGraceMs']>().toEqualTypeOf<number | undefined>()
expectTypeOf<SpawnInGroupOptions['deadline']>().toEqualTypeOf<AbortSignal | undefined>()
expectTypeOf<GroupExit['exitCode']>().toEqualTypeOf<number | null>()
expectTypeOf<GroupExit['signal']>().toEqualTypeOf<NodeJS.Signals | null>()
expectTypeOf<GroupExit['timedOut']>().toEqualTypeOf<boolean>()
expectTypeOf<GroupExit['endedAt']>().toEqualTypeOf<number>()
expectTypeOf<GroupExit['problems']>().toEqualTypeOf<readonly string[]>()
expectTypeOf(exitOnSignals).toEqualTypeOf<() => void>()

// @ts-expect-error stdio is the caller's choice; there is no default
void spawnInGroup('node', [], { cwd: '/', env: {} })
// @ts-expect-error the timeout is a number of milliseconds
void spawnInGroup('node', [], { cwd: '/', env: {}, stdio: 'ignore', timeoutMs: '5s' })
// @ts-expect-error the arguments are a list, not one string
void spawnInGroup('node', '--version', { cwd: '/', env: {}, stdio: 'ignore' })

expectTypeOf(runProcess).parameters.toEqualTypeOf<
  [command: string, args: readonly string[], options: ProcessOptions]
>()
expectTypeOf(runProcess).returns.toEqualTypeOf<Promise<ProcessResult>>()
expectTypeOf<ProcessResult['output']>().toEqualTypeOf<string>()
expectTypeOf<ProcessResult['timedOut']>().toEqualTypeOf<boolean>()
expectTypeOf<ProcessResult['wallMs']>().toEqualTypeOf<number>()
expectTypeOf<ProcessResult['exitCode']>().toEqualTypeOf<number | null>()
expectTypeOf<ProcessOptions['onOutput']>().toEqualTypeOf<((chunk: string) => void) | undefined>()
expectTypeOf<ProcessOptions>().not.toHaveProperty('stdio')

// @ts-expect-error a process runs somewhere: cwd is required
void runProcess('node', [], { env: {} })

// The machine and the runner packages.
expectTypeOf(readRunEnvironment).parameter(0).toEqualTypeOf<Readonly<Record<string, string>>>()
expectTypeOf(readRunEnvironment).returns.toEqualTypeOf<RunEnvironment>()
expectTypeOf(resolveRunnerPackage).parameters.toEqualTypeOf<[name: string, from: string | URL]>()
expectTypeOf(resolveRunnerPackage).returns.toEqualTypeOf<RunnerPackage>()
expectTypeOf<RunnerPackage['version']>().toEqualTypeOf<string>()
expectTypeOf<RunnerPackage['bin']>().toEqualTypeOf<string>()

// @ts-expect-error a runner's version is a string
void readRunEnvironment({ jest: 30 })
// @ts-expect-error the place to resolve from is required
void resolveRunnerPackage('jest')

// The site contract (`@provino/harness/site`).
expectTypeOf<ApiSupport>().toEqualTypeOf<'supported' | 'partial' | 'missing' | 'not-planned'>()
expectTypeOf<ApiRow['dialect']>().toEqualTypeOf<'jest' | 'vitest'>()
expectTypeOf<ParitySummary['dialect']>().toEqualTypeOf<'jest' | 'vitest'>()
expectTypeOf<SiteIndex['schemaVersion']>().toEqualTypeOf<1>()
expectTypeOf<SiteIndex['refs'][number]['ref']>().toEqualTypeOf<RunRef>()
// The bench types are re-exported, not redefined.
expectTypeOf<BenchRecord>().toEqualTypeOf<TypesBenchRecord>()
expectTypeOf<BenchLabel>().toEqualTypeOf<'local' | 'desktop' | 'pinned'>()

// @ts-expect-error 'planned' is not an ApiSupport
const badSupport: ApiSupport = 'planned'
void badSupport

// @ts-expect-error a test in an API row has passed or failed; nothing else
const badRowTest: ApiRow['tests'][number] = { file: 'a', name: 'b', status: 'skipped' }
void badRowTest

// @ts-expect-error schemaVersion is the literal 1
const badIndex: SiteIndex = { schemaVersion: 2, generatedAt: '2026-01-01', refs: [] }
void badIndex

// B15: the sidecars, runSubject, convertProvino, exclusions and flaky lists.
expectTypeOf(sidecarReporterPath).parameter(0).toEqualTypeOf<FixtureRunner>()
expectTypeOf(sidecarReporterPath).returns.toEqualTypeOf<string>()
expectTypeOf<SidecarEntry['stream']>().toEqualTypeOf<'stdout' | 'stderr'>()
expectTypeOf<SidecarEntry['test']>().toEqualTypeOf<
  { readonly path: readonly string[]; readonly dupIndex: number } | undefined
>()
expectTypeOf(parseSidecar).returns.toEqualTypeOf<SidecarEntry[]>()
expectTypeOf(SIDECAR_ENV).toEqualTypeOf<string>()
expectTypeOf<JestConvertOptions['console']>().toEqualTypeOf<readonly SidecarEntry[] | undefined>()

expectTypeOf<SubjectRunner>().toEqualTypeOf<'jest' | 'vitest' | 'provino'>()
expectTypeOf(runSubject).parameter(0).toEqualTypeOf<SubjectOptions>()
expectTypeOf(runSubject).returns.resolves.toEqualTypeOf<SubjectResult>()
expectTypeOf<SubjectResult['run']>().toEqualTypeOf<NormalizedRun>()
expectTypeOf<SubjectResult['exitCode']>().toEqualTypeOf<number | null>()

expectTypeOf(convertProvino).parameter(0).toEqualTypeOf<string>()
expectTypeOf(convertProvino).parameter(1).toEqualTypeOf<ProvinoConvertOptions>()
expectTypeOf(convertProvino).returns.toEqualTypeOf<NormalizedRun>()

expectTypeOf(parseExclusions).parameter(2).toEqualTypeOf<ExclusionLimits>()
expectTypeOf(parseExclusions).returns.toEqualTypeOf<ExclusionRule[]>()
expectTypeOf(parseFlaky).returns.toEqualTypeOf<string[]>()
expectTypeOf(EXCLUSION_MAX_DAYS).toEqualTypeOf<number>()
expectTypeOf(DIFF_KINDS).toEqualTypeOf<readonly DiffKind[]>()
expectTypeOf<ExclusionRule['policyKey']>().toEqualTypeOf<string | undefined>()
expectTypeOf<ExclusionRule['absentIn']>().toEqualTypeOf<'reference' | 'candidate' | undefined>()

const absentInBoth: ExclusionRule = {
  id: 'E9',
  reason: 'r',
  kinds: ['user-frame'],
  // @ts-expect-error absentIn names one run
  absentIn: 'both',
}
void absentInBoth
expectTypeOf<DiffOptions['flaky']>().toEqualTypeOf<readonly string[] | undefined>()
expectTypeOf<ParityReport['counts']['flaky']>().toEqualTypeOf<number>()

// @ts-expect-error Provino has no sidecar: it writes console output in normalized-json itself
void sidecarReporterPath('provino')

// @ts-expect-error a subject run needs the directory it normalizes against
const subjectWithoutRoot: SubjectOptions = {
  runner: 'jest',
  cwd: '/w',
  argv: [],
  env: {},
  suite: 's',
  outDir: '/o',
}
void subjectWithoutRoot

// @ts-expect-error mocha is not a subject runner
const mochaSubject: SubjectRunner = 'mocha'
void mochaSubject

// @ts-expect-error convertProvino reads the JSON text, not a parsed run
void convertProvino({ files: [] }, { rootDir: '/w' })

// @ts-expect-error the limits need the day they are measured from
const noToday: ExclusionLimits = { calibration: true }
void noToday

// @ts-expect-error a sidecar entry's stream is stdout or stderr
const stdinEntry: SidecarEntry = { stream: 'stdin', text: 'x' }
void stdinEntry

const badFlaky: DiffOptions = {
  messageMode: 'exact',
  compareConsole: false,
  compareTrace: false,
  exclusions: [],
  // @ts-expect-error the flaky list is test keys, not tests
  flaky: [{ file: 'a.test.ts' }],
}
void badFlaky

// B16: `@provino/harness/corpus`, the pinned corpus and its reference runs.
expectTypeOf(parseCorpusManifest).parameters.toEqualTypeOf<[content: string, source: string]>()
expectTypeOf(parseCorpusManifest).returns.toEqualTypeOf<CorpusManifest>()
expectTypeOf(readCorpusManifest).returns.toEqualTypeOf<Promise<CorpusManifest>>()
expectTypeOf(selectRepos).returns.toEqualTypeOf<readonly CorpusRepo[]>()
expectTypeOf(tarballUrl).parameter(0).toEqualTypeOf<Pick<CorpusRepo, 'repo' | 'sha'>>()
expectTypeOf(fetchRepo).returns.toEqualTypeOf<Promise<FetchResult>>()
expectTypeOf(installPlan).returns.toEqualTypeOf<Promise<InstallPlan>>()
expectTypeOf(installRepo).returns.toEqualTypeOf<Promise<InstallRecord>>()
expectTypeOf(runReference).returns.toEqualTypeOf<Promise<RunMeta>>()
expectTypeOf(runProbe).returns.toEqualTypeOf<Promise<ProbeVerdict>>()
expectTypeOf(flakyKeys).parameter(0).toEqualTypeOf<readonly NormalizedRun[]>()
expectTypeOf(flakyKeys).returns.toEqualTypeOf<string[]>()
expectTypeOf(selfDiff).returns.toEqualTypeOf<SelfDiff>()
expectTypeOf<CorpusRunner>().toEqualTypeOf<'jest' | 'vitest'>()
expectTypeOf<CorpusSelection['kind']>().toEqualTypeOf<'all' | 'pilot' | 'ids'>()
expectTypeOf<Extract<CorpusSelection, { kind: 'ids' }>['ids']>().toEqualTypeOf<readonly string[]>()
expectTypeOf<ProbeName>().toEqualTypeOf<
  'tcp' | 'dns' | 'https' | 'socket' | 'canary' | 'ssh' | 'loopback'
>()
expectTypeOf<PinChange['outcome']>().toEqualTypeOf<'new' | 'same'>()
expectTypeOf<GateReport['subjects']>().toEqualTypeOf<readonly GateSubject[]>()
expectTypeOf<CorpusDeps['run']>().parameters.toEqualTypeOf<
  [command: string, args: readonly string[], options: ProcessOptions]
>()
expectTypeOf(repoPaths).returns.toHaveProperty('tarball').toEqualTypeOf<string>()
expectTypeOf(pinManifest).parameter(2).toHaveProperty('selection').toEqualTypeOf<CorpusSelection>()
expectTypeOf<RunReferenceOptions['unsandboxed']>().toEqualTypeOf<boolean | undefined>()

// @ts-expect-error a corpus subject runs Jest or Vitest, nothing else
const mochaCorpusSubject: CorpusRunner = 'mocha'
void mochaCorpusSubject

// @ts-expect-error a selection is all, the pilot or a list of ids
const badSelection: CorpusSelection = { kind: 'some' }
void badSelection

// @ts-expect-error an `ids` selection needs its ids
const idsWithoutIds: CorpusSelection = { kind: 'ids' }
void idsWithoutIds

// @ts-expect-error licences other than MIT are not pinned
const gplRepo: Pick<CorpusRepo, 'licence'> = { licence: 'GPL' }
void gplRepo

// @ts-expect-error a subject needs the runner config files it reads
const subjectWithoutConfig: CorpusSubject = {
  id: 's',
  cwd: '.',
  runner: 'jest',
  runnerVersion: '30.5.2',
  argv: [],
  env: {},
  r6: false,
}
void subjectWithoutConfig

// @ts-expect-error the manifest is parsed from its text, not from an object
void parseCorpusManifest({ schemaVersion: 1, repos: [] }, 'manifest.json')

// @ts-expect-error a probe attempt's outcome is ok, error or timeout
const refused: ProbeAttempt = { name: 'tcp', outcome: 'blocked' }
void refused

// @ts-expect-error the probe has no attempt called "udp"
const udp: ProbeName = 'udp'
void udp

// @ts-expect-error a pin run needs the selection of repositories to pin
void pinManifest('{}', 'manifest.json', { workRoot: '/w' })

// @ts-expect-error a fetch needs the work directory
void fetchRepo({} as CorpusRepo, {})

// @ts-expect-error installing a repository needs the work directory
void installRepo({} as CorpusRepo, { deps: {} as CorpusDeps })

// @ts-expect-error the sandbox platform is a Node platform name
void runProbe({ workRoot: '/w', platform: 'macos' })

// @ts-expect-error a test key in the flaky list is a string, so the runs are what `flakyKeys` takes
void flakyKeys(['a.test.ts::x#0'])
