import { spawn } from 'node:child_process'
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
import { jestConfig, vitestConfigSource } from './internal/runner-config.ts'
import { lineDiff } from './internal/text-diff.ts'
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
export type RecordOutcome = 'written' | 'unchanged' | 'matches' | 'drift' | 'missing'

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
  /** For `written` and `unchanged`, the work directory when `keepWorkDir` is set. */
  readonly workDir?: string
}

const DEFAULT_TIMEOUT_MS = 120_000
const OUTPUT_TAIL_CHARS = 4_000

const PACKAGE_DIR = path.resolve(import.meta.dirname, '..')
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

/** The runner's environment: quiet, UTC and CI-style, so output doesn't depend on the caller. */
function runnerEnv(fixture: Fixture, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  // Inherited from `node --test`, a parent runner or a shell, any of these changes the output.
  for (const name of ['NODE_TEST_CONTEXT', 'FORCE_COLOR', 'NODE_ENV', 'JEST_WORKER_ID', 'VITEST']) {
    delete env[name]
  }
  return { ...env, CI: '1', NO_COLOR: '1', TZ: 'UTC', ...fixture.manifest.env }
}

interface ProcessResult {
  readonly exitCode: number | null
  readonly output: string
}

function tail(text: string): string {
  return text.length > OUTPUT_TAIL_CHARS ? text.slice(-OUTPUT_TAIL_CHARS) : text
}

function runProcess(
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: AbortSignal.timeout(options.timeoutMs),
    })
    let output = ''
    const collect = (chunk: Buffer): void => {
      output = tail(output + chunk.toString('utf8'))
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', reject)
    child.on('close', (exitCode) => resolve({ exitCode, output }))
  })
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

  let result: ProcessResult
  try {
    result = await runProcess(args, {
      cwd: workDir,
      env: runnerEnv(fixture, options.env ?? process.env),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
  } catch (cause) {
    throw new HarnessError('HARNESS_RUNNER_FAILED', `could not run ${runner} for ${fixture.id}`, {
      path: fixture.dir,
      cause,
    })
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
  return runner === 'jest'
    ? convertJest(parseJestJson(json, outputFile), base)
    : convertVitest(parseVitestJson(json, outputFile), base)
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch (cause) {
    if (isRecord(cause) && cause.code === 'ENOENT') return undefined
    throw cause
  }
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
  let text: string
  try {
    await copyFixture(fixture, workDir)
    text = serializeGolden(toGolden(await runUnderRunner(fixture, runner, workDir, options)))
  } finally {
    if (options.keepWorkDir !== true) await rm(workDir, { recursive: true, force: true })
  }

  const target = goldenPath(fixture.dir, runner)
  const committed = await readIfExists(target)
  const base = { fixture: fixture.id, runner, goldenPath: target }
  if (options.check === true) {
    if (committed === undefined) return { ...base, outcome: 'missing' }
    if (committed === text) return { ...base, outcome: 'matches' }
    return { ...base, outcome: 'drift', diff: lineDiff(committed, text) }
  }
  const kept = options.keepWorkDir === true ? { workDir } : {}
  if (committed === text) return { ...base, outcome: 'unchanged', ...kept }
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, text)
  return { ...base, outcome: 'written', ...kept }
}
