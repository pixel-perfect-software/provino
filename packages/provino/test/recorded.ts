// A harness fixture as a project to run: its test files and `files` tree written to $TMPDIR with
// a Jest config made of the recorder's own base and the fixture's overlay, and the real Jest's
// golden for it. `provino` may not import `@provino/harness` (the harness depends on it), so the
// fixtures are read as the files they are.
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Json } from './mask.ts'

/** `packages/harness/fixtures/`. */
export const FIXTURES: string = fileURLToPath(new URL('../../harness/fixtures/', import.meta.url))

/** What a fixture's `fixture.json` says that a run needs. */
export interface RecordedManifest {
  readonly description: string
  /** Set in the runner's environment; `null` removes a variable the recorder sets. */
  readonly env?: Readonly<Record<string, string | null>>
  readonly config?: { readonly jest?: Readonly<Record<string, unknown>> }
  readonly files?: { readonly jest?: Readonly<Record<string, string>> }
  /** Installed into `node_modules/<name>/` before the run. */
  readonly packages?: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** Runs before the captured one, with these arguments added (Jest's cache and history carry over). */
  /** Flags for `node` before the runner's bin (here: before the `provino` bin). */
  readonly nodeFlags?: readonly string[]
  /** A repository the recorder builds in the work directory: not supported by `provinoOn` yet. */
  readonly scm?: unknown
  readonly before?: readonly { readonly argv: readonly string[] }[]
  readonly run?: {
    /** The runner gets exactly `argv.jest`: no `--config`, `--ci`, `--json` or `--outputFile`. */
    readonly exact?: true
    /** The streams and files were recorded as the runner wrote them (roots, `keepLines`, `mask`). */
    readonly raw?: true
    /** `true` sorts the kept lines; `'json'` sorts the elements of the one JSON array they make. */
    readonly sortStdout?: true | 'json'
    /** `json:` captures the run may leave unwritten: they record as `null`. */
    readonly missingJson?: readonly string[]
    readonly argv?: { readonly jest?: readonly string[] }
    readonly capture: readonly string[]
    /** The lines of a stream the recording kept: a regular expression's source. */
    readonly keepLines?: string
    /** JSON keys whose numbers a `json:` capture recorded as `"<time>"`. */
    readonly timeKeys?: readonly string[]
    /** Regular-expression sources the recording replaced with `<masked>`. */
    readonly mask?: readonly string[]
    /** JSON keys whose strings the recording replaced with `<masked>` (Istanbul's `hash`). */
    readonly maskKeys?: readonly string[]
    /** The directory, relative to the root, the runner was started in. */
    readonly cwd?: string
  }
}

/** The part of a Jest golden these tests read. */
export interface RecordedGolden {
  readonly files: readonly {
    readonly file: string
    readonly status: string
    readonly tests?: readonly {
      readonly id: { readonly path: readonly string[] }
      readonly status: string
    }[]
  }[]
  readonly observed?: {
    readonly exitCode?: number | null
    readonly stdout?: string
    readonly stderr?: string
    readonly files?: Readonly<Record<string, string | null>>
    /** The parsed `json:` captures, as the recorder's `normalizedJson` leaves them. */
    readonly json?: Readonly<Record<string, Json | null>>
  }
}

export interface RecordedFixture {
  readonly id: string
  readonly dir: string
  readonly manifest: RecordedManifest
  readonly golden: RecordedGolden
}

export async function loadFixture(id: string): Promise<RecordedFixture> {
  const dir = join(FIXTURES, id)
  return {
    id,
    dir,
    manifest: JSON.parse(await readFile(join(dir, 'fixture.json'), 'utf8')) as RecordedManifest,
    golden: JSON.parse(
      await readFile(join(dir, '__goldens__', 'jest.json'), 'utf8'),
    ) as RecordedGolden,
  }
}

/** The recorder's own base for a Jest config (`internal/runner-config.ts`), minus what only it needs. */
const RECORDER_BASE = {
  testMatch: ['<rootDir>/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/__goldens__/', '\\.vitest\\.test\\.ts$'],
  // Jest writes each test's `location` into the results the goldens capture only with this on.
  testLocationInResults: true,
}

export interface Materialized {
  /** The project's real path (the golden's `<root>`). */
  readonly root: string
  readonly dispose: () => Promise<void>
}

/**
 * Writes the fixture as the recorder does: its directory (without the manifest and the goldens),
 * then the `files` tree, and a `jest.config.json` with the recorder's base and the overlay. A key
 * in the overlay replaces the base's, which is what the recorder's overlay does for these
 * fixtures (arrays replace; none has a nested object). `parent` is where the project goes (default
 * the temp directory); a fixture that names packages in its config needs one under a package
 * that installs them.
 */
export async function materialize(
  fixture: RecordedFixture,
  options: { readonly parent?: string } = {},
): Promise<Materialized> {
  const parent = options.parent ?? tmpdir()
  await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(join(parent, 'provino-recorded-')))
  await cp(fixture.dir, root, {
    recursive: true,
    filter: (source) => !/(^|\/)(fixture\.json|__goldens__)$/.test(source),
  })
  for (const [path, text] of Object.entries(fixture.manifest.files?.jest ?? {})) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), text)
  }
  for (const [name, files] of Object.entries(fixture.manifest.packages ?? {})) {
    for (const [path, text] of Object.entries(files)) {
      const target = join(root, 'node_modules', name, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, text)
    }
  }
  if (fixture.manifest.run?.exact === true) await assertNoOtherJestConfig(root, fixture.id)
  const config = { rootDir: root, ...RECORDER_BASE, ...fixture.manifest.config?.jest }
  await writeFile(join(root, 'jest.config.json'), JSON.stringify(config, null, 2))
  return { root, dispose: () => rm(root, { recursive: true, force: true }) }
}

/** `text` with the project's path as the recorder writes it. */
export function underRoot(text: string, root: string): string {
  return text.replaceAll(root, '<root>')
}

/**
 * A copy of the harness's `isJestConfigFile` and the recorder's check: under `run.exact` Jest finds
 * the recorder's `jest.config.json` from the root, so a `jest.config.*` or a `package.json` with a
 * `jest` key of the fixture's own would be overwritten or make Jest report several configs.
 */
async function assertNoOtherJestConfig(root: string, id: string): Promise<void> {
  for (const entry of await readdir(root)) {
    let other = /^jest\.config\.[^/]+$/.test(entry)
    if (entry === 'package.json') {
      try {
        const parsed: unknown = JSON.parse(await readFile(join(root, entry), 'utf8'))
        other = typeof parsed === 'object' && parsed !== null && 'jest' in parsed
      } catch {
        other = false
      }
    }
    if (other) {
      await rm(root, { recursive: true, force: true })
      throw new Error(
        `${id}: "run" is "exact", so the recorder's jest.config.json is the project's Jest config, but the fixture has "${entry}", another one`,
      )
    }
  }
}
