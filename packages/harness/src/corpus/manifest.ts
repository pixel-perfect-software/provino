// The corpus manifest (T12.9): the 33 pinned repositories of Track 12 F5, as data. Hand-written
// parser, in the style of `parseFixtureManifest`: every wrong field is a coded error naming the
// JSON path, and nothing is cast.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { HarnessError } from '../errors.ts'
import { isRecord } from '../internal/guards.ts'

/**
 * The runners a corpus subject can use (Track 12: each repository uses exactly one).
 * @public
 */
export type CorpusRunner = 'jest' | 'vitest'

/**
 * The package managers a corpus repository's own lockfile can name (DECISIONS D40). They appear as
 * manifest data only, never in this repository's scripts or docs.
 * @public
 */
export type CorpusPackageManager = 'pnpm' | 'npm' | 'yarn'

/**
 * A flag a repository's test script uses that `provino jest` refuses, with the reason.
 * @public
 */
export interface RefusedFlag {
  readonly flag: string
  readonly reason: string
}

/**
 * A command run inside the run's sandbox, with the network off, before the subject's tests: a
 * build some tests need first. `command` is looked up in the clone's `node_modules/.bin`, then on
 * `PATH`. `cwd` is relative to the repository root (default `.`).
 * @public
 */
export interface PrepareStep {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
}

/**
 * One direct runner invocation in one directory (B16 gap 4): what a reference run measures.
 * @public
 */
export interface CorpusSubject {
  /** Unique across the manifest; names the subject's files under `corpus/` and `.refs/corpus/`. */
  readonly id: string
  /** Where the runner runs, relative to the repository root; `.` is the root. */
  readonly cwd: string
  readonly runner: CorpusRunner
  /** The runner's version at the pin (F5's lockfile reading); `install` checks the installed one. */
  readonly runnerVersion: string
  /** The runner config files the subject reads, relative to the repository root. */
  readonly config: readonly string[]
  /**
   * The runner's own arguments (`runSubject`'s `argv`): Jest's flags and test paths with `--ci`,
   * or `run` and Vitest's flags. The harness adds its reporter flags after them.
   */
  readonly argv: readonly string[]
  /** Variables added to the sandbox's environment allowlist. */
  readonly env: Readonly<Record<string, string>>
  /** Whether Track 12 R6 measures this subject (the 5 Jest repos, styled-components on main). */
  readonly r6: boolean
  readonly prepare?: readonly PrepareStep[]
  /** Flags in `argv` that `provino jest` refuses, until the named task lands. */
  readonly provinoRefuses?: readonly RefusedFlag[]
  /** A deadline for one run (default: 30 minutes). */
  readonly timeoutMs?: number
  readonly note?: string
}

/**
 * A project the repository's own tests cover that no subject runs, with the reason.
 * @public
 */
export interface SkippedProject {
  readonly path: string
  readonly reason: string
}

/**
 * The package manager a repository installs with, from its own lockfile (DECISIONS D40).
 * @public
 */
export interface CorpusInstall {
  readonly name: CorpusPackageManager
  /** Pinned by the repository's `packageManager` field or lockfile; absent when it pins none. */
  readonly version?: string
  /**
   * Relative to the repository root; the frozen install needs it. Absent for a repository that
   * commits none (testing-library/dom sets `package-lock=false`): `corpus install` refuses it
   * until the bundle that installs it decides how to pin its dependencies.
   */
  readonly lockfile?: string
  /** Extra flags the repository's own CI install uses (npm's `--legacy-peer-deps`). */
  readonly args?: readonly string[]
}

/**
 * One pinned repository.
 * @public
 */
export interface CorpusRepo {
  readonly id: string
  /** `owner/name`, for `codeload.github.com/<owner>/<name>/tar.gz/<sha>`. */
  readonly repo: string
  /** The 7-character SHA Track 12 F5 printed; `sha` starts with it. */
  readonly f5Sha: string
  /** The full 40-character commit. */
  readonly sha: string
  /** The commit's committer date, as GitHub reports it (`YYYY-MM-DDTHH:MM:SSZ`). */
  readonly commitDate: string
  /** The sha256 of the tarball `codeload.github.com` serves for `sha`. */
  readonly tarballSha256: string
  readonly licence: 'MIT'
  /** Whether B16 installs and runs it (DECISIONS D4: the pilot of 8). */
  readonly pilot: boolean
  readonly install: CorpusInstall
  /** Packages whose install scripts must run after the scripts-off install (a native binary). */
  readonly rebuild?: readonly string[]
  /** The repository's own `test` script at the pin, as written, so a reviewer can check the subjects add up to it. */
  readonly testScript: string
  readonly skipped?: readonly SkippedProject[]
  readonly subjects: readonly CorpusSubject[]
  readonly note?: string
}

