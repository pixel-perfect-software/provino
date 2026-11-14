import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { JsonValue, NormalizedRun, SnapshotFileState } from '@provino/types'
import { convertJest } from './convert-jest.ts'
import { convertVitest } from './convert-vitest.ts'
import { readRunEnvironment } from './environment.ts'
import { HarnessError } from './errors.ts'
import {
  type Fixture,
  type FixtureProfile,
  type FixtureRun,
  type FixtureRunner,
  type JestFixtureConfig,
  type MockCleanup,
  readFixture,
  runnerOfProfile,
  staysInside,
  testFilesFor,
} from './fixture.ts'
import {
  type GoldenObserved,
  goldenPath,
  type RecordOutcome,
  serializeGolden,
  toGolden,
} from './golden.ts'
import { compareStrings, isNotFound } from './internal/guards.ts'
import {
  assertCheckoutKeepsJestFrames,
  assertNoPathLeak,
  assertRunComplete,
  commitGolden,
} from './internal/recording.ts'
import {
  jestConfig,
  OBSERVE_SETUP_PATH,
  runnerEnv,
  TRACE_ENV,
  traceSetupSource,
  vitestConfigSource,
} from './internal/runner-config.ts'
import { assertTraceFromOneFile, readTrace } from './internal/trace.ts'
import { isNodeModules, walkFiles } from './internal/walk.ts'
import {
  createWorkDirRegistry,
  REMOVE_TREE_OPTIONS,
  type WorkDirRegistry,
} from './internal/work-dirs.ts'
import { createNormalizer } from './normalize.ts'
import { parseJestJson, parseVitestJson } from './parse-results.ts'
import { runProcess } from './run-process.ts'
import { resolveRunnerPackage } from './runner-package.ts'
import { SCHEMA_VERSION } from './schema.ts'

/** The run a black-box fixture's golden holds when the runner wrote no JSON. */
const EMPTY_RUN: Omit<NormalizedRun, 'runner' | 'runnerVersion' | 'suite' | 'env' | 'success'> = {
  schemaVersion: SCHEMA_VERSION,
  startedAt: '',
  files: [],
  runErrors: [],
}

/**
 * Options for `recordFixture`.
 * @public
 */
export interface RecordOptions {
  /** Compare with the committed golden instead of writing it. */
  readonly check?: boolean
  /** Keep the work directory, for looking at what the runner saw. */
  readonly keepWorkDir?: boolean
}

/**
 * The result of recording one fixture under one runner.
 * @public
 */
export interface RecordResult {
  /** The fixture id, `area/behaviour`. */
  readonly fixture: string
  /** The real runner behind the profile. */
  readonly runner: FixtureRunner
  /** What was recorded: the runner, or one of its profiles (`vitest-list`). */
  readonly profile: FixtureProfile
  readonly goldenPath: string
  readonly outcome: RecordOutcome
  /** For `drift`: the differing lines, `-` committed and `+` recorded. */
  readonly diff?: string
  /** The work directory, when `keepWorkDir` is set. */
  readonly workDir?: string
}

/** The harness's own deadline for one runner: two minutes. */
export const TIMEOUT_MS: number = 120_000

export const PACKAGE_DIR: string = path.resolve(import.meta.dirname, '..')
const REPO_ROOT = path.resolve(PACKAGE_DIR, '..', '..')
export const WORK_ROOT: string = path.join(PACKAGE_DIR, '.record')
export const TRANSFORMER_PATH: string = fileURLToPath(
  new URL('./jest-transform.ts', import.meta.url),
)

// A signal ends the CLI through `process.exit` (`exitOnSignals`), which skips `recordRead`'s
// cleanup, so the work directories on disk are also removed on exit. One per process, because
// `exit` is.
export const workDirs: WorkDirRegistry = createWorkDirRegistry()

/**
 * Every directory that names this machine. The runner's text is normalized against the work
 * directory, and the finished golden must not contain any of them.
 */
export interface RecordPaths {
  readonly workDir: string
  readonly realWorkDir: string
  readonly repoRoot: string
  readonly packageDir: string
  readonly realPackageDir: string
  readonly home: string
}

