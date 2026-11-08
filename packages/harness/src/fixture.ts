import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { MockCleanupStep } from '@provino/types'
import { HarnessError } from './errors.ts'
import { compareStrings, isNotFound, isRecord } from './internal/guards.ts'
import { isNodeModules, walkFiles } from './internal/walk.ts'

/**
 * A runner the recorder can run.
 * @public
 */
export type FixtureRunner = 'jest' | 'vitest'

/**
 * The runners the recorder can run, in the order goldens are listed.
 * @public
 */
export const FIXTURE_RUNNERS: readonly FixtureRunner[] = ['jest', 'vitest']

/**
 * What a fixture is recorded as: a runner, or one of its recording profiles. `vitest-list` is
 * Vitest with `sequence.hooks: 'list'`; its golden is `__goldens__/vitest-list.json`.
 * @public
 */
export type FixtureProfile = FixtureRunner | 'vitest-list'

/**
 * Every profile a fixture can be recorded under, in the order goldens are listed.
 * @public
 */
export const FIXTURE_PROFILES: readonly FixtureProfile[] = [...FIXTURE_RUNNERS, 'vitest-list']

/** The profiles as `fixture.json` spells them, for error messages: `"jest" | "vitest" | ...`. */
const PROFILE_CHOICES = FIXTURE_PROFILES.map((profile) => `"${profile}"`).join(' | ')

/**
 * The real runner behind a profile, which picks the package, the test files and the converter.
 * @public
 */
export function runnerOfProfile(profile: FixtureProfile): FixtureRunner {
  return profile === 'jest' ? 'jest' : 'vitest'
}

/**
 * A fixture's `fixture.json`.
 * @public
 */
export interface FixtureManifest {
  /** What behaviour the fixture pins down. */
  readonly description: string
  /** The runners and profiles it is recorded under. */
  readonly runners: readonly FixtureProfile[]
  /** Environment variables for the runner process, on top of the recorder's own. */
  readonly env?: Readonly<Record<string, string>>
  /**
   * Flags for `node` itself, before the runner's bin (`--harmony-temporal`, which `NODE_OPTIONS`
   * refuses). B17a's `policy/timers-temporal` needs a Node with a `Temporal`.
   */
  readonly nodeFlags?: readonly string[]
  /**
   * The profiles (a subset of `runners`) whose test files must crash at collection, e.g. Jest on
   * `test(name)` with no function, each with the text the crash's `fileError` message must
   * contain: `{ "jest": "Missing second argument" }`. The crash's `fileError` is recorded;
   * recording fails without the crash, with a crash for another reason, and with one for a
   * profile not listed here.
   */
  readonly expectCrash?: Readonly<Partial<Record<FixtureProfile, string>>>
  /**
   * The per-test mock cleanup the runner runs under, by the neutral names of `MockPolicy.between`.
   * Only the keys given are set, so the runner's own default stands for the rest (Vitest 5's
   * `clearMocks` is on by default, Jest's is off). `recorder/runner-config.ts` maps them to Jest's
   * and Vitest's options. `unstubEnvs` and `unstubGlobals` are Vitest-only, so they are an error
   * in a fixture that lists `jest`.
   */
  readonly mockCleanup?: MockCleanup
  /**
   * Packages to install into the work directory's `node_modules/` before the run:
   * `{ "<name>": { "<relative file>": "<source>" } }`. A name may be scoped (`@scope/name`). Jest
   * does not transform `node_modules`, so the sources must be plain CommonJS; they live in the
   * manifest because `node_modules/` is gitignored and no `.js` is committed (D13).
   */
  readonly packages?: Readonly<Record<string, Readonly<Record<string, string>>>>
  /**
   * `true`: for this fixture only, Jest's transformer also turns `import`/`export` into CommonJS
   * (`@babel/plugin-transform-modules-commonjs`), so a `*.jest.test.ts` can use `import`. Absent
   * means off, and Jest's output is unchanged.
   */
  readonly jestEsm?: true
  /**
   * Jest options a module-mock case needs, for a fixture that lists `jest`: `roots` (directories
   * relative to the fixture, where Jest looks for `__mocks__` and tests; the tests then have to
   * live under one) and `unmockedModulePathPatterns` (regular expression sources that automock
   * leaves real). Vitest has neither, so the Vitest run ignores them.
   */
  readonly jestConfig?: JestFixtureConfig
  /**
   * A JSON overlay on the config the recorder writes, per runner (B14a, T1.7): Jest's options, or
   * Vitest's whole config object (`{ "test": { ... } }`). Objects merge key by key; an array
   * replaces, except Jest's `setupFiles` and `setupFilesAfterEnv` and Vitest's `test.setupFiles`,
   * which are appended after the recorder's own trace and observe setups. The keys the recorder
   * owns (where the run happens and which files it runs) and the keys `mockCleanup` or
   * `jestConfig` already set are refused.
   */
  readonly config?: FixtureConfigOverlay
  /**
   * Files written into the work directory before the run, per runner: `{ "jest": { "<relative
   * path>": "<text>" } }`. A tree as data, for a file only one runner reads (a `.snap` with that
   * runner's header) or one the repository can't hold (D13).
   */
  readonly files?: Readonly<Partial<Record<FixtureRunner, Readonly<Record<string, string>>>>>
  /**
   * A black-box run (B14a): the recorder also keeps what the run shows from outside, in the
   * golden's `observed`, and the completeness rule (every test file ran, none crashed) doesn't
   * apply.
   */
  readonly run?: FixtureRun
}

