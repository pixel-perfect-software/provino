// `@provino/harness/corpus`: the pinned corpus of Track 12 F5 (T12.9) and its reference runs
// (T12.10). Dev-only; the commands are `provino-harness corpus <action>`.
export type { CorpusDeps, RunCommand } from './deps.ts'
export { defaultDeps } from './deps.ts'
export type { FetchOptions, FetchResult } from './fetch.ts'
export {
  diskUsageMb,
  ensureTarball,
  fetchRepo,
  sha256OfFile,
  tarballUrl,
  verifyEntries,
} from './fetch.ts'
export {
  defaultCorpusDir,
  readSubjectExclusions,
  readSubjectFlaky,
  subjectFiles,
  writeSubjectFlaky,
} from './files.ts'
export { flakyKeys } from './flaky.ts'
export type { GateInput, GatePair, GateReport, GateSubject } from './gate.ts'
export {
  BASELINE_NORMALIZATION_RULES,
  buildGateReport,
  formatGateReport,
  G0_MAX_EXCLUDED_SHARE,
  G0_MAX_EXCLUSION_RULES,
  gateSubject,
  MIN_REFERENCE_RUNS,
} from './gate.ts'
export type { InstallPlan, InstallRecord } from './install.ts'
export {
  findNodeModules,
  fingerprintTree,
  installEnv,
  installPlan,
  installRepo,
  readInstallRecord,
  reinstallOffline,
} from './install.ts'
export type {
  CorpusInstall,
  CorpusManifest,
  CorpusPackageManager,
  CorpusRepo,
  CorpusRunner,
  CorpusSelection,
  CorpusSubject,
  PrepareStep,
  RefusedFlag,
  SkippedProject,
} from './manifest.ts'
export {
  DEFAULT_SUBJECT_TIMEOUT_MS,
  defaultManifestPath,
  PROVINO_REFUSED_FLAGS,
  parseCorpusManifest,
  R6_REPO_IDS,
  readCorpusManifest,
  selectRepos,
  selectSubjects,
} from './manifest.ts'
export type { RepoPaths } from './paths.ts'
export { CORPUS_DIR_ENV, corpusWorkRoot, repoPaths, runDir } from './paths.ts'
export type { PinChange, PinFailure, ResolvedCommit } from './pin.ts'
export { pinManifest, resolveCommit } from './pin.ts'
export type { RunMeta, RunReferenceOptions, SidecarCheck } from './run.ts'
export { checkSidecar, cloneTree, listRuns, runReference } from './run.ts'
export type { ProbeAttempt, ProbeName, ProbeVerdict, SandboxPolicy } from './sandbox.ts'
export {
  assertSandboxPlatform,
  BLOCKED_ATTEMPTS,
  DENIED_HOME_PATHS,
  evaluateProbe,
  parseProbeOutput,
  runProbe,
  sandboxEnv,
  sandboxed,
  seatbeltProfile,
} from './sandbox.ts'
export type { SelfDiff, SelfDiffPair } from './self-diff.ts'
export { selfDiff } from './self-diff.ts'