export async function recordPaths(workDir: string): Promise<RecordPaths> {
  return {
    workDir,
    realWorkDir: await realpath(workDir),
    repoRoot: REPO_ROOT,
    packageDir: PACKAGE_DIR,
    realPackageDir: await realpath(PACKAGE_DIR),
    home: os.homedir(),
  }
}

/** Hex sha256 of every `.snap` file the run left, outside dot-directories and `node_modules`. */
export async function collectSnapshotFiles(root: string): Promise<SnapshotFileState[]> {
  const files = await walkFiles(root, {
    skipDir: (dir) => path.posix.basename(dir).startsWith('.') || isNodeModules(dir),
    keep: (file) => file.endsWith('.snap'),
  })
  const out: SnapshotFileState[] = []
  for (const file of files) {
    const bytes = await readFile(path.join(root, file))
    out.push({ file, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  return out
}

/** Copies every file of the fixture into `workDir`, keeping its relative path. */
export async function copyFixture(fixture: Fixture, workDir: string): Promise<void> {
  for (const file of fixture.files) {
    const target = path.join(workDir, file)
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(path.join(fixture.dir, file), target)
  }
}

/** A finished run and the steps the fixture traced while it ran. */
interface Recording {
  readonly run: NormalizedRun
  readonly trace: readonly string[]
  /** What a black-box run (`run` in the manifest) showed from outside. */
  readonly observed?: GoldenObserved
}

/**
 * Writes the fixture's `files` for this runner into the work directory. A path the fixture already
 * has is refused, so a fixture file never changes under one runner only.
 */
export async function writeRunnerFiles(
  fixture: Fixture,
  runner: FixtureRunner,
  workDir: string,
): Promise<void> {
  for (const [file, text] of Object.entries(fixture.manifest.files?.[runner] ?? {})) {
    if (!staysInside(file) || fixture.files.includes(file)) {
      throw new HarnessError(
        'HARNESS_FIXTURE_BAD_FILES',
        `${fixture.id}: "files" gives "${file}", which is outside the work directory or a fixture file`,
        { path: fixture.dir },
      )
    }
    const target = path.join(workDir, file)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, text)
  }
}

/** Reads a file the run may have written, as text, or `null` when it is not there. */
async function readCaptured(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (cause) {
    if (isNotFound(cause)) return null
    throw cause
  }
}

/** Whether `text` is a JSON array: what Jest's `--listTests --json` writes in place of results. */
function isPathList(text: string): boolean {
  try {
    return Array.isArray(JSON.parse(text))
  } catch {
    return false
  }
}

/** The elements of the JSON array of strings `lines` make up, sorted (`sortStdout: 'json'`). */
function sortedJsonArray(lines: readonly string[], stream: string, source: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(lines.join('\n'))
  } catch {
    parsed = undefined
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry): entry is string => typeof entry === 'string')
  ) {
    throw new HarnessError(
      'HARNESS_FIXTURE_BAD_RUN',
      `${source}: "run" "sortStdout" is "json", but the kept lines of ${stream} are not one JSON array of strings`,
      { path: source },
    )
  }
  return parsed.toSorted(compareStrings)
}

/**
 * Each run of stack frames, which differs between machines and runners. A frame is an indented
 * `at` line of the V8 grammar, `at name (path:line:col)` or `at path:line:col` (a native frame
 * reads `(<anonymous>)`, `(native)` or `(index n)` in place of the position), and a run is
 * frames on consecutive lines: no blank line, and no line of a message that starts with `at `.
 * Copied in `packages/provino/test/mask.ts`: change both.
 */
const FRAME_RUN =
  /(?:\n[ \t]+at (?:[^\n]* \((?:[^\n]*:\d+:\d+|<anonymous>|native|index \d+)\)|[^\n ]+:\d+:\d+)(?=\n|$))+/g

/** Orders two `testResults` entries by their `name`; an entry without a string one is a broken file. */
function byName(a: JsonValue, b: JsonValue): number {
  const name = (value: JsonValue): string => {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const { name: entry } = value as { readonly [key: string]: JsonValue }
      if (typeof entry === 'string') return entry
    }
    throw new HarnessError(
      'HARNESS_FIXTURE_BAD_RUN',
      'a json: capture has a "testResults" entry with no string "name"; it cannot be put in a fixed order',
    )
  }
  return compareStrings(name(a), name(b))
}