/**
 * A fixture's config overlay: a JSON object per runner.
 * @public
 */
export type FixtureConfigOverlay = Readonly<
  Partial<Record<FixtureRunner, Readonly<Record<string, unknown>>>>
>

/**
 * What a black-box run keeps. `capture` lists `exitCode`, `stdout`, `stderr` and `file:<relative
 * path>` (the file's text after the run, `null` when it is not there). `argv` is added to the
 * runner's command line. `keepLines` (a regular-expression source) keeps only the matching lines
 * of `stdout` and `stderr`, and `sortStdout` sorts them, for output whose order or timing a run
 * doesn't fix. A captured stream `keepLines` keeps no line of fails the recording, unless
 * `emptyStreams` lists it.
 * @public
 */
export interface FixtureRun {
  readonly argv?: Readonly<Partial<Record<FixtureRunner, readonly string[]>>>
  readonly capture: readonly string[]
  readonly emptyStreams?: readonly ('stdout' | 'stderr')[]
  readonly keepLines?: string
  readonly sortStdout?: true
}

/**
 * The Jest options a fixture may set.
 * @public
 */
export interface JestFixtureConfig {
  readonly roots?: readonly string[]
  readonly unmockedModulePathPatterns?: readonly string[]
}

/**
 * The keys of a fixture's `mockCleanup`: whether each cleanup runs before every test.
 * @public
 */
export type MockCleanup = { readonly [K in MockCleanupStep]?: boolean }

const MOCK_CLEANUP_KEYS = ['clear', 'reset', 'restore', 'unstubEnvs', 'unstubGlobals'] as const
const VITEST_ONLY_CLEANUP_KEYS: readonly string[] = ['unstubEnvs', 'unstubGlobals']

/**
 * A fixture read from disk.
 * @public
 */
export interface Fixture {
  /** Absolute path of the fixture directory. */
  readonly dir: string
  /** `area/behaviour` for a fixture under `fixtures/`, else the directory name. */
  readonly id: string
  readonly manifest: FixtureManifest
  /** Every file in the directory except `fixture.json` and `__goldens__/`, POSIX, sorted. */
  readonly files: readonly string[]
}

/**
 * The name of the directory that holds a fixture's goldens.
 * @public
 */
export const GOLDENS_DIR = '__goldens__'
/**
 * The name of a fixture's manifest.
 * @public
 */
export const MANIFEST_FILE = 'fixture.json'

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'description',
  'runners',
  'env',
  'nodeFlags',
  'expectCrash',
  'mockCleanup',
  'packages',
  'jestEsm',
  'jestConfig',
  'config',
  'files',
  'run',
])

function isFixtureProfile(value: unknown): value is FixtureProfile {
  return FIXTURE_PROFILES.some((profile) => profile === value)
}

/**
 * Validates the text of a `fixture.json`. Every failure is a `HarnessError` with a
 * `HARNESS_FIXTURE_*` code and the offending field in the message.
 * @public
 */
