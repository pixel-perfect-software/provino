import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { HarnessError } from './errors.ts'
import { compareStrings, isRecord } from './internal/guards.ts'
import { isNodeModules, walkFiles } from './internal/walk.ts'

/**
 * A runner a fixture can be recorded under.
 * @public
 */
export type FixtureRunner = 'jest' | 'vitest'

/**
 * The runners the recorder can run, in the order goldens are listed.
 * @public
 */
export const FIXTURE_RUNNERS: readonly FixtureRunner[] = ['jest', 'vitest']

/**
 * A fixture's `fixture.json`.
 * @public
 */
export interface FixtureManifest {
  /** What behaviour the fixture pins down. */
  readonly description: string
  /** The runners it is recorded under. */
  readonly runners: readonly FixtureRunner[]
  /** Environment variables for the runner process, on top of the recorder's own. */
  readonly env?: Readonly<Record<string, string>>
}

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

const KNOWN_KEYS: ReadonlySet<string> = new Set(['description', 'runners', 'env'])

function isFixtureRunner(value: unknown): value is FixtureRunner {
  return value === 'jest' || value === 'vitest'
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
        `${source}: unknown key "${key}" (expected description, runners, env)`,
        { path: source },
      )
    }
  }
  const { description, runners, env } = value
  if (typeof description !== 'string' || description.trim() === '') {
    throw new HarnessError(
      'HARNESS_FIXTURE_BAD_DESCRIPTION',
      `${source}: "description" must be a non-empty string`,
      { path: source },
    )
  }
  if (!Array.isArray(runners) || runners.length === 0 || !runners.every(isFixtureRunner)) {
    throw new HarnessError(
      'HARNESS_FIXTURE_BAD_RUNNERS',
      `${source}: "runners" must be a non-empty array of "jest" | "vitest"`,
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
  if (env === undefined) return { description, runners }
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
  return { description, runners, env: stringEnv }
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
 * The test files a runner runs, from a fixture's file list.
 * @public
 */
export function testFilesFor(files: readonly string[], runner: FixtureRunner): readonly string[] {
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
  for (const runner of manifest.runners) {
    if (testFilesFor(files, runner).length === 0) {
      throw new HarnessError(
        'HARNESS_FIXTURE_NO_TESTS',
        `${absolute} lists "${runner}" but has no test file for it (*.test.ts or *.${runner}.test.ts)`,
        { path: absolute },
      )
    }
  }
  const relative = path.relative(fixturesRoot, absolute)
  const id = relative.startsWith('..')
    ? path.basename(absolute)
    : relative.split(path.sep).join('/')
  return { dir: absolute, id, manifest, files }
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