/**
 * A `json:` capture's value as it is recorded: every string has each of `roots` as `<root>`, each
 * run of stack frames as `\n<frames>` and each `mask` match as `<masked>`; every number under one
 * of `timeKeys` is `"<time>"`. A key has each of `roots` as `<root>` (Istanbul's reports are keyed
 * by absolute path) and is otherwise kept as it is; an object whose every key is a path under a
 * root (an Istanbul map, in the order its files finished) has its keys sorted. The Provino side of
 * a comparison does the
 * same walk (`packages/provino/test/mask.ts` is a copy).
 */
export function normalizedJson(
  value: JsonValue,
  options: {
    readonly roots: readonly string[]
    readonly timeKeys: readonly string[]
    readonly mask: (text: string) => string
  },
): JsonValue {
  const rooted = (raw: string): string => {
    let out = raw
    for (const root of options.roots) out = out.replaceAll(root, '<root>')
    return out
  }
  const text = (raw: string): string => options.mask(rooted(raw).replace(FRAME_RUN, '\n<frames>'))
  const walk = (node: JsonValue, key: string | undefined): JsonValue => {
    if (typeof node === 'string') return text(node)
    if (typeof node === 'number') {
      return key !== undefined && options.timeKeys.includes(key) ? '<time>' : node
    }
    if (Array.isArray(node)) {
      const items = node.map((item) => walk(item, key))
      // Jest lists `testResults` in the order its files finished: a canonical order by file name.
      return key === 'testResults' ? items.toSorted(byName) : items
    }
    if (typeof node === 'object' && node !== null) {
      const entries = Object.entries(node).map(([name, inner]): [string, JsonValue] => [
        rooted(name),
        walk(inner, name),
      ])
      // Istanbul's maps are keyed by path in the order the files finished: a canonical order.
      return Object.fromEntries(byPathKeys(entries) ? entries.toSorted(byKey) : entries)
    }
    return node
  }
  return walk(value, undefined)
}

/** Whether every key of an object is a path under the work directory (an Istanbul map). */
function byPathKeys(entries: readonly (readonly [string, JsonValue])[]): boolean {
  return entries.length > 0 && entries.every(([key]) => key.startsWith('<root>/'))
}

function byKey(a: readonly [string, JsonValue], b: readonly [string, JsonValue]): number {
  return compareStrings(a[0], b[0])
}

/** `mask`'s regular expressions (flags `gm`) as one function over a text. */
function masker(sources: readonly string[] | undefined): (text: string) => string {
  const expressions = (sources ?? []).map((pattern) => new RegExp(pattern, 'gm'))
  return (text) =>
    expressions.reduce((out, expression) => out.replace(expression, '<masked>'), text)
}

/**
 * What a black-box run shows, in `capture`'s order of kinds: the exit code, the normalized
 * streams (only `keepLines`' lines, sorted under `sortStdout`), the named files and the parsed
 * `json:` files. A stream `keepLines` keeps no line of is `HARNESS_FIXTURE_BAD_RUN` (a pattern
 * that matches nothing would record an empty stream as the truth), unless `emptyStreams` lists it.
 * `mask` is applied to each stream and file after `normalize`. `source` names the fixture, and
 * `roots` are the work directory's spellings a `json:` file's text has as `<root>`.
 */