export function parseFixtureManifest(
  text: string,
  source: string = MANIFEST_FILE,
): FixtureManifest {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new HarnessError('HARNESS_FIXTURE_BAD_JSON', `${source} is not valid JSON`, {
      path: source,
      cause,
    })
  }
  if (!isRecord(value)) {
    throw new HarnessError('HARNESS_FIXTURE_BAD_JSON', `${source} must be a JSON object`, {
      path: source,
    })
  }
  for (const key of Object.keys(value)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new HarnessError(
        'HARNESS_FIXTURE_UNKNOWN_KEY',
        `${source}: unknown key "${key}" (expected description, runners, env, nodeFlags, expectCrash, mockCleanup, packages, jestEsm, jestConfig, config, files, run)`,
        { path: source },
      )
    }
  }
  const {
    description,
    runners,
    env,
    nodeFlags,
    expectCrash,
    mockCleanup,
    packages,
    jestEsm,
    jestConfig,
    config,
    files,
    run,
  } = value
  if (typeof description !== 'string' || description.trim() === '') {
    throw new HarnessError(
      'HARNESS_FIXTURE_BAD_DESCRIPTION',
      `${source}: "description" must be a non-empty string`,
      { path: source },
    )
  }
  if (!Array.isArray(runners) || runners.length === 0 || !runners.every(isFixtureProfile)) {
    throw new HarnessError(
      'HARNESS_FIXTURE_BAD_RUNNERS',
      `${source}: "runners" must be a non-empty array of ${PROFILE_CHOICES}`,
      { path: source },
    )
  }
  if (new Set(runners).size !== runners.length) {
    throw new HarnessError(
      'HARNESS_FIXTURE_BAD_RUNNERS',
      `${source}: "runners" lists a runner twice`,
      { path: source },
    )
  }
  return {
    description,
    runners,
    ...(env === undefined ? {} : { env: parseEnv(env, source) }),
    ...(nodeFlags === undefined ? {} : { nodeFlags: parseNodeFlags(nodeFlags, source) }),
    ...(expectCrash === undefined
      ? {}
      : { expectCrash: parseExpectCrash(expectCrash, runners, source) }),
    ...(mockCleanup === undefined
      ? {}
      : { mockCleanup: parseMockCleanup(mockCleanup, runners, source) }),
    ...(packages === undefined ? {} : { packages: parsePackages(packages, source) }),
    ...(jestEsm === undefined ? {} : { jestEsm: parseJestEsm(jestEsm, runners, source) }),
    ...(jestConfig === undefined
      ? {}
      : { jestConfig: parseJestConfig(jestConfig, runners, source) }),
    ...(config === undefined
      ? {}
      : {
          config: parseConfigOverlay(config, runners, source, {
            mockCleanup: mockCleanup !== undefined,
            jestConfig: isRecord(jestConfig) ? Object.keys(jestConfig) : [],
          }),
        }),
    ...(files === undefined ? {} : { files: parseRunnerFiles(files, runners, source) }),
    ...(run === undefined ? {} : { run: parseRun(run, runners, source) }),
  }
}

/** The Jest options the recorder writes and a fixture may not override. */
const JEST_RESERVED: readonly string[] = [
  'rootDir',
  'transform',
  'testMatch',
  'testPathIgnorePatterns',
  'testLocationInResults',
  'cacheDirectory',
  'watchman',
  // Projects bring configs of their own, which the recorder doesn't write.
  'projects',
]
/** The Vitest keys (dotted) the recorder writes and a fixture may not override. */
const VITEST_RESERVED: readonly string[] = [
  'root',
  'cacheDir',
  'test.include',
  'test.exclude',
  'test.includeTaskLocation',
  'projects',
  'test.projects',
]
/** What `mockCleanup` and `jestConfig` set, as each runner spells it. */
const JEST_MOCK_CLEANUP_OPTIONS: readonly string[] = ['clearMocks', 'resetMocks', 'restoreMocks']
const VITEST_MOCK_CLEANUP_OPTIONS: readonly string[] = [
  'test.clearMocks',
  'test.mockReset',
  'test.restoreMocks',
  'test.unstubEnvs',
  'test.unstubGlobals',
]

/** Every dotted key path of a JSON object: `{ test: { a: 1 } }` gives `test` and `test.a`. */
function keyPaths(value: Readonly<Record<string, unknown>>, prefix = ''): string[] {
  const out: string[] = []
  for (const [key, inner] of Object.entries(value)) {
    const dotted = prefix === '' ? key : `${prefix}.${key}`
    out.push(dotted)
    if (isRecord(inner)) out.push(...keyPaths(inner, dotted))
  }
  return out
}

/**
 * `config` is a non-empty object from runners the fixture lists to non-empty JSON objects. A key
 * the recorder owns, or one `mockCleanup` or `jestConfig` sets, is refused, so one value never has
 * two sources. Under `vitest-list`, `test.sequence.hooks` is the profile's.
 */
function parseConfigOverlay(
  config: unknown,
  runners: readonly FixtureProfile[],
  source: string,
  owned: { readonly mockCleanup: boolean; readonly jestConfig: readonly string[] },
): FixtureConfigOverlay {
  const bad = (reason: string): HarnessError =>
    new HarnessError('HARNESS_FIXTURE_BAD_CONFIG', `${source}: "config" ${reason}`, {
      path: source,
    })
  if (!isRecord(config) || Object.keys(config).length === 0) {
    throw bad('must be a non-empty object from a runner to its options')
  }
  const out: Partial<Record<FixtureRunner, Record<string, unknown>>> = {}
  for (const [runner, overlay] of Object.entries(config)) {
    const known = FIXTURE_RUNNERS.find((name) => name === runner)
    if (known === undefined) throw bad(`names "${runner}", which is not "jest" | "vitest"`)
    if (!runners.some((profile) => runnerOfProfile(profile) === known)) {
      throw bad(`names "${runner}", which "runners" does not list`)
    }
    if (!isRecord(overlay) || Object.keys(overlay).length === 0) {
      throw bad(`must give "${runner}" a non-empty object`)
    }
    // Vitest's options are under `test`; any other value would hide the keys checked below.
    if (known === 'vitest' && 'test' in overlay && !isRecord(overlay.test)) {
      throw bad('must give "vitest.test" an object')
    }
    const paths = keyPaths(overlay)
    const reserved =
      known === 'jest'
        ? [
            ...JEST_RESERVED,
            ...(owned.mockCleanup ? JEST_MOCK_CLEANUP_OPTIONS : []),
            ...owned.jestConfig,
          ]
        : [
            ...VITEST_RESERVED,
            ...(owned.mockCleanup ? VITEST_MOCK_CLEANUP_OPTIONS : []),
            ...(runners.includes('vitest-list') ? ['test.sequence.hooks'] : []),
          ]
    const taken = paths.find((dotted) => reserved.includes(dotted))
    if (taken !== undefined) {
      throw bad(`sets "${runner}.${taken}", which the recorder or another manifest key sets`)
    }
    out[known] = overlay
  }
  return out
}

