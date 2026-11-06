import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
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
}

/**
 * The keys of a fixture's `mockCleanup`: whether each cleanup runs before every test.
 * @public
 */
export interface MockCleanup {
  readonly clear?: boolean
  readonly reset?: boolean
  readonly restore?: boolean
  readonly unstubEnvs?: boolean
  readonly unstubGlobals?: boolean
}

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
  'expectCrash',
  'mockCleanup',
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
        `${source}: unknown key "${key}" (expected description, runners, env, expectCrash, mockCleanup)`,
        { path: source },
      )
    }
  }
  const { description, runners, env, expectCrash, mockCleanup } = value
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
    ...(expectCrash === undefined
      ? {}
      : { expectCrash: parseExpectCrash(expectCrash, runners, source) }),
    ...(mockCleanup === undefined
      ? {}
      : { mockCleanup: parseMockCleanup(mockCleanup, runners, source) }),
  }
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