/**
 * `corpus/manifest.json`.
 * @public
 */
export interface CorpusManifest {
  readonly schemaVersion: 1
  readonly repos: readonly CorpusRepo[]
}

/**
 * The 5 repositories Track 12 R6 measures (jest-extended, react-hook-form, mobx, swr,
 * styled-components): a subject with `r6` set belongs to one of them, and each has exactly one.
 * @public
 */
export const R6_REPO_IDS: readonly string[] = [
  'jest-extended',
  'react-hook-form',
  'mobx',
  'swr',
  'styled-components',
]

/**
 * The flags a runner's `provino jest` refuses today (B14c; DECISIONS D41): a subject whose `argv`
 * has one must list it under `provinoRefuses`.
 * @public
 */
export const PROVINO_REFUSED_FLAGS: readonly string[] = [
  '--forceExit',
  '--coverage',
  '--bail',
  '--shard',
  '-u',
  '--updateSnapshot',
  '--watch',
  '--watchAll',
]

/** Flags the harness owns (`subjectArgs`), which a subject may not set. */
const HARNESS_FLAGS: readonly string[] = [
  '--json',
  '--outputFile',
  '--reporters',
  '--reporter',
  '--testLocationInResults',
  '--silent',
  '--verbose',
]

/** The default deadline for one subject run. */
export const DEFAULT_SUBJECT_TIMEOUT_MS: number = 30 * 60_000

const ID = /^[a-z0-9][a-z0-9-]*$/
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SHA7 = /^[0-9a-f]{7}$/
const SHA40 = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const COMMIT_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

function invalid(source: string, at: string, message: string): HarnessError {
  return new HarnessError('HARNESS_CORPUS_MANIFEST_INVALID', `${source}: ${at} ${message}`, {
    path: source,
  })
}

function text(value: unknown, at: string, source: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(source, at, 'must be a non-empty string')
  }
  return value
}

function matching(value: unknown, pattern: RegExp, at: string, what: string, source: string) {
  const found = text(value, at, source)
  if (!pattern.test(found)) throw invalid(source, at, `must be ${what}, got "${found}"`)
  return found
}

/** A path inside the repository: relative, POSIX, no `..` segment. `.` is allowed when asked. */
function relativePath(value: unknown, at: string, source: string, allowDot: boolean): string {
  const found = text(value, at, source)
  const segments = found.split('/')
  if (
    found.startsWith('/') ||
    found.includes('\\') ||
    segments.includes('..') ||
    segments.includes('') ||
    (found === '.' && !allowDot) ||
    (segments.includes('.') && found !== '.')
  ) {
    throw invalid(source, at, `must be a relative POSIX path inside the repository, got "${found}"`)
  }
  return found
}

function strings(value: unknown, at: string, source: string): string[] {
  if (!Array.isArray(value)) throw invalid(source, at, 'must be an array of strings')
  return value.map((item, index) => {
    if (typeof item !== 'string') throw invalid(source, `${at}[${index}]`, 'must be a string')
    return item
  })
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
  source: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalid(source, at, `has an unknown key "${key}"`)
  }
}

function record(value: unknown, at: string, source: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(source, at, 'must be an object')
  return value
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  at: string,
  source: string,
): T {
  const found = allowed.find((item) => item === value)
  if (found === undefined) {
    throw invalid(source, at, `must be one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`)
  }
  return found
}

function optionalText(value: unknown, at: string, source: string): { note?: string } {
  return value === undefined ? {} : { note: text(value, at, source) }
}

function prepareOf(value: unknown, at: string, source: string): PrepareStep[] {
  if (!Array.isArray(value)) throw invalid(source, at, 'must be an array')
  return value.map((item, index) => {
    const where = `${at}[${index}]`
    const step = record(item, where, source)
    onlyKeys(step, ['command', 'args', 'cwd'], where, source)
    return {
      command: text(step.command, `${where}.command`, source),
      args: strings(step.args, `${where}.args`, source),
      ...(step.cwd === undefined
        ? {}
        : { cwd: relativePath(step.cwd, `${where}.cwd`, source, true) }),
    }
  })
}