/** `files` is a non-empty object from runners the fixture lists to `{ relative path: text }`. */
function parseRunnerFiles(
  files: unknown,
  runners: readonly FixtureProfile[],
  source: string,
): Partial<Record<FixtureRunner, Record<string, string>>> {
  const bad = (reason: string): HarnessError =>
    new HarnessError('HARNESS_FIXTURE_BAD_FILES', `${source}: "files" ${reason}`, { path: source })
  if (!isRecord(files) || Object.keys(files).length === 0) {
    throw bad('must be a non-empty object from a runner to its files')
  }
  const out: Partial<Record<FixtureRunner, Record<string, string>>> = {}
  for (const [runner, tree] of Object.entries(files)) {
    const known = FIXTURE_RUNNERS.find((name) => name === runner)
    if (known === undefined) throw bad(`names "${runner}", which is not "jest" | "vitest"`)
    if (!runners.some((profile) => runnerOfProfile(profile) === known)) {
      throw bad(`names "${runner}", which "runners" does not list`)
    }
    if (!isRecord(tree) || Object.keys(tree).length === 0) {
      throw bad(`must give "${runner}" a non-empty object from a relative file to its text`)
    }
    const written: Record<string, string> = {}
    for (const [file, text] of Object.entries(tree)) {
      if (!staysInside(file)) throw bad(`gives "${file}", which is not a relative path inside it`)
      if (typeof text !== 'string') throw bad(`must give "${file}" its text as a string`)
      const normalized = path.posix.normalize(file)
      if (Object.hasOwn(written, normalized)) throw bad(`gives "${normalized}" twice`)
      written[normalized] = text
    }
    out[known] = written
  }
  return out
}

/** What `run.capture` may name besides `file:<path>`. */
const RUN_STREAMS: readonly string[] = ['exitCode', 'stdout', 'stderr']
const RUN_KEYS: readonly string[] = ['argv', 'capture', 'emptyStreams', 'keepLines', 'sortStdout']

/**
 * The command-line options `run.argv` may not give, camel-cased: what the recorder passes (the
 * config, the JSON results and where they go, the root) and what `mockCleanup` sets. `-c` and `-r`
 * are the runners' short names for `--config` and Vitest's `--root`.
 */
const OWNED_FLAGS: ReadonlySet<string> = new Set([
  'c',
  'config',
  'json',
  'outputFile',
  'r',
  'root',
  'rootDir',
  'reporter',
  'reporters',
  ...JEST_MOCK_CLEANUP_OPTIONS,
  ...VITEST_MOCK_CLEANUP_OPTIONS.map((option) => option.slice('test.'.length)),
])

/**
 * The option an argument sets, camel-cased, without a `no-` prefix, a `=value` or a `.sub` key
 * (`--no-output-file`, `--outputFile.json=x` and `--outputFile` are all `outputFile`); `undefined`
 * for a value.
 */
