// A harness fixture as a project to run: its test files and `files` tree written to $TMPDIR with
// a Jest config made of the recorder's own base and the fixture's overlay, and the real Jest's
// golden for it. `provino` may not import `@provino/harness` (the harness depends on it), so the
// fixtures are read as the files they are.
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `packages/harness/fixtures/`. */
export const FIXTURES: string = fileURLToPath(new URL('../../harness/fixtures/', import.meta.url))

/** What a fixture's `fixture.json` says that a run needs. */
export interface RecordedManifest {
  readonly description: string
  readonly config?: { readonly jest?: Readonly<Record<string, unknown>> }
  readonly files?: { readonly jest?: Readonly<Record<string, string>> }
  /** Installed into `node_modules/<name>/` before the run. */
  readonly packages?: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly run?: {
    readonly argv?: { readonly jest?: readonly string[] }
    readonly capture: readonly string[]
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
    readonly stderr?: string
    readonly files?: Readonly<Record<string, string | null>>
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
 * fixtures (arrays replace; none has a nested object).
 */
export async function materialize(fixture: RecordedFixture): Promise<Materialized> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'provino-recorded-')))
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
  const config = { rootDir: root, ...RECORDER_BASE, ...fixture.manifest.config?.jest }
  await writeFile(join(root, 'jest.config.json'), JSON.stringify(config, null, 2))
  return { root, dispose: () => rm(root, { recursive: true, force: true }) }
}

/** `text` with the project's path as the recorder writes it. */
export function underRoot(text: string, root: string): string {
  return text.replaceAll(root, '<root>')
}