export function observedOf(
  spec: FixtureRun,
  result: { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string },
  files: Readonly<Record<string, string | null>>,
  normalize: (text: string) => string,
  source: string,
  roots: readonly string[] = [],
): GoldenObserved {
  const keep = spec.keepLines === undefined ? undefined : new RegExp(spec.keepLines)
  const mask = masker(spec.mask)
  const stream = (name: 'stdout' | 'stderr'): string => {
    let lines = normalize(result[name]).split('\n')
    if (keep !== undefined) {
      lines = lines.filter((line) => keep.test(line))
      if (lines.length === 0 && spec.emptyStreams?.includes(name) !== true) {
        throw new HarnessError(
          'HARNESS_FIXTURE_BAD_RUN',
          `${source}: "run" "keepLines" kept no line of ${name} (list it in "emptyStreams" if that is what the run shows)`,
          { path: source },
        )
      }
    }
    if (spec.sortStdout === true) lines = lines.toSorted(compareStrings)
    if (spec.sortStdout === 'json') lines = sortedJsonArray(lines, name, source)
    return mask(lines.join('\n'))
  }
  const captured = (name: string): boolean => spec.capture.includes(name)
  const named = spec.capture.filter((entry) => entry.startsWith('file:'))
  const parsed = spec.capture.filter((entry) => entry.startsWith('json:'))
  return {
    ...(captured('exitCode') ? { exitCode: result.exitCode } : {}),
    ...(captured('stdout') ? { stdout: stream('stdout') } : {}),
    ...(captured('stderr') ? { stderr: stream('stderr') } : {}),
    ...(named.length === 0
      ? {}
      : {
          files: Object.fromEntries(
            named.map((entry) => {
              const file = entry.slice('file:'.length)
              const text = files[file] ?? null
              if (text === null) return [file, null]
              const normalized = normalize(text)
              return [
                file,
                mask(
                  spec.sortStdout === 'json'
                    ? sortedJsonArray([normalized], file, source).join('\n')
                    : normalized,
                ),
              ]
            }),
          ),
        }),
    ...(parsed.length === 0
      ? {}
      : {
          json: Object.fromEntries(
            parsed.map((entry) => {
              const file = entry.slice('json:'.length)
              const text = files[file] ?? null
              if (text === null) {
                // A run that wrote no file would record `null` as the truth and fail later, far
                // from here: refuse it unless the fixture says that is what the run shows.
                if (spec.missingJson?.includes(entry) === true) return [file, null]
                throw new HarnessError(
                  'HARNESS_FIXTURE_BAD_RUN',
                  `${source}: "run" captures "json:${file}", which the run did not write (list "json:${file}" in "missingJson" if that is what the run shows)`,
                  { path: source },
                )
              }
              let value: JsonValue
              try {
                value = JSON.parse(text) as JsonValue
              } catch (cause) {
                throw new HarnessError(
                  'HARNESS_FIXTURE_BAD_RUN',
                  `${source}: "run" captures "json:${file}", which is not JSON`,
                  { path: source, cause },
                )
              }
              return [file, normalizedJson(value, { roots, timeKeys: spec.timeKeys ?? [], mask })]
            }),
          ),
        }),
  }
}

/**
 * Writes the fixture's `packages` into `<workDir>/node_modules/<name>/`. Each file is checked to
 * stay inside its package directory again here, so a manifest built by hand cannot escape.
 */
export async function installPackages(fixture: Fixture, workDir: string): Promise<void> {
  const modules = path.join(workDir, 'node_modules')
  for (const [name, files] of Object.entries(fixture.manifest.packages ?? {})) {
    const root = path.join(modules, name)
    for (const [file, source] of Object.entries(files)) {
      const target = path.join(root, file)
      if (!staysInside(file)) {
        throw new HarnessError(
          'HARNESS_FIXTURE_BAD_PACKAGES',
          `${fixture.id}: package file "${name}/${file}" is outside its directory`,
          { path: fixture.dir },
        )
      }
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, source)
    }
  }
}

function jestEsmOption(fixture: Fixture): { jestEsm?: true } {
  return fixture.manifest.jestEsm === true ? { jestEsm: true } : {}
}

function jestConfigOption(fixture: Fixture): { jestConfig?: JestFixtureConfig } {
  const { jestConfig } = fixture.manifest
  return jestConfig === undefined ? {} : { jestConfig }
}

function mockCleanupOption(fixture: Fixture): { mockCleanup?: MockCleanup } {
  const { mockCleanup } = fixture.manifest
  return mockCleanup === undefined ? {} : { mockCleanup }
}