function optionOf(arg: string): string | undefined {
  const match = /^--?(?:no-)?([^=.]+)/.exec(arg)
  return match?.[1]?.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

/**
 * Whether `arg` adds a text reporter by name: Vitest keeps every `--reporter` the command line
 * gives, so the recorder's `json` stays (`policy/report-default` adds `default` this way).
 */
const addsTextReporter = (arg: string): boolean => /^--reporter=(?!json$)[a-z-]+$/.test(arg)

/**
 * `run` is `{ capture, argv?, keepLines?, emptyStreams?, sortStdout? }`: `capture` a non-empty list
 * of `exitCode`, `stdout`, `stderr` and `file:<relative path>`, each once; `argv` per listed
 * runner, a list of strings that sets no option the recorder owns (`OWNED_FLAGS`); `keepLines` a
 * regular-expression source; `emptyStreams` the captured streams `keepLines` may keep no line of
 * (else that is a broken run); `sortStdout` only `true`.
 */
function parseRun(run: unknown, runners: readonly FixtureProfile[], source: string): FixtureRun {
  const bad = (reason: string): HarnessError =>
    new HarnessError('HARNESS_FIXTURE_BAD_RUN', `${source}: "run" ${reason}`, { path: source })
  if (!isRecord(run)) throw bad('must be an object with "capture"')
  for (const key of Object.keys(run)) {
    if (!RUN_KEYS.includes(key)) {
      throw bad(`has the unknown key "${key}" (expected ${RUN_KEYS.join(', ')})`)
    }
  }
  const { argv, capture, emptyStreams, keepLines, sortStdout } = run
  if (
    !Array.isArray(capture) ||
    capture.length === 0 ||
    !capture.every((entry): entry is string => typeof entry === 'string')
  ) {
    throw bad('"capture" must be a non-empty array of strings')
  }
  for (const entry of capture) {
    const file = entry.startsWith('file:') ? entry.slice('file:'.length) : undefined
    if (file === undefined ? !RUN_STREAMS.includes(entry) : !staysInside(file)) {
      throw bad(
        `"capture" lists "${entry}" (expected exitCode, stdout, stderr or file:<relative path>)`,
      )
    }
  }
  if (new Set(capture).size !== capture.length) throw bad('"capture" lists an entry twice')
  const out: {
    argv?: Partial<Record<FixtureRunner, string[]>>
    capture: string[]
    emptyStreams?: ('stdout' | 'stderr')[]
    keepLines?: string
    sortStdout?: true
  } = { capture }
  if (argv !== undefined) {
    if (!isRecord(argv) || Object.keys(argv).length === 0) {
      throw bad('"argv" must be a non-empty object from a runner to its arguments')
    }
    const parsed: Partial<Record<FixtureRunner, string[]>> = {}
    for (const [runner, args] of Object.entries(argv)) {
      const known = FIXTURE_RUNNERS.find((name) => name === runner)
      if (known === undefined || !runners.some((profile) => runnerOfProfile(profile) === known)) {
        throw bad(`"argv" names "${runner}", which is not a runner "runners" lists`)
      }
      if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === 'string')) {
        throw bad(`"argv" must give "${runner}" an array of strings`)
      }
      const owned = args.find((arg) => {
        const option = optionOf(arg)
        return option !== undefined && OWNED_FLAGS.has(option) && !addsTextReporter(arg)
      })
      if (owned !== undefined) {
        throw bad(`"argv" gives "${owned}" to ${runner}, which the recorder or "mockCleanup" sets`)
      }
      parsed[known] = args
    }
    out.argv = parsed
  }
  if (keepLines !== undefined) {
    if (typeof keepLines !== 'string' || keepLines === '') {
      throw bad('"keepLines" must be a non-empty regular-expression source')
    }
    try {
      new RegExp(keepLines)
    } catch (cause) {
      throw new HarnessError(
        'HARNESS_FIXTURE_BAD_RUN',
        `${source}: "run" "keepLines" is not a regular expression`,
        { path: source, cause },
      )
    }
    out.keepLines = keepLines
  }
  if (emptyStreams !== undefined) {
    if (
      keepLines === undefined ||
      !Array.isArray(emptyStreams) ||
      emptyStreams.length === 0 ||
      new Set(emptyStreams).size !== emptyStreams.length ||
      !emptyStreams.every(
        (name): name is 'stdout' | 'stderr' =>
          (name === 'stdout' || name === 'stderr') && capture.includes(name),
      )
    ) {
      throw bad(
        '"emptyStreams" must list, once each, captured streams "keepLines" may keep no line of',
      )
    }
    out.emptyStreams = emptyStreams
  }
  if (sortStdout !== undefined) {
    if (sortStdout !== true) throw bad('"sortStdout" must be true (leave it out for off)')
    out.sortStdout = true
  }
  return out
}

/**
 * `jestConfig` is a non-empty object of `roots` (relative directories inside the fixture, each
 * once) and `unmockedModulePathPatterns` (non-empty strings that are regular expressions), and
 * only means something for a fixture that runs Jest.
 */