function refusedOf(value: unknown, at: string, source: string): RefusedFlag[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid(source, at, 'must be a non-empty array')
  }
  return value.map((item, index) => {
    const where = `${at}[${index}]`
    const entry = record(item, where, source)
    onlyKeys(entry, ['flag', 'reason'], where, source)
    return {
      flag: text(entry.flag, `${where}.flag`, source),
      reason: text(entry.reason, `${where}.reason`, source),
    }
  })
}

function envOf(value: unknown, at: string, source: string): Record<string, string> {
  const env = record(value, at, source)
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(env)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key))
      throw invalid(source, `${at}.${key}`, 'is not a variable name')
    if (typeof item !== 'string') throw invalid(source, `${at}.${key}`, 'must be a string')
    result[key] = item
  }
  return result
}

/** The flag name of an argument: `--foo=bar` is `--foo`. */
function flagName(argument: string): string {
  const equals = argument.indexOf('=')
  return argument.startsWith('-') && equals > 0 ? argument.slice(0, equals) : argument
}

function subjectOf(value: unknown, at: string, source: string): CorpusSubject {
  const subject = record(value, at, source)
  onlyKeys(
    subject,
    [
      'id',
      'cwd',
      'runner',
      'runnerVersion',
      'config',
      'argv',
      'env',
      'r6',
      'prepare',
      'provinoRefuses',
      'timeoutMs',
      'note',
    ],
    at,
    source,
  )
  const runner = oneOf(subject.runner, ['jest', 'vitest'], `${at}.runner`, source)
  const argv = strings(subject.argv, `${at}.argv`, source)
  const names = argv.map(flagName)
  for (const harness of HARNESS_FLAGS) {
    if (names.includes(harness)) {
      throw invalid(source, `${at}.argv`, `has ${harness}, which the harness sets itself`)
    }
  }
  if (runner === 'jest' && !names.includes('--ci')) {
    throw invalid(
      source,
      `${at}.argv`,
      'must have --ci, so a missing snapshot fails the same way every run (B16 gap 7)',
    )
  }
  if (runner === 'vitest' && argv[0] !== 'run') {
    throw invalid(source, `${at}.argv`, 'must start with "run", so Vitest does not watch')
  }
  const refused =
    subject.provinoRefuses === undefined
      ? []
      : refusedOf(subject.provinoRefuses, `${at}.provinoRefuses`, source)
  const listed = refused.map((entry) => entry.flag)
  for (const flag of listed) {
    if (!names.includes(flag)) {
      throw invalid(source, `${at}.provinoRefuses`, `lists ${flag}, which is not in argv`)
    }
  }
  for (const name of names) {
    if (PROVINO_REFUSED_FLAGS.includes(name) && !listed.includes(name)) {
      throw invalid(
        source,
        `${at}.provinoRefuses`,
        `must list ${name}: provino jest refuses it (DECISIONS D41)`,
      )
    }
  }
  const config = strings(subject.config, `${at}.config`, source).map((file, index) =>
    relativePath(file, `${at}.config[${index}]`, source, false),
  )
  if (config.length === 0) throw invalid(source, `${at}.config`, 'must name the runner config')
  if (typeof subject.r6 !== 'boolean') throw invalid(source, `${at}.r6`, 'must be true or false')
  if (
    subject.timeoutMs !== undefined &&
    (typeof subject.timeoutMs !== 'number' ||
      !Number.isSafeInteger(subject.timeoutMs) ||
      subject.timeoutMs <= 0)
  ) {
    throw invalid(source, `${at}.timeoutMs`, 'must be a positive whole number of milliseconds')
  }
  return {
    id: matching(subject.id, ID, `${at}.id`, 'a lowercase id (a-z, 0-9, -)', source),
    cwd: relativePath(subject.cwd, `${at}.cwd`, source, true),
    runner,
    runnerVersion: matching(
      subject.runnerVersion,
      VERSION,
      `${at}.runnerVersion`,
      'a version',
      source,
    ),
    config,
    argv,
    env: subject.env === undefined ? {} : envOf(subject.env, `${at}.env`, source),
    r6: subject.r6,
    ...(subject.prepare === undefined
      ? {}
      : { prepare: prepareOf(subject.prepare, `${at}.prepare`, source) }),
    ...(refused.length === 0 ? {} : { provinoRefuses: refused }),
    ...(subject.timeoutMs === undefined ? {} : { timeoutMs: subject.timeoutMs }),
    ...optionalText(subject.note, `${at}.note`, source),
  }
}

