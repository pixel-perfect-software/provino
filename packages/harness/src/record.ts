import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NormalizedRun, SnapshotFileState } from '@provino/types'
import { convertJest } from './convert-jest.ts'
import { convertVitest } from './convert-vitest.ts'
import { readRunEnvironment } from './environment.ts'
import { HarnessError } from './errors.ts'
import {
  type Fixture,
  type FixtureProfile,
  type FixtureRunner,
  readFixture,
  runnerOfProfile,
  testFilesFor,
} from './fixture.ts'
import { goldenPath, type RecordOutcome, serializeGolden, toGolden } from './golden.ts'
import { assertNoPathLeak, assertRunComplete, commitGolden } from './internal/recording.ts'
import {
  jestConfig,
  runnerEnv,
  TRACE_ENV,
  traceSetupSource,
  vitestConfigSource,
} from './internal/runner-config.ts'
import { assertTraceFromOneFile, readTrace } from './internal/trace.ts'
import { isNodeModules, walkFiles } from './internal/walk.ts'
import { createWorkDirRegistry, REMOVE_TREE_OPTIONS } from './internal/work-dirs.ts'
import { parseJestJson, parseVitestJson } from './parse-results.ts'
import { runProcess } from './run-process.ts'
import { resolveRunnerPackage } from './runner-package.ts'

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
const TIMEOUT_MS = 120_000

const PACKAGE_DIR = path.resolve(import.meta.dirname, '..')
const REPO_ROOT = path.resolve(PACKAGE_DIR, '..', '..')
const WORK_ROOT = path.join(PACKAGE_DIR, '.record')
const TRANSFORMER_PATH = fileURLToPath(new URL('./jest-transform.ts', import.meta.url))

// A signal ends the CLI through `process.exit` (`exitOnSignals`), which skips `recordRead`'s
// cleanup, so the work directories on disk are also removed on exit. One per process, because
// `exit` is.
const workDirs = createWorkDirRegistry()

/**
 * Every directory that names this machine. The runner's text is normalized against the work
 * directory, and the finished golden must not contain any of them.
 */
interface RecordPaths {
  readonly workDir: string
  readonly realWorkDir: string
  readonly repoRoot: string
  readonly packageDir: string
  readonly realPackageDir: string
  readonly home: string
}

async function recordPaths(workDir: string): Promise<RecordPaths> {
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
async function collectSnapshotFiles(root: string): Promise<SnapshotFileState[]> {
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

async function copyFixture(fixture: Fixture, workDir: string): Promise<void> {
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

  let args: string[]
  if (runner === 'jest') {
    const configFile = path.join(outDir, 'jest.config.json')
    await writeFile(
      configFile,
      `${JSON.stringify(jestConfig(workDir, TRANSFORMER_PATH, setupFile), null, 2)}\n`,
    )
    args = [install.bin, '--ci', '--json', `--outputFile=${outputFile}`, '--config', configFile]
  } else {
    const configFile = path.join(workDir, 'vitest.config.ts')
    await writeFile(configFile, vitestConfigSource(workDir, setupFile, profile))
    args = [
      install.bin,
      'run',
      '--config',
      configFile,
      '--reporter=json',
      `--outputFile=${outputFile}`,
    ]
  }

  let result: Awaited<ReturnType<typeof runProcess>>
  try {
    result = await runProcess(process.execPath, args, {
      cwd: workDir,
      env: runnerEnv(process.env, { ...fixture.manifest.env, [TRACE_ENV]: traceFile }),
      timeoutMs: TIMEOUT_MS,
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

  // A failing test makes the runner exit non-zero, which is expected. No JSON is not.
  let json: string
  try {
    json = await readFile(outputFile, 'utf8')
  } catch (cause) {
    throw new HarnessError(
      'HARNESS_RUNNER_FAILED',
      `${runner} wrote no JSON for ${fixture.id} (exit ${result.exitCode}). Output tail:\n${result.output}`,
      { path: fixture.dir, cause },
    )
  }

  const base = {
    rootDir: paths.realWorkDir,
    extraRoots: [paths.workDir],
    suite: fixture.id,
    runnerVersion: install.version,
    env: readRunEnvironment({ [runner]: install.version }),
    snapshotFiles: await collectSnapshotFiles(workDir),
  }
  const run =
    runner === 'jest'
      ? convertJest(parseJestJson(json, outputFile), base)
      : convertVitest(parseVitestJson(json, outputFile), base)
  const label = `${fixture.id} (${profile})`
  const testFiles = testFilesFor(fixture.files, profile)
  assertRunComplete(run, testFiles, label, {
    expectCrash: fixture.manifest.expectCrash?.[profile],
  })
  const trace = await readTrace(traceFile)
  assertTraceFromOneFile(trace, testFiles, label)
  return { run, trace }
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

  await mkdir(WORK_ROOT, { recursive: true })
  const workDir = await mkdtemp(
    path.join(WORK_ROOT, `${fixture.id.replaceAll('/', '-')}-${profile}-`),
  )
  const keep = options.keepWorkDir === true
  if (!keep) workDirs.track(workDir)
  let text: string
  try {
    await copyFixture(fixture, workDir)
    const paths = await recordPaths(workDir)
    const { run, trace } = await runUnderRunner(fixture, profile, paths)
    text = serializeGolden(toGolden(run, { profile, trace }))
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
async function removeWorkDir(workDir: string): Promise<void> {
  await rm(workDir, REMOVE_TREE_OPTIONS)
  workDirs.forget(workDir)
}
