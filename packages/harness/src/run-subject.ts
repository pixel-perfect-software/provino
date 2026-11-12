import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type { NormalizedRun } from '@provino/types'
import { convertProvino } from './convert-provino.ts'
import { readRunEnvironment } from './environment.ts'
import { HarnessError } from './errors.ts'
import { convertRunnerJson } from './internal/convert-runner.ts'
import { SIDECAR_ENV } from './internal/sidecar-format.ts'
import { collectSnapshotFiles, TIMEOUT_MS } from './record.ts'
import { type CommandWrap, type ProcessResult, runProcess } from './run-process.ts'
import { resolveRunnerPackage } from './runner-package.ts'
import { parseSidecar, sidecarReporterPath } from './sidecar.ts'

/**
 * A runner `runSubject` can run: Jest or Vitest with the sidecar reporter, or Provino (its
 * `provino` bin, which writes `normalized-json` itself).
 * @public
 */
export type SubjectRunner = 'jest' | 'vitest' | 'provino'

/**
 * What `runSubject` runs, where, and how its result is normalized.
 * @public
 */
export interface SubjectOptions {
  readonly runner: SubjectRunner
  /** Where the runner runs. */
  readonly cwd: string
  /** Absolute. Test paths are made relative to it, and it is `<root>` in normalized text. */
  readonly rootDir: string
  /** Other roots to replace with `<root>`, such as the `rootDir` spelled through a symlink. */
  readonly extraRoots?: readonly string[]
  /**
   * The runner's own arguments: Jest's flags and test paths, `run` and Vitest's flags, or `run` and
   * Provino's flags. The harness's flags go after them, because `--reporters` is an array flag
   * that would take a test path that followed it.
   */
  readonly argv: readonly string[]
  /** The runner's whole environment. `PROVINO_SIDECAR_OUT` is added. */
  readonly env: NodeJS.ProcessEnv
  /** The corpus or fixture id, the run's `suite`. */
  readonly suite: string
  /** Where the runner's JSON and the sidecar go. Created if missing. */
  readonly outDir: string
  /** The process group is terminated after this long. Default: 2 minutes. */
  readonly timeoutMs?: number
  /** Where the runner package is resolved from, as `require` would. Default: `cwd`. */
  readonly from?: string | URL
  /** Collects the ids of the normalization rules that changed any text. */
  readonly fired?: Set<string>
  /** Called with each chunk of the runner's output. */
  readonly onOutput?: (chunk: string) => void
  /**
   * Wraps the process that is spawned (B16: a `sandbox-exec` around Node). It receives the command
   * and its arguments and returns what to run instead; the working directory, environment and
   * deadline are unchanged.
   */
  readonly wrap?: CommandWrap
}

/**
 * A finished subject run.
 * @public
 */
export interface SubjectResult {
  readonly run: NormalizedRun
  readonly runnerVersion: string
  /** The runner's exit code; a failing test makes it non-zero, which is not an error here. */
  readonly exitCode: number | null
  /** The runner's JSON (Provino's `normalized-json`), as written. */
  readonly rawPath: string
  readonly raw: string
  /** The sidecar file and its text; Provino has none, because its JSON carries console output. */
  readonly sidecarPath?: string
  readonly sidecar?: string
  /** The process: the end of its output, its wall time. */
  readonly process: ProcessResult
}

/** The file names under `outDir`. */
function outPaths(runner: SubjectRunner, outDir: string): { raw: string; sidecar: string } {
  return {
    raw: path.join(outDir, `${runner}.raw.json`),
    sidecar: path.join(outDir, `${runner}.console.jsonl`),
  }
}

/**
 * The arguments after the runner's bin: the caller's, then what the harness needs. Jest writes
 * `--json` to `raw` with locations, keeps its default reporter and adds the sidecar, and never runs
 * silent or verbose. Under `--silent` Jest buffers no console. Verbose makes its worker write
 * console straight to the terminal (`CustomConsole`) instead of buffering it for the reporters,
 * and `@jest/core` turns verbose on by itself when exactly one test file runs unless
 * `--verbose=false` is given. Jest 30.5.2 still buffered in both cases when probed, but the flag
 * costs nothing on the versions B16's repos pin. Vitest writes its JSON reporter to `raw` and adds
 * the sidecar. Provino writes `normalized-json` to `raw`.
 * @internal
 */
export function subjectArgs(
  runner: SubjectRunner,
  argv: readonly string[],
  files: { readonly raw: string; readonly sidecar: string },
): string[] {
  switch (runner) {
    case 'jest':
      return [
        ...argv,
        '--json',
        `--outputFile=${files.raw}`,
        '--testLocationInResults',
        '--silent=false',
        '--verbose=false',
        '--reporters=default',
        `--reporters=${sidecarReporterPath('jest')}`,
      ]
    case 'vitest':
      return [
        ...argv,
        '--reporter=json',
        `--outputFile.json=${files.raw}`,
        `--reporter=${sidecarReporterPath('vitest')}`,
      ]
    case 'provino':
      return [...argv, '--reporter', 'normalized-json', '--outputFile', files.raw]
    default: {
      const unexpected: never = runner
      throw new HarnessError('HARNESS_USAGE', `unknown runner ${String(unexpected)}`)
    }
  }
}