function installOf(value: unknown, at: string, source: string): CorpusInstall {
  const install = record(value, at, source)
  onlyKeys(install, ['name', 'version', 'lockfile', 'args'], at, source)
  const name = oneOf(install.name, ['pnpm', 'npm', 'yarn'], `${at}.name`, source)
  return {
    name,
    ...(install.version === undefined
      ? {}
      : { version: matching(install.version, VERSION, `${at}.version`, 'a version', source) }),
    ...(install.lockfile === undefined
      ? {}
      : { lockfile: relativePath(install.lockfile, `${at}.lockfile`, source, false) }),
    ...(install.args === undefined ? {} : { args: strings(install.args, `${at}.args`, source) }),
  }
}

function repoOf(value: unknown, at: string, source: string): CorpusRepo {
  const repo = record(value, at, source)
  onlyKeys(
    repo,
    [
      'id',
      'repo',
      'f5Sha',
      'sha',
      'commitDate',
      'tarballSha256',
      'licence',
      'pilot',
      'install',
      'rebuild',
      'testScript',
      'skipped',
      'subjects',
      'note',
    ],
    at,
    source,
  )
  const f5Sha = matching(repo.f5Sha, SHA7, `${at}.f5Sha`, '7 lowercase hex digits', source)
  const sha = matching(repo.sha, SHA40, `${at}.sha`, 'a full 40-character commit SHA', source)
  if (!sha.startsWith(f5Sha)) {
    throw invalid(source, `${at}.sha`, `does not start with F5's ${f5Sha}`)
  }
  if (repo.licence !== 'MIT') throw invalid(source, `${at}.licence`, 'must be "MIT" (DECISIONS D4)')
  if (typeof repo.pilot !== 'boolean') throw invalid(source, `${at}.pilot`, 'must be true or false')
  if (!Array.isArray(repo.subjects) || repo.subjects.length === 0) {
    throw invalid(source, `${at}.subjects`, 'must be a non-empty array')
  }
  const skipped =
    repo.skipped === undefined
      ? []
      : (Array.isArray(repo.skipped) ? repo.skipped : []).map((item: unknown, index: number) => {
          const where = `${at}.skipped[${index}]`
          const entry = record(item, where, source)
          onlyKeys(entry, ['path', 'reason'], where, source)
          return {
            path: relativePath(entry.path, `${where}.path`, source, true),
            reason: text(entry.reason, `${where}.reason`, source),
          }
        })
  if (repo.skipped !== undefined && !Array.isArray(repo.skipped)) {
    throw invalid(source, `${at}.skipped`, 'must be an array')
  }
  return {
    id: matching(repo.id, ID, `${at}.id`, 'a lowercase id (a-z, 0-9, -)', source),
    repo: matching(repo.repo, REPO, `${at}.repo`, 'owner/name', source),
    f5Sha,
    sha,
    commitDate: matching(
      repo.commitDate,
      COMMIT_DATE,
      `${at}.commitDate`,
      'a UTC date-time',
      source,
    ),
    tarballSha256: matching(repo.tarballSha256, SHA256, `${at}.tarballSha256`, 'a sha256', source),
    licence: 'MIT',
    pilot: repo.pilot,
    install: installOf(repo.install, `${at}.install`, source),
    ...(repo.rebuild === undefined
      ? {}
      : { rebuild: strings(repo.rebuild, `${at}.rebuild`, source) }),
    testScript: text(repo.testScript, `${at}.testScript`, source),
    ...(skipped.length === 0 ? {} : { skipped }),
    subjects: repo.subjects.map((subject: unknown, index: number) =>
      subjectOf(subject, `${at}.subjects[${index}]`, source),
    ),
    ...optionalText(repo.note, `${at}.note`, source),
  }
}

/**
 * Reads `corpus/manifest.json`: every repository needs a full SHA that starts with F5's, a sha256,
 * MIT, a known package manager and unique repository and subject ids. The subjects' `r6` flags
 * must match R6's 5 repositories, one subject each (DECISIONS D41). Anything else is
 * `HARNESS_CORPUS_MANIFEST_INVALID` with the JSON path.
 * @public
 */