async function runUnderRunner(
  fixture: Fixture,
  profile: FixtureProfile,
  paths: RecordPaths,
): Promise<Recording> {
  const { workDir } = paths
  const runner = runnerOfProfile(profile)
  const install = resolveRunnerPackage(runner, PACKAGE_DIR)
  const outDir = path.join(workDir, '.harness-out')
  await mkdir(outDir)
  const outputFile = path.join(outDir, `${profile}.json`)
  const setupFile = path.join(outDir, 'trace-setup.ts')
  const traceFile = path.join(outDir, 'trace.txt')
  await writeFile(setupFile, traceSetupSource())
  const observeSetupFile = path.join(outDir, 'observe-setup.ts')
  await copyFile(OBSERVE_SETUP_PATH, observeSetupFile)
  const overlay = fixture.manifest.config?.[runner]
  const configOptions = {
    observeSetupFile,
    ...mockCleanupOption(fixture),
    ...jestEsmOption(fixture),
    ...jestConfigOption(fixture),
    ...(overlay === undefined ? {} : { overlay }),
  }
  await writeRunnerFiles(fixture, runner, workDir)
  const spec = fixture.manifest.run
  const extraArgs = spec?.argv?.[runner] ?? []

  let args: string[]
  if (runner === 'jest') {
    const configFile = path.join(outDir, 'jest.config.json')
    await writeFile(
      configFile,
      `${JSON.stringify(jestConfig(workDir, TRANSFORMER_PATH, setupFile, configOptions), null, 2)}\n`,
    )
    args = [
      install.bin,
      '--ci',
      '--json',
      `--outputFile=${outputFile}`,
      '--config',
      configFile,
      ...extraArgs,
    ]
  } else {
    const configFile = path.join(workDir, 'vitest.config.ts')
    await writeFile(configFile, vitestConfigSource(workDir, setupFile, profile, configOptions))
    args = [
      install.bin,
      'run',
      '--config',
      configFile,
      '--reporter=json',
      `--outputFile=${outputFile}`,
      ...extraArgs,
    ]
  }

  let result: Awaited<ReturnType<typeof runProcess>>
  try {
    result = await runProcess(process.execPath, [...(fixture.manifest.nodeFlags ?? []), ...args], {
      cwd: workDir,
      env: runnerEnv(process.env, { ...fixture.manifest.env, [TRACE_ENV]: traceFile }),
      timeoutMs: TIMEOUT_MS,
      ...(spec === undefined ? {} : { keepStreams: true }),
    })
  } catch (cause) {
    throw new HarnessError('HARNESS_RUNNER_FAILED', `could not run ${runner} for ${fixture.id}`, {
      path: fixture.dir,
      cause,
    })
  }
  if (result.timedOut) {
    throw new HarnessError(
      'HARNESS_RUNNER_FAILED',
      `${runner} timed out after ${TIMEOUT_MS} ms for ${fixture.id}; its process group was terminated. Output tail:\n${result.output}`,
      { path: fixture.dir },
    )
  }

  // A failing test makes the runner exit non-zero, which is expected. No JSON is not, except for a
  // black-box run, where a runner that stops before any test (no tests found, a bad option) is
  // what the fixture records.
  const written =
    spec === undefined
      ? await readFile(outputFile, 'utf8').catch(noJson)
      : await readCaptured(outputFile)
  // `--listTests` (with the recorder's `--json`) writes the list, a JSON array of paths, where the
  // results go: a black-box run that did that has no results, and keeps the list as a file.
  const json = spec !== undefined && written !== null && isPathList(written) ? null : written
  function noJson(cause: unknown): never {
    throw new HarnessError(
      'HARNESS_RUNNER_FAILED',
      `${runner} wrote no JSON for ${fixture.id} (exit ${result.exitCode}). Output tail:\n${result.output}`,
      { path: fixture.dir, cause },
    )
  }
  const normalizer = createNormalizer({ rootDir: paths.realWorkDir, extraRoots: [paths.workDir] })
  const observed =
    spec === undefined
      ? undefined
      : observedOf(
          spec,
          {
            exitCode: result.exitCode,
            stdout: result.streams?.stdout ?? '',
            stderr: result.streams?.stderr ?? '',
          },
          Object.fromEntries(
            await Promise.all(
              spec.capture
                .filter((entry) => /^(?:file|json):/.test(entry))
                .map(async (entry) => {
                  const file = entry.slice(entry.indexOf(':') + 1)
                  return [file, await readCaptured(path.join(workDir, file))] as const
                }),
            ),
          ),
          spec.raw === true
            ? (text) =>
                [paths.realWorkDir, paths.workDir].reduce(
                  (out, root) => out.replaceAll(root, '<root>'),
                  text,
                )
            : (text) => normalizer.text(text),
          path.join(fixture.dir, 'fixture.json'),
          [paths.realWorkDir, paths.workDir],
        )

  const base = {
    rootDir: paths.realWorkDir,
    extraRoots: [paths.workDir],
    suite: fixture.id,
    runnerVersion: install.version,
    env: readRunEnvironment({ [runner]: install.version }),
    snapshotFiles: await collectSnapshotFiles(workDir),
  }
  const label = `${fixture.id} (${profile})`
  const testFiles = testFilesFor(fixture.files, profile)
  const trace = await readTrace(traceFile)
  if (json === null) {
    // A black-box run that wrote no JSON: the golden keeps what the run showed and no files.
    const empty: NormalizedRun = {
      ...EMPTY_RUN,
      runner,
      runnerVersion: install.version,
      suite: fixture.id,
      env: base.env,
      success: result.exitCode === 0,
    }
    return { run: empty, trace, ...(observed === undefined ? {} : { observed }) }
  }
  const run =
    runner === 'jest'
      ? convertJest(parseJestJson(json, outputFile), base)
      : convertVitest(parseVitestJson(json, outputFile), base)
  // A black-box run records what happened, whatever it was; the completeness rule is for the rest.
  if (spec === undefined) {
    assertRunComplete(run, testFiles, label, {
      expectCrash: fixture.manifest.expectCrash?.[profile],
    })
  }
  assertTraceFromOneFile(trace, testFiles, label)
  return { run, trace, ...(observed === undefined ? {} : { observed }) }
}