// Provino's bin is its TypeScript source, and its packages point their exports at `src/` under
// this condition only (DECISIONS S1); the bench runs it the same way.
const PROVINO_NODE_ARGS: readonly string[] = ['--conditions=provino-source']

async function readOutput(
  file: string,
  what: string,
  runner: SubjectRunner,
  result: ProcessResult,
) {
  try {
    return await readFile(file, 'utf8')
  } catch (cause) {
    throw new HarnessError(
      what === 'sidecar' ? 'HARNESS_SIDECAR_MISSING' : 'HARNESS_RUNNER_FAILED',
      `${runner} wrote no ${what} (exit ${result.exitCode ?? result.signal}). Output tail:\n${result.output}`,
      { path: file, cause },
    )
  }
}

/**
 * Runs one runner over a project and returns its `NormalizedRun` (Track 12 R1). The runner is the
 * one installed for `from` (default `cwd`), started with Node in its own process group with a
 * deadline (`runProcess`), so a hung run and everything it forked are ended together. Jest and
 * Vitest get their JSON reporter and the sidecar reporter by absolute path (`subjectArgs`); the
 * JSON and the console it captured are converted (`convertJest`, `convertVitest`) with `rootDir`
 * as `<root>`. Provino is its `provino` bin, run from source (DECISIONS S4), and its
 * `normalized-json` is validated and normalized (`convertProvino`). The snapshot files under
 * `rootDir` are hashed after the run.
 *
 * A failing test is a result, not an error. `HARNESS_RUNNER_FAILED` when the runner can't be
 * found or started, times out, or writes no JSON; `HARNESS_SIDECAR_MISSING` when the sidecar
 * reporter wrote nothing at all (it didn't load); `HARNESS_RESULT_INVALID` for a JSON file that
 * isn't what the runner should write.
 * @public
 */
export async function runSubject(options: SubjectOptions): Promise<SubjectResult> {
  const { runner, cwd, rootDir, outDir, suite } = options
  const install = resolveRunnerPackage(runner, options.from ?? cwd)
  await mkdir(outDir, { recursive: true })
  const files = outPaths(runner, outDir)
  // An earlier run's files in a reused `outDir` would pass for this run's if this one wrote none
  // (it failed to start, crashed or was killed first), so they go before it starts.
  await Promise.all([rm(files.raw, { force: true }), rm(files.sidecar, { force: true })])
  const nodeArgs = runner === 'provino' ? PROVINO_NODE_ARGS : []
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  let result: ProcessResult
  const spawned = {
    command: process.execPath,
    args: [...nodeArgs, install.bin, ...subjectArgs(runner, options.argv, files)],
  }
  const target = options.wrap === undefined ? spawned : options.wrap(spawned.command, spawned.args)
  try {
    result = await runProcess(target.command, target.args, {
      cwd,
      env: runner === 'provino' ? options.env : { ...options.env, [SIDECAR_ENV]: files.sidecar },
      timeoutMs,
      ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput }),
    })
  } catch (cause) {
    throw new HarnessError('HARNESS_RUNNER_FAILED', `could not start ${runner} in ${cwd}`, {
      path: cwd,
      cause,
    })
  }
  if (result.timedOut) {
    throw new HarnessError(
      'HARNESS_RUNNER_FAILED',
      `${runner} timed out after ${timeoutMs} ms in ${cwd}; its process group was terminated. Output tail:\n${result.output}`,
      { path: cwd },
    )
  }

  const raw = await readOutput(files.raw, 'JSON', runner, result)
  const snapshotFiles = await collectSnapshotFiles(rootDir)
  const roots = options.extraRoots === undefined ? {} : { extraRoots: options.extraRoots }
  const fired = options.fired === undefined ? {} : { fired: options.fired }
  const base = { process: result, exitCode: result.exitCode, rawPath: files.raw, raw }

  if (runner === 'provino') {
    const run = convertProvino(
      raw,
      { rootDir, ...roots, suite, snapshotFiles, ...fired },
      files.raw,
    )
    return { ...base, run, runnerVersion: run.runnerVersion }
  }

  const sidecar = await readOutput(files.sidecar, 'sidecar', runner, result)
  const convertOptions = {
    rootDir,
    ...roots,
    suite,
    runnerVersion: install.version,
    env: readRunEnvironment({ [runner]: install.version }),
    snapshotFiles,
    console: parseSidecar(sidecar, files.sidecar),
    ...fired,
  }
  const run = convertRunnerJson(runner, raw, files.raw, convertOptions)
  return {
    ...base,
    run,
    runnerVersion: install.version,
    sidecarPath: files.sidecar,
    sidecar,
  }
}
