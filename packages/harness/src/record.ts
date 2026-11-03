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
import { type Fixture, type FixtureRunner, readFixture, testFilesFor } from './fixture.ts'
import { goldenPath, type RecordOutcome, serializeGolden, toGolden } from './golden.ts'
import { assertNoPathLeak, assertRunComplete, commitGolden } from './internal/recording.ts'
import { jestConfig, runnerEnv, vitestConfigSource } from './internal/runner-config.ts'
import { isNodeModules, walkFiles } from './internal/walk.ts'
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
  readonly runner: FixtureRunner
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

async function runUnderRunner(
  fixture: Fixture,
  runner: FixtureRunner,
  paths: RecordPaths,
): Promise<NormalizedRun> {
  const { workDir } = paths
  const install = resolveRunnerPackage(runner, PACKAGE_DIR)
  const outDir = path.join(workDir, '.harness-out')
  await mkdir(outDir)
  const outputFile = path.join(outDir, `${runner}.json`)

  let args: string[]
  if (runner === 'jest') {
    const configFile = path.join(outDir, 'jest.config.json')
    await writeFile(
      configFile,
      `${JSON.stringify(jestConfig(workDir, TRANSFORMER_PATH), null, 2)}\n`,
    )
    args = [install.bin, '--ci', '--json', `--outputFile=${outputFile}`, '--config', configFile]
  } else {
    const configFile = path.join(workDir, 'vitest.config.ts')
    await writeFile(configFile, vitestConfigSource(workDir))
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
      env: runnerEnv(process.env, fixture.manifest.env),
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
  assertRunComplete(run, testFilesFor(fixture.files, runner), `${fixture.id} (${runner})`)
  return run
}

/**
 * Records one fixture under one runner. Copies the fixture into a fresh directory, writes the
 * runner's config there, runs the pinned runner, converts and normalizes its JSON with that
 * directory as `<root>`, and writes `__goldens__/<runner>.json` next to the fixture. With
 * `check`, it compares with the committed golden instead and reports `drift` or `missing`.
 * @public
 */
export async function recordFixture(
  dir: string,
  runner: FixtureRunner,
  options: RecordOptions = {},
): Promise<RecordResult> {
  return recordRead(await readFixture(dir), runner, options)
}

/**
 * `recordFixture` for a fixture that was already read, so a caller that read it does not read it
 * again.
 * @internal
 */
export async function recordRead(
  fixture: Fixture,
  runner: FixtureRunner,
  options: RecordOptions = {},
): Promise<RecordResult> {
  if (!fixture.manifest.runners.includes(runner)) {
    throw new HarnessError(
      'HARNESS_FIXTURE_RUNNER_NOT_LISTED',
      `${fixture.id} does not list "${runner}" in its fixture.json`,
      { path: fixture.dir },
    )
  }

  await mkdir(WORK_ROOT, { recursive: true })
  const workDir = await mkdtemp(
    path.join(WORK_ROOT, `${fixture.id.replaceAll('/', '-')}-${runner}-`),
  )
  const keep = options.keepWorkDir === true
  let text: string
  try {
    await copyFixture(fixture, workDir)
    const paths = await recordPaths(workDir)
    text = serializeGolden(toGolden(await runUnderRunner(fixture, runner, paths)))
    assertNoPathLeak(text, Object.values(paths), `${fixture.id} (${runner})`)
  } catch (error) {
    // A cleanup that fails must not replace the error that made it necessary.
    if (!keep) await removeWorkDir(workDir).catch(() => undefined)
    throw error
  }
  if (!keep) await removeWorkDir(workDir)

  const target = goldenPath(fixture.dir, runner)
  const committed = await commitGolden(target, text, options.check === true)
  return {
    fixture: fixture.id,
    runner,
    goldenPath: target,
    ...committed,
    ...(keep ? { workDir } : {}),
  }
}

function removeWorkDir(workDir: string): Promise<void> {
  return rm(workDir, { recursive: true, force: true, maxRetries: 3 })
}