function parseJestConfig(
  jestConfig: unknown,
  runners: readonly FixtureProfile[],
  source: string,
): JestFixtureConfig {
  const bad = (reason: string): HarnessError =>
    new HarnessError('HARNESS_FIXTURE_BAD_JEST_CONFIG', `${source}: "jestConfig" ${reason}`, {
      path: source,
    })
  if (!runners.includes('jest')) throw bad('is set but "runners" does not list "jest"')
  if (!isRecord(jestConfig) || Object.keys(jestConfig).length === 0) {
    throw bad('must be a non-empty object')
  }
  for (const key of Object.keys(jestConfig)) {
    if (key !== 'roots' && key !== 'unmockedModulePathPatterns') {
      throw bad(`has the unknown key "${key}" (expected roots, unmockedModulePathPatterns)`)
    }
  }
  const { roots, unmockedModulePathPatterns } = jestConfig
  const strings = (name: string, list: unknown): string[] => {
    if (
      !Array.isArray(list) ||
      list.length === 0 ||
      !list.every((s) => typeof s === 'string' && s !== '')
    ) {
      throw bad(`"${name}" must be a non-empty array of non-empty strings`)
    }
    return list as string[]
  }
  let parsedRoots: string[] | undefined
  if (roots !== undefined) {
    parsedRoots = strings('roots', roots).map((dir) => {
      if (!staysInside(dir))
        throw bad(`"roots" lists "${dir}", which is not a directory inside the fixture`)
      return path.posix.normalize(dir)
    })
    if (new Set(parsedRoots).size !== parsedRoots.length)
      throw bad('"roots" lists a directory twice')
  }
  let patterns: string[] | undefined
  if (unmockedModulePathPatterns !== undefined) {
    patterns = strings('unmockedModulePathPatterns', unmockedModulePathPatterns)
    for (const pattern of patterns) {
      try {
        new RegExp(pattern)
      } catch (cause) {
        throw new HarnessError(
          'HARNESS_FIXTURE_BAD_JEST_CONFIG',
          `${source}: "jestConfig" gives "${pattern}", which is not a regular expression`,
          { path: source, cause },
        )
      }
    }
  }
  return {
    ...(parsedRoots === undefined ? {} : { roots: parsedRoots }),
    ...(patterns === undefined ? {} : { unmockedModulePathPatterns: patterns }),
  }
}

/** `jestEsm` is `true` or absent, and only means something for a fixture that runs Jest. */
function parseJestEsm(jestEsm: unknown, runners: readonly FixtureProfile[], source: string): true {
  if (jestEsm !== true) {
    throw new HarnessError(
      'HARNESS_FIXTURE_BAD_JEST_ESM',
      `${source}: "jestEsm" must be true (leave it out for off)`,
      { path: source },
    )
  }
  if (!runners.includes('jest')) {
    throw new HarnessError(
      'HARNESS_FIXTURE_BAD_JEST_ESM',
      `${source}: "jestEsm" is set but "runners" does not list "jest"`,
      { path: source },
    )
  }
  return true
}

/** A package name as npm spells it: `name` or `@scope/name`, lowercase, no path tricks. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/**
 * Whether a relative POSIX path names a file inside its directory: no `..` segment, no root, no
 * backslash, and not a directory (no trailing `/`). `..foo` is a file name, not a way out.
 */
export function staysInside(file: string): boolean {
  if (
    file === '' ||
    file.includes('\\') ||
    file.includes('\0') ||
    file.startsWith('/') ||
    file.endsWith('/')
  )
    return false
  const normalized = path.posix.normalize(file)
  return (
    normalized !== '.' &&
    normalized !== '..' &&
    !normalized.startsWith('../') &&
    !file.split('/').includes('..')
  )
}

/**
 * `packages` is a non-empty object from package names to non-empty objects from relative file
 * paths to source text. A name or a file that would leave its directory is refused, so is a
 * directory path (a trailing `/`), two spellings of one file (`./x.js` and `x.js`), and a package
 * with no `package.json`: without one a package inherits `"type": "module"` from this package, so
 * Node and Vitest read its `index.js` as ES modules where Jest reads CommonJS. The files are kept
 * under their normalized path.
 */
function parsePackages(packages: unknown, source: string): Record<string, Record<string, string>> {
  const bad = (reason: string): HarnessError =>
    new HarnessError('HARNESS_FIXTURE_BAD_PACKAGES', `${source}: "packages" ${reason}`, {
      path: source,
    })
  if (!isRecord(packages) || Object.keys(packages).length === 0) {
    throw bad('must be a non-empty object from a package name to its files')
  }
  const out: Record<string, Record<string, string>> = {}
  for (const [name, files] of Object.entries(packages)) {
    if (!PACKAGE_NAME.test(name)) {
      throw bad(`names "${name}", which is not a package name (\`name\` or \`@scope/name\`)`)
    }
    if (!isRecord(files) || Object.keys(files).length === 0) {
      throw bad(`must give "${name}" a non-empty object from a relative file to its source`)
    }
    const installed: Record<string, string> = {}
    for (const [file, text] of Object.entries(files)) {
      if (!staysInside(file)) {
        throw bad(`gives "${name}" the file "${file}", which is not a relative path inside it`)
      }
      if (typeof text !== 'string') {
        throw bad(`must give "${name}/${file}" its source as a string`)
      }
      const normalized = path.posix.normalize(file)
      if (Object.hasOwn(installed, normalized)) {
        throw bad(
          `gives "${name}" the file "${normalized}" twice (as "${file}" and another spelling)`,
        )
      }
      installed[normalized] = text
    }
    if (!Object.hasOwn(installed, 'package.json')) {
      throw bad(
        `must give "${name}" a "package.json": without one it inherits this package's "type"`,
      )
    }
    out[name] = installed
  }
  return out
}