/**
 * Records one fixture under one runner or profile. Copies the fixture into a fresh directory,
 * writes the runner's config and the trace setup there, runs the pinned runner, converts and
 * normalizes its JSON with that directory as `<root>`, and writes `__goldens__/<profile>.json`
 * next to the fixture, with the steps the fixture traced. With `check`, it compares with the
 * committed golden instead and reports `drift` or `missing`.
 * @public
 */
export async function recordFixture(
  dir: string,
  profile: FixtureProfile,
  options: RecordOptions = {},
): Promise<RecordResult> {
  return recordRead(await readFixture(dir), profile, options)
}

/**
 * `recordFixture` for a fixture that was already read, so a caller that read it does not read it
 * again.
 * @internal
 */
export async function recordRead(
  fixture: Fixture,
  profile: FixtureProfile,
  options: RecordOptions = {},
): Promise<RecordResult> {
  if (!fixture.manifest.runners.includes(profile)) {
    throw new HarnessError(
      'HARNESS_FIXTURE_RUNNER_NOT_LISTED',
      `${fixture.id} does not list "${profile}" in its fixture.json`,
      { path: fixture.dir },
    )
  }

  if (runnerOfProfile(profile) === 'jest') {
    assertCheckoutKeepsJestFrames(await realpath(REPO_ROOT), `${fixture.id} (${profile})`)
  }

  await mkdir(WORK_ROOT, { recursive: true })
  const workDir = await mkdtemp(
    path.join(WORK_ROOT, `${fixture.id.replaceAll('/', '-')}-${profile}-`),
  )
  const keep = options.keepWorkDir === true
  if (!keep) workDirs.track(workDir)
  let text: string
  try {
    await copyFixture(fixture, workDir)
    await installPackages(fixture, workDir)
    const paths = await recordPaths(workDir)
    const { run, trace, observed } = await runUnderRunner(fixture, profile, paths)
    text = serializeGolden(
      toGolden(run, { profile, trace, ...(observed === undefined ? {} : { observed }) }),
    )
    assertNoPathLeak(text, Object.values(paths), `${fixture.id} (${profile})`)
  } catch (error) {
    // A cleanup that fails must not replace the error that made it necessary.
    if (!keep) await removeWorkDir(workDir).catch(() => undefined)
    throw error
  }
  if (!keep) await removeWorkDir(workDir)

  const target = goldenPath(fixture.dir, profile)
  const committed = await commitGolden(target, text, options.check === true)
  return {
    fixture: fixture.id,
    runner: runnerOfProfile(profile),
    profile,
    goldenPath: target,
    ...committed,
    ...(keep ? { workDir } : {}),
  }
}

/** Removes the work directory. If that fails, the exit hook tries again. */
export async function removeWorkDir(workDir: string): Promise<void> {
  await rm(workDir, REMOVE_TREE_OPTIONS)
  workDirs.forget(workDir)
}