export function parseCorpusManifest(content: string, source: string): CorpusManifest {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch (cause) {
    throw new HarnessError('HARNESS_CORPUS_MANIFEST_INVALID', `${source} is not valid JSON`, {
      path: source,
      cause,
    })
  }
  const root = record(value, '$', source)
  onlyKeys(root, ['schemaVersion', 'repos'], '$', source)
  if (root.schemaVersion !== 1) throw invalid(source, 'schemaVersion', 'must be 1')
  if (!Array.isArray(root.repos) || root.repos.length === 0) {
    throw invalid(source, 'repos', 'must be a non-empty array')
  }
  const repos = root.repos.map((repo: unknown, index: number) =>
    repoOf(repo, `repos[${index}]`, source),
  )
  const repoIds = new Set<string>()
  const subjectIds = new Set<string>()
  for (const repo of repos) {
    if (repoIds.has(repo.id))
      throw invalid(source, 'repos', `has two repositories with id "${repo.id}"`)
    repoIds.add(repo.id)
    for (const subject of repo.subjects) {
      if (subjectIds.has(subject.id)) {
        throw invalid(source, 'repos', `has two subjects with id "${subject.id}"`)
      }
      subjectIds.add(subject.id)
      if (subject.r6 && !R6_REPO_IDS.includes(repo.id)) {
        throw invalid(
          source,
          `subject ${subject.id}`,
          `has r6 set, but ${repo.id} is not one of R6's 5 repositories`,
        )
      }
    }
  }
  for (const id of R6_REPO_IDS) {
    const repo = repos.find((candidate) => candidate.id === id)
    const measured = repo?.subjects.filter((subject) => subject.r6).length ?? 0
    if (measured !== 1) {
      throw invalid(
        source,
        `repo ${id}`,
        `must have exactly one subject with r6 set, has ${measured}`,
      )
    }
  }
  return { schemaVersion: 1, repos }
}

/**
 * `packages/harness/corpus/manifest.json`'s path.
 * @public
 */
export function defaultManifestPath(): string {
  return path.resolve(import.meta.dirname, '..', '..', 'corpus', 'manifest.json')
}

/**
 * Reads and validates the manifest file (`parseCorpusManifest`).
 * @public
 */
export async function readCorpusManifest(
  file: string = defaultManifestPath(),
): Promise<CorpusManifest> {
  let content: string
  try {
    content = await readFile(file, 'utf8')
  } catch (cause) {
    throw new HarnessError('HARNESS_CORPUS_MANIFEST_INVALID', `can't read the manifest ${file}`, {
      path: file,
      cause,
    })
  }
  return parseCorpusManifest(content, file)
}

/**
 * Which repositories a command works on: the named ids, the pilot, or all of them. An unknown id
 * is `HARNESS_USAGE`.
 * @public
 */
export type CorpusSelection =
  | { readonly kind: 'all' }
  | { readonly kind: 'pilot' }
  | { readonly kind: 'ids'; readonly ids: readonly string[] }

/**
 * The repositories a selection names, in manifest order. An id can be a repository's or one of its
 * subjects' (it selects the whole repository).
 * @public
 */
export function selectRepos(
  manifest: CorpusManifest,
  selection: CorpusSelection,
): readonly CorpusRepo[] {
  if (selection.kind === 'all') return manifest.repos
  if (selection.kind === 'pilot') return manifest.repos.filter((repo) => repo.pilot)
  const wanted = new Set<string>()
  for (const id of selection.ids) {
    const repo = manifest.repos.find(
      (candidate) => candidate.id === id || candidate.subjects.some((subject) => subject.id === id),
    )
    if (repo === undefined)
      throw new HarnessError('HARNESS_USAGE', `no corpus repository or subject "${id}"`)
    wanted.add(repo.id)
  }
  return manifest.repos.filter((repo) => wanted.has(repo.id))
}

/**
 * The subjects of the repositories a selection names. An id that names a subject selects only
 * that subject; a repository id selects all its subjects.
 * @public
 */
export function selectSubjects(
  manifest: CorpusManifest,
  selection: CorpusSelection,
): readonly { readonly repo: CorpusRepo; readonly subject: CorpusSubject }[] {
  const result: { repo: CorpusRepo; subject: CorpusSubject }[] = []
  for (const repo of selectRepos(manifest, selection)) {
    for (const subject of repo.subjects) {
      // A repository id takes all its subjects; any other id takes just the subject it names.
      const taken =
        selection.kind !== 'ids' ||
        selection.ids.includes(repo.id) ||
        selection.ids.includes(subject.id)
      if (taken) result.push({ repo, subject })
    }
  }
  return result
}