/**
 * `mockCleanup` is a non-empty object of the five neutral names to booleans. `unstubEnvs` and
 * `unstubGlobals` have no Jest option, so a fixture that lists `jest` cannot set them.
 */
function parseMockCleanup(
  mockCleanup: unknown,
  runners: readonly FixtureProfile[],
  source: string,
): MockCleanup {
  const bad = (reason: string): HarnessError =>
    new HarnessError('HARNESS_FIXTURE_BAD_MOCK_CLEANUP', `${source}: "mockCleanup" ${reason}`, {
      path: source,
    })
  if (!isRecord(mockCleanup) || Object.keys(mockCleanup).length === 0) {
    throw bad(`must be a non-empty object with keys from ${MOCK_CLEANUP_KEYS.join(', ')}`)
  }
  const cleanup: { -readonly [K in keyof MockCleanup]: MockCleanup[K] } = {}
  for (const [key, flag] of Object.entries(mockCleanup)) {
    const known = MOCK_CLEANUP_KEYS.find((name) => name === key)
    if (known === undefined) {
      throw bad(`has unknown key "${key}" (expected ${MOCK_CLEANUP_KEYS.join(', ')})`)
    }
    if (typeof flag !== 'boolean') throw bad(`must give "${key}" true or false`)
    if (VITEST_ONLY_CLEANUP_KEYS.includes(key) && runners.includes('jest')) {
      throw bad(`sets "${key}", which Jest has no option for, but "runners" lists "jest"`)
    }
    cleanup[known] = flag
  }
  return cleanup
}

function parseEnv(env: unknown, source: string): Record<string, string> {
  if (!isRecord(env) || !Object.values(env).every((v) => typeof v === 'string')) {
    throw new HarnessError(
      'HARNESS_FIXTURE_BAD_ENV',
      `${source}: "env" must be an object of string values`,
      { path: source },
    )
  }
  const stringEnv: Record<string, string> = {}
  for (const [name, entry] of Object.entries(env)) {
    if (typeof entry === 'string') stringEnv[name] = entry
  }
  return stringEnv
}

/** `nodeFlags` is a non-empty array of `--flag` strings (no script, no `-e`, no `--require`). */
function parseNodeFlags(nodeFlags: unknown, source: string): readonly string[] {
  if (
    !Array.isArray(nodeFlags) ||
    nodeFlags.length === 0 ||
    !nodeFlags.every(
      (flag) =>
        typeof flag === 'string' &&
        /^--[a-z][a-z0-9-]*(=\S+)?$/.test(flag) &&
        !/^--(require|import|eval|print|input-type|experimental-loader|loader)\b/.test(flag),
    )
  ) {
    throw new HarnessError(
      'HARNESS_FIXTURE_BAD_NODE_FLAGS',
      `${source}: "nodeFlags" must be a non-empty array of node flags such as "--harmony-temporal" (not --require, --import, --eval or a loader)`,
      { path: source },
    )
  }
  return nodeFlags
}

/**
 * `expectCrash` is a non-empty object from profiles of the fixture's own `runners` to the text
 * their crash must show.
 */
function parseExpectCrash(
  expectCrash: unknown,
  runners: readonly FixtureProfile[],
  source: string,
): Partial<Record<FixtureProfile, string>> {
  const bad = (reason: string): HarnessError =>
    new HarnessError('HARNESS_FIXTURE_BAD_EXPECT_CRASH', `${source}: "expectCrash" ${reason}`, {
      path: source,
    })
  if (!isRecord(expectCrash) || Object.keys(expectCrash).length === 0) {
    throw bad('must be a non-empty object from a profile to the text its crash message contains')
  }
  const causes: Partial<Record<FixtureProfile, string>> = {}
  for (const [profile, cause] of Object.entries(expectCrash)) {
    if (!isFixtureProfile(profile)) {
      throw bad(`names "${profile}", which is not ${PROFILE_CHOICES}`)
    }
    if (!runners.includes(profile)) throw bad(`names "${profile}", which "runners" does not list`)
    if (typeof cause !== 'string' || cause.trim() === '') {
      throw bad(`must give "${profile}" a non-empty string to look for in the crash message`)
    }
    causes[profile] = cause
  }
  return causes
}

/**
 * Which runners run a test file, by its name: `a.test.ts` runs under every runner,
 * `a.jest.test.ts` under Jest only, `a.vitest.test.ts` under Vitest only. Any other file is a
 * support file and returns `undefined`.
 * @public
 */
export function runnersForTestFile(file: string): readonly FixtureRunner[] | undefined {
  const base = path.posix.basename(file)
  if (base.endsWith('.jest.test.ts')) return ['jest']
  if (base.endsWith('.vitest.test.ts')) return ['vitest']
  if (base.endsWith('.test.ts')) return FIXTURE_RUNNERS
  return undefined
}

