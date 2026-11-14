// Runs one `snapshot/*` fixture end to end through `provino/node`'s `run()` and a forked worker
// (B17b, T7.9 and T7.10; DECISIONS S4: a dev package runs Provino only through `provino/node` or
// the bin). The fixture is copied to a temp directory, the runner's own stored files are written
// beside it, and the run is told what the recorded run was told: CI or not, `-u`, a name pattern,
// the update variable. What comes back is the exit code, the normalized run and the files the
// golden captured.
//
// Provino has the Jest dialect only, so the `vitest` profile is the Jest dialect with Vitest's
// `snapshot` slice layered over it (header, joins, obsolete rules, error body, format, printer):
// the keys that decide what a `.snap` holds. Files that call `vi` can't run and are not part of it.
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import type { NormalizedRun } from '@provino/types'
import { run } from 'provino/node'
import { type Fixture, type FixtureRunner, testFilesFor } from '../fixture.ts'
import { parseNormalizedRun } from '../parse-normalized-run.ts'
import { copyFixture, writeRunnerFiles } from '../record.ts'

/** The two profiles the corpus runs under. */
export type SnapshotProfile = FixtureRunner

/** The test files Provino can run for a profile: the runner's own, less the ones that call `vi`. */
export function runnableFiles(fixture: Fixture, profile: SnapshotProfile): readonly string[] {
  return testFilesFor(fixture.files, profile).filter(
    (file) => !path.posix.basename(file).endsWith('.vitest.test.ts'),
  )
}

/** What an end-to-end run reports. */
export interface SnapshotEndToEnd {
  readonly exitCode: number
  readonly normalized: NormalizedRun
  /** The files the golden captured, as the run left them (`null`: not there). */
  readonly files: Readonly<Record<string, string | null>>
  /** What the run wrote to stderr: Provino's own errors. */
  readonly stderr: string
}

/** A sink that keeps what it is given. */
function collector(): { readonly stream: Writable; text(): string } {
  const chunks: string[] = []
  return {
    stream: new Writable({
      write(chunk: unknown, _encoding, done) {
        chunks.push(String(chunk))
        done()
      },
    }),
    text: () => chunks.join(''),
  }
}

/** The flags the recorded run was given, as `run()` options. */
function optionsOf(fixture: Fixture, profile: SnapshotProfile) {
  const argv = fixture.manifest.run?.argv?.[profile] ?? []
  // A flag this runner doesn't map would run differently from the recording, silently.
  const pattern = argv.indexOf('-t')
  argv.forEach((token, index) => {
    const patternValue = pattern !== -1 && index === pattern + 1
    // `--ci` is the recorder's own flag again: the run is CI unless the fixture clears it.
    if (!patternValue && !['--ci', '--ci=false', '-u', '-t'].includes(token)) {
      throw new Error(`${fixture.id}: the corpus runner doesn't map the argument "${token}"`)
    }
  })
  const env = fixture.manifest.env ?? {}
  // The recorder runs with `CI=1`; a fixture clears it, and Jest also takes `--ci=false`.
  const ci = env.CI !== '' && !argv.includes('--ci=false')
  return {
    ci,
    update: argv.includes('-u'),
    pattern: pattern === -1 ? undefined : argv[pattern + 1],
    // The variables other than CI, which `run()` reads from the process.
    env: Object.entries(env).filter(([name]) => name !== 'CI'),
  }
}

/** The config's snapshot keys for a profile, from the fixture's overlay. */
function configuredSnapshot(fixture: Fixture, profile: SnapshotProfile) {
  const overlay = fixture.manifest.config?.[profile] as Record<string, unknown> | undefined
  const section =
    (profile === 'vitest' ? (overlay?.test as Record<string, unknown>) : overlay) ?? {}
  const serializers = Array.isArray(section.snapshotSerializers)
    ? (section.snapshotSerializers as string[])
    : []
  const format =
    typeof section.snapshotFormat === 'object' && section.snapshotFormat !== null
      ? (section.snapshotFormat as Record<string, unknown>)
      : undefined
  return { serializers, format }
}

/**
 * Runs the fixture's runnable test files for `profile` through `run()`: one forked worker, the
 * normalized-json reporter, no results cache. `signal` stops the run (its worker is killed) before
 * the caller's deadline. `captured` names the files to read back (the golden's).
 */
export async function runSnapshotEndToEnd(
  fixture: Fixture,
  profile: SnapshotProfile,
  captured: readonly string[],
  signal: AbortSignal,
): Promise<SnapshotEndToEnd> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'provino-snapshot-e2e-')))
  const options = optionsOf(fixture, profile)
  const previous = options.env.map(([name]) => [name, process.env[name]] as const)
  try {
    await copyFixture(fixture, root)
    await writeRunnerFiles(fixture, profile, root)

    const { serializers, format } = configuredSnapshot(fixture, profile)
    const require = createRequire(import.meta.url)
    const config = path.join(root, 'provino.config.mjs')
    await writeConfig(config, {
      include: runnableFiles(fixture, profile),
      profile,
      serializers: serializers.map((name) => require.resolve(name)),
      format,
    })

    const outputFile = path.join(root, 'normalized.json')
    const stdout = collector()
    const stderr = collector()
    for (const [name, value] of options.env) process.env[name] = value
    const { exitCode } = await run({
      config,
      cwd: root,
      pool: 'forks',
      maxWorkers: 1,
      cache: false,
      ci: options.ci,
      ...(options.update ? { updateSnapshot: true } : {}),
      ...(options.pattern === undefined ? {} : { testNamePattern: options.pattern }),
      reporters: [['normalized-json', { outputFile }]],
      stdout: stdout.stream,
      stderr: stderr.stream,
      signal,
    })
    signal.throwIfAborted()
    const normalized = parseNormalizedRun(await readFile(outputFile, 'utf8'), outputFile)
    const files: Record<string, string | null> = {}
    for (const file of captured) files[file] = await readIfThere(path.join(root, file))
    return { exitCode, normalized, files, stderr: stderr.text() }
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
    await rm(root, { recursive: true, force: true })
  }
}

async function readIfThere(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Writes the config: the Jest dialect, with Vitest's snapshot slice over it for the `vitest`
 * profile and the fixture's serializers and format over that. It imports the dialect packages by
 * file URL, so it needs no `node_modules`; this process's `provino-source` condition resolves
 * their own imports.
 */
async function writeConfig(
  file: string,
  input: {
    readonly include: readonly string[]
    readonly profile: SnapshotProfile
    readonly serializers: readonly string[]
    readonly format: Record<string, unknown> | undefined
  },
): Promise<void> {
  const jest = import.meta.resolve('@provino/dialect-jest')
  const vitest = import.meta.resolve('@provino/dialect-vitest')
  const { escapeString, printBasicPrototype, ...extra } = input.format ?? {}
  const text = `import { jestDialect } from ${JSON.stringify(jest)}
import { vitestPolicy } from ${JSON.stringify(vitest)}

const base = ${input.profile === 'vitest' ? 'vitestPolicy.snapshot' : 'jestDialect.policy.snapshot'}
const format = {
  ...base.format,
  ...${JSON.stringify({ escapeString, printBasicPrototype })},
  extra: ${JSON.stringify(extra)},
}
const dialect = {
  ...jestDialect,
  policy: {
    ...jestDialect.policy,
    snapshot: { ...base, serializers: ${JSON.stringify(input.serializers)}, format },
  },
}

export default {
  dialect: 'jest',
  dialects: [dialect],
  include: ${JSON.stringify(input.include)},
}
`
  await writeFile(file, text)
}
