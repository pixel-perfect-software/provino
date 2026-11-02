import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NormalizedRun, RunEnvironment, SnapshotFileState } from '@provino/types'
import { convertJest } from './convert-jest.ts'
import { convertVitest } from './convert-vitest.ts'
import { HarnessError } from './errors.ts'
import { type Fixture, type FixtureRunner, readFixture, testFilesFor } from './fixture.ts'
import { goldenPath, serializeGolden, toGolden } from './golden.ts'
import { compareStrings, isRecord } from './internal/guards.ts'
import {
  assertNoPathLeak,
  assertRunComplete,
  type CommitOutcome,
  commitGolden,
} from './internal/recording.ts'
import { runProcess } from './internal/run-process.ts'
import { jestConfig, runnerEnv, vitestConfigSource } from './internal/runner-config.ts'
import { parseJestJson, parseVitestJson } from './parse-results.ts'

/**
 * Options for `recordFixture`.
 * @public
 */
export interface RecordOptions {
  /** Compare with the committed golden instead of writing it. */
  readonly check?: boolean
  /** Keep the work directory, for looking at what the runner saw. */
  readonly keepWorkDir?: boolean
  /** Kill the runner after this long. Default: two minutes. */
  readonly timeoutMs?: number
  /** Where work directories go. Default: `packages/harness/.record/`. */
  readonly workRoot?: string
  /** The environment the runner starts from. Default: `process.env`. */
  readonly env?: NodeJS.ProcessEnv
}

/**
 * What happened to a golden: `written` and `unchanged` when recording; `matches`, `drift` and
 * `missing` when checking.
 * @public
 */
export type RecordOutcome = CommitOutcome

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

const DEFAULT_TIMEOUT_MS = 120_000

const PACKAGE_DIR = path.resolve(import.meta.dirname, '..')
const REPO_ROOT = path.resolve(PACKAGE_DIR, '..', '..')
const TRANSFORMER_PATH = fileURLToPath(new URL('./jest-transform.ts', import.meta.url))

interface RunnerInstall {
  readonly version: string
  /** Absolute path of the file `node` runs. */
  readonly bin: string
}

function resolveRunner(runner: FixtureRunner): RunnerInstall {
  const manifestPath = fileURLToPath(import.meta.resolve(`${runner}/package.json`))
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!isRecord(manifest) || typeof manifest.version !== 'string') {
    throw new HarnessError('HARNESS_RUNNER_FAILED', `${manifestPath} has no version`, {
      path: manifestPath,
    })
  }
  const bin =
    typeof manifest.bin === 'string'
      ? manifest.bin
      : isRecord(manifest.bin)
        ? manifest.bin[runner]
        : undefined
  if (typeof bin !== 'string') {
    throw new HarnessError('HARNESS_RUNNER_FAILED', `${manifestPath} has no "${runner}" bin`, {
      path: manifestPath,
    })
  }
  return { version: manifest.version, bin: path.resolve(path.dirname(manifestPath), bin) }
}

function collectEnvironment(runner: FixtureRunner, version: string): RunEnvironment {
  return {
    os: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    cpuCount: os.cpus().length,
    memoryMb: Math.round(os.totalmem() / 2 ** 20),
    node: process.version,
    runners: { [runner]: version },
    ci: process.env.CI !== undefined && process.env.CI !== '',
  }
}

/** Hex sha256 of every `.snap` file the run left, outside dot-directories and `node_modules`. */
async function collectSnapshotFiles(root: string, prefix = ''): Promise<SnapshotFileState[]> {
  const out: SnapshotFileState[] = []
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      out.push(...(await collectSnapshotFiles(root, relative)))
    } else if (entry.isFile() && entry.name.endsWith('.snap')) {
      const bytes = await readFile(path.join(root, relative))
      out.push({ file: relative, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
  }
  return out.toSorted((a, b) => compareStrings(a.file, b.file))
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
  workDir: string,
  options: RecordOptions,
): Promise<NormalizedRun> {
  const install = resolveRunner(runner)
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

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let result: Awaited<ReturnType<typeof runProcess>>
  try {
    result = await runProcess(args, {
      cwd: workDir,
      env: runnerEnv(options.env ?? process.env, fixture.manifest.env),
      deadline: AbortSignal.timeout(timeoutMs),
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
      `${runner} timed out after ${timeoutMs} ms for ${fixture.id}; its process group was terminated. Output tail:\n${result.output}`,
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

  const realRoot = await realpath(workDir)
  const base = {
    rootDir: realRoot,
    extraRoots: [workDir],
    suite: fixture.id,
    runnerVersion: install.version,
    env: collectEnvironment(runner, install.version),
    snapshotFiles: await collectSnapshotFiles(workDir),
  }
  const run =
    runner === 'jest'
      ? convertJest(parseJestJson(json, outputFile), base)
      : convertVitest(parseVitestJson(json, outputFile), base)
  assertRunComplete(run, testFilesFor(fixture.files, runner), `${fixture.id} (${runner})`)
  return run
}

/** Paths a golden must not contain: they would tie it to this machine. */
async function leakCandidates(workDir: string): Promise<string[]> {
  return [
    workDir,
    await realpath(workDir),
    REPO_ROOT,
    PACKAGE_DIR,
    await realpath(PACKAGE_DIR),
    os.homedir(),
  ]
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
  const fixture = await readFixture(dir)
  if (!fixture.manifest.runners.includes(runner)) {
    throw new HarnessError(
      'HARNESS_FIXTURE_RUNNER_NOT_LISTED',
      `${fixture.id} does not list "${runner}" in its fixture.json`,
      { path: fixture.dir },
    )
  }
  if (testFilesFor(fixture.files, runner).length === 0) {
    throw new HarnessError(
      'HARNESS_FIXTURE_NO_TESTS',
      `${fixture.id} has no test file for ${runner}`,
      {
        path: fixture.dir,
      },
    )
  }

  const workRoot = options.workRoot ?? path.join(PACKAGE_DIR, '.record')
  await mkdir(workRoot, { recursive: true })
  const workDir = await mkdtemp(
    path.join(workRoot, `${fixture.id.replaceAll('/', '-')}-${runner}-`),
  )
  const keep = options.keepWorkDir === true
  let text: string
  try {
    await copyFixture(fixture, workDir)
    text = serializeGolden(toGolden(await runUnderRunner(fixture, runner, workDir, options)))
    assertNoPathLeak(text, await leakCandidates(workDir), `${fixture.id} (${runner})`)
  } catch (error) {
    // A cleanup that fails must not replace the error that made it necessary.
    if (!keep) await removeWorkDir(workDir).catch(() => undefined)
    throw error
  }
  if (!keep) await removeWorkDir(workDir)

  const target = goldenPath(fixture.dir, runner)
  const committed = await commitGolden({
    target,
    text,
    check: options.check === true,
    workDir: keep ? workDir : undefined,
  })
  return { fixture: fixture.id, runner, goldenPath: target, ...committed }
}

function removeWorkDir(workDir: string): Promise<void> {
  return rm(workDir, { recursive: true, force: true, maxRetries: 3 })
}