/**
 * The test files a profile runs, from a fixture's file list. A profile runs the files of its
 * runner: `vitest-list` runs what `vitest` runs.
 * @public
 */
export function testFilesFor(files: readonly string[], profile: FixtureProfile): readonly string[] {
  const runner = runnerOfProfile(profile)
  return files.filter((file) => runnersForTestFile(file)?.includes(runner) === true)
}

/** Every file a fixture hands the runner: all but the manifest and what the recorder writes. */
function listFiles(dir: string): Promise<string[]> {
  return walkFiles(dir, {
    skipDir: (relative) => path.posix.basename(relative) === GOLDENS_DIR || isNodeModules(relative),
    keep: (relative) => relative !== MANIFEST_FILE,
  })
}

/**
 * The directory fixtures live in, `packages/harness/fixtures/`.
 * @public
 */
export function defaultFixturesRoot(): string {
  return path.resolve(import.meta.dirname, '..', 'fixtures')
}

/**
 * Reads a fixture directory: validates `fixture.json`, lists its files, and checks every listed
 * runner has a test file.
 * @public
 */
export async function readFixture(
  dir: string,
  fixturesRoot: string = defaultFixturesRoot(),
): Promise<Fixture> {
  const absolute = path.resolve(dir)
  const manifestPath = path.join(absolute, MANIFEST_FILE)
  let text: string
  try {
    text = await readFile(manifestPath, 'utf8')
  } catch (cause) {
    throw new HarnessError('HARNESS_FIXTURE_NOT_FOUND', `no ${MANIFEST_FILE} in ${absolute}`, {
      path: absolute,
      cause,
    })
  }
  const manifest = parseFixtureManifest(text, manifestPath)
  const files = await listFiles(absolute)
  for (const profile of manifest.runners) {
    if (testFilesFor(files, profile).length === 0) {
      const runner = runnerOfProfile(profile)
      throw new HarnessError(
        'HARNESS_FIXTURE_NO_TESTS',
        `${absolute} lists "${profile}" but has no test file for it (*.test.ts or *.${runner}.test.ts)`,
        { path: absolute },
      )
    }
  }
  return { dir: absolute, id: await fixtureId(absolute, fixturesRoot), manifest, files }
}

/**
 * `area/behaviour` for a fixture under `fixturesRoot`, else the directory name. Both paths go
 * through `realpath` first: the id is written into the golden as `suite` and names the recorder's
 * work directory, so a symlink, `/tmp` against `/private/tmp` or a differently cased spelling must
 * not turn it into the bare directory name.
 */
async function fixtureId(dir: string, fixturesRoot: string): Promise<string> {
  const [real, root] = await Promise.all([
    realpath(dir),
    realpath(fixturesRoot).catch((cause: unknown) => {
      // No fixtures root, so nothing is under it.
      if (isNotFound(cause)) return undefined
      throw cause
    }),
  ])
  if (root === undefined) return path.basename(real)
  const relative = path.relative(root, real)
  return relative.startsWith('..') ? path.basename(real) : relative.split(path.sep).join('/')
}

/**
 * Finds every fixture directory (one with a `fixture.json`) under a root, sorted by path.
 * @public
 */
export async function findFixtures(root: string = defaultFixturesRoot()): Promise<string[]> {
  const base = path.resolve(root)
  const manifests = await walkFiles(base, {
    skipDir: isNodeModules,
    keep: (relative) => path.posix.basename(relative) === MANIFEST_FILE,
  })
  const dirs = manifests.map((manifest) => path.posix.dirname(manifest))
  // A fixture's own subdirectories are not searched: a manifest inside one belongs to the fixture.
  const isNested = (dir: string): boolean =>
    dirs.some((parent) => parent !== dir && (parent === '.' || dir.startsWith(`${parent}/`)))
  return dirs
    .filter((dir) => !isNested(dir))
    .map((dir) => path.join(base, dir))
    .toSorted(compareStrings)
}

/**
 * Turns the directories named on the command line into fixture directories: a fixture itself, or a
 * directory with fixtures under it (`fixtures/runtime`). The result is in argument order, sorted
 * within each argument, without repeats. An argument with no `fixture.json` in or under it is
 * `HARNESS_FIXTURE_NOT_FOUND`.
 * @public
 */
export async function resolveFixtureDirs(args: readonly string[]): Promise<string[]> {
  const found = new Set<string>()
  for (const arg of args) {
    const root = path.resolve(arg)
    let dirs: string[]
    try {
      dirs = await findFixtures(root)
    } catch (cause) {
      if (!isNotFound(cause)) throw cause
      dirs = []
    }
    if (dirs.length === 0) {
      throw new HarnessError(
        'HARNESS_FIXTURE_NOT_FOUND',
        `no ${MANIFEST_FILE} in or under ${root}`,
        {
          path: root,
        },
      )
    }
    for (const dir of dirs) found.add(dir)
  }
  return [...found]
}
