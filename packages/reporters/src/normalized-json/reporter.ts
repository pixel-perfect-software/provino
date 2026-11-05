import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Reporter, RunEnvironment, TaskId } from '@provino/types'
import type { TextSink } from '../sink.ts'
import {
  buildNormalizedRun,
  type FileRecord,
  newFileRecord,
  type RunError,
  testsInOrder,
  type UnhandledErrors,
} from './build.ts'
import { readRunEnvironment } from './environment.ts'

/**
 * Options for `normalizedJsonReporter`.
 * @public
 */
export interface NormalizedJsonReporterOptions {
  /** Where the JSON goes. It wins over `stream`; its directory is created. */
  readonly outputFile?: string
  /** Where it goes without an `outputFile`. Default: `process.stdout`. */
  readonly stream?: TextSink
  /** The corpus id: `NormalizedRun.suite`. */
  readonly suite: string
  /** `NormalizedRun.runner`, e.g. `provino:jest`. */
  readonly runner: string
  /** `NormalizedRun.runnerVersion`. */
  readonly runnerVersion: string
  /** The machine. Default: read from `node:os` and `process`, with `runners: { provino: runnerVersion }`. */
  readonly env?: RunEnvironment
  /**
   * Whether the run is a CI run: `NormalizedRun.env.ci`, over `env.ci` when both are given. Give
   * the run's own answer, so the file agrees with what the run did. Default: read from the `CI`
   * environment variable (set to anything but empty, `0` or `false`, ignoring case and spaces).
   */
  readonly ci?: boolean
  /**
   * What the run does about unhandled errors: the orchestrator's `unhandledErrors` policy. Under
   * `fail-run` (default) they fail the file they are charged to and the run; under `ignore` they
   * are still recorded (`fileError`, `runErrors`) but `success` and the file's status ignore them,
   * so `success` agrees with the exit code.
   */
  readonly unhandledErrors?: UnhandledErrors
  /** The wall clock, in epoch milliseconds, for `startedAt`. Default `Date.now`. */
  readonly now?: () => number
}

/** The machine the run is on: `options.env` or the one read from this process, with `options.ci` over its `ci`. */
function runEnvironment(options: NormalizedJsonReporterOptions): RunEnvironment {
  const machine = options.env ?? readRunEnvironment({ provino: options.runnerVersion })
  return options.ci === undefined ? machine : { ...machine, ci: options.ci }
}

/**
 * Writes `text` to a temp file beside `path` and renames it over `path`, so a reader (or a second
 * run writing the same path) never sees half a file. A failed write removes the temp file.
 */
async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, text)
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/**
 * The `normalized-json` reporter (U4): collects the run's events and, at `run:end`, writes one
 * `NormalizedRun` (Track 12's result model) to a file or a stream. It is the same model the
 * harness's converters write for Jest and Vitest, so a Provino run diffs against theirs.
 *
 * - A test's identity is its file, its `fullName` and its `dupIndex`; its status comes from its
 *   `test-end`. A test collected but never ended is `notRun`.
 * - A file whose worker died is `crashed`, with `fileError` naming the cause; the tests that
 *   ended keep their status and the rest are `notRun`.
 * - `runErrors` are the unhandled errors tied to no file, and every `error` event.
 * - A write that fails throws from the `run:end` handler, so the bus records it and the run fails.
 * @public
 */
export function normalizedJsonReporter(options: NormalizedJsonReporterOptions): Reporter {
  const now = options.now ?? Date.now
  let files = new Map<TaskId, FileRecord>()
  let runErrors: RunError[] = []
  let startedAt: string | undefined

  function record(fileId: TaskId): FileRecord {
    let existing = files.get(fileId)
    if (existing === undefined) {
      existing = newFileRecord()
      files.set(fileId, existing)
    }
    return existing
  }

  return {
    name: 'normalized-json',

    'run:start'() {
      files = new Map()
      runErrors = []
      startedAt = new Date(now()).toISOString()
    },

    'file:collected'(file, event) {
      const entry = record(file.fileId)
      for (const test of testsInOrder(event.tasks)) entry.tests.set(test.id, test)
    },

    'test:attempt-end'(task, event) {
      // Every attempt is noted, so a test with no retries reads 0, not "unknown".
      const entry = record(task.fileId)
      entry.retries.set(task.id, (entry.retries.get(task.id) ?? 0) + (event.willRetry ? 1 : 0))
    },

    'task:end'(task, event) {
      if (task.type === 'suite' && event.type === 'suite-end') {
        // A suite's own failure (an `afterAll`) is in no test and no file result.
        const { state, errors } = event.result
        if (state === 'fail') record(task.fileId).suiteErrors.push(...errors)
        return
      }
      if (task.type !== 'test' || event.type !== 'test-end') return
      const entry = record(task.fileId)
      if (!entry.tests.has(task.id)) entry.tests.set(task.id, task)
      entry.results.set(task.id, event.result)
    },

    unhandled(file, event) {
      if (file === null) runErrors.push({ error: event.error, unhandled: true })
      else record(file.fileId).unhandled.push(event.error)
    },

    'file:end'(result) {
      record(result.file.fileId).ended = result
    },

    error(error) {
      runErrors.push({ error, unhandled: false })
    },

    async 'run:end'(summary) {
      const run = buildNormalizedRun({
        runner: options.runner,
        runnerVersion: options.runnerVersion,
        suite: options.suite,
        startedAt: startedAt ?? new Date(now()).toISOString(),
        env: runEnvironment(options),
        files,
        runErrors,
        reason: summary.reason,
        unhandledErrors: options.unhandledErrors ?? 'fail-run',
      })
      const text = `${JSON.stringify(run, null, 2)}\n`
      if (options.outputFile !== undefined) {
        const path = resolve(options.outputFile)
        await writeAtomically(path, text)
      } else {
        await (options.stream ?? process.stdout).write(text)
      }
    },
  }
}
