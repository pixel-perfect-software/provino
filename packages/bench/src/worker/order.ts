// The ordering checker for B10's third acceptance line: "each test's events arrive in order".
// It is fed what the coordinator sees, in arrival order: a marker when a file's job is sent, every
// event, and a marker for each `fileDone`. It returns what broke:
//   per file   file-collect-start < file-collect-end < (suites, tests, hooks) < file-end < fileDone
//   per test   test-start < (test-attempt-start < its hook events < test-attempt-end)+ < test-end
// A test that never started an attempt (skipped, todo) goes straight to test-end. Nothing for a
// test comes after its test-end, and nothing for a file after its file-end, except console output
// and unhandled errors: the packer orders those before the file's fileDone, but a floating promise
// can write after a test ended, and a failed teardown is charged after file-end. Files run one at
// a time, so every event belongs to the file whose job was sent last; each event that names its
// file (or a task of it) must name that file.
import type { TaskId, WorkerEvent } from '@provino/types'

/**
 * One thing the coordinator saw, in order.
 * @public
 */
export type OrderInput =
  /** The coordinator sent the job for `fileId`: the events until its `fileDone` are its own. */
  | { readonly type: 'run'; readonly fileId: TaskId }
  /** The coordinator received the running file's `fileDone`. */
  | { readonly type: 'fileDone' }
  | WorkerEvent

type TestPhase = 'started' | 'in-attempt' | 'between-attempts' | 'ended'

interface TestState {
  phase: TestPhase
  attempts: number
  /** The open attempt's numbers. */
  attempt: { readonly attempt: number; readonly repeat: number } | undefined
}

type FilePhase = 'sent' | 'collecting' | 'running' | 'ended'

interface FileState {
  readonly fileId: TaskId
  phase: FilePhase
  readonly tests: Map<TaskId, TestState>
  /** Tests `file-collect-end` listed. */
  readonly collected: Set<TaskId>
  readonly suites: Set<TaskId>
  readonly hooks: Set<string>
}

/**
 * The checker. Feed it every input; `finish` ends the run and returns the violations, in the order
 * they were found.
 * @public
 */
export interface OrderChecker {
  feed(input: OrderInput): void
  /** Reports files still without a `fileDone`, and returns every violation. */
  finish(): readonly string[]
}

/** The file a task id belongs to: ids are `<fileId>` or `<fileId>_<index>[_<index>…]`. */
const fileOf = (id: string): string => id.split('_', 1)[0] ?? id

const hookKey = (event: Extract<WorkerEvent, { readonly type: 'hook-start' | 'hook-end' }>) =>
  `${event.ownerId}/${event.testId ?? '-'}/${event.kind}/${event.ordinal}`

/**
 * Creates a checker for one run.
 * @public
 */
export function createOrderChecker(): OrderChecker {
  const violations: string[] = []
  let file: FileState | undefined
  /** `fileDone`s seen, so output before the first file (the worker’s start) is not “late”. */
  let done = 0

  /** Records a violation, named by the task it is about, else by the running file. */
  const fail = (message: string, task?: string): undefined => {
    const subject = task ?? file?.fileId
    violations.push(subject === undefined ? message : `${subject}: ${message}`)
    return undefined
  }

  /** Checks that the task `id` belongs to the running file. */
  const own = (id: string, what: string): boolean => {
    if (file === undefined) {
      fail(`${what} with no file running`, id)
      return false
    }
    if (fileOf(id) !== file.fileId) {
      fail(`${what} belongs to ${fileOf(id)}, not to the running file`, id)
      return false
    }
    return true
  }

  /** The running file, once it is past collection and not yet ended; else records the violation. */
  const running = (what: string, id?: string): FileState | undefined => {
    if (file === undefined) {
      fail(`${what} with no file running`, id)
      return undefined
    }
    if (file.phase !== 'running') {
      const where =
        file.phase === 'ended' ? 'after file-end' : `before file-collect-end (${file.phase})`
      fail(`${what} ${where}`, id)
      return undefined
    }
    return file
  }

  const test = (id: TaskId, what: string): TestState | undefined => {
    if (!own(id, what)) return undefined
    const current = running(what, id)
    const state = current?.tests.get(id)
    if (current !== undefined && state === undefined) fail(`${what} before test-start`, id)
    if (state?.phase === 'ended') {
      fail(`${what} after test-end`, id)
      return undefined
    }
    return state
  }

  function onEvent(event: WorkerEvent): undefined {
    switch (event.type) {
      case 'file-collect-start':
        if (file === undefined) fail('file-collect-start with no file running')
        else if (event.fileId !== file.fileId) {
          fail(`file-collect-start names ${event.fileId}, not the running file`)
        } else if (file.phase !== 'sent') fail(`file-collect-start twice, or after ${file.phase}`)
        else file.phase = 'collecting'
        return
      case 'file-collect-end': {
        if (file === undefined) return fail('file-collect-end with no file running')
        if (event.fileId !== file.fileId) {
          return fail(`file-collect-end names ${event.fileId}, not the running file`)
        }
        if (file.phase !== 'collecting') {
          return fail(
            `file-collect-end ${file.phase === 'sent' ? 'before file-collect-start' : `after ${file.phase}`}`,
          )
        }
        file.phase = 'running'
        for (const task of event.tasks) {
          if (task.type === 'test') file.collected.add(task.id)
        }
        return
      }
      case 'file-end': {
        if (file === undefined) return fail('file-end with no file running')
        if (event.fileId !== file.fileId) {
          return fail(`file-end names ${event.fileId}, not the running file`)
        }
        if (file.phase !== 'running') {
          return fail(
            `file-end ${file.phase === 'ended' ? 'twice' : `before file-collect-end (${file.phase})`}`,
          )
        }
        for (const [id, state] of file.tests) {
          if (state.phase !== 'ended') fail('test never ended before file-end', id)
        }
        for (const id of file.suites) fail('suite never ended before file-end', id)
        for (const key of file.hooks) fail(`hook never ended before file-end (${key})`)
        for (const id of file.collected) {
          if (!file.tests.has(id)) fail('collected, but it never started', id)
        }
        file.phase = 'ended'
        return
      }
      case 'suite-start': {
        const current = own(event.id, 'suite-start') ? running('suite-start', event.id) : undefined
        if (current === undefined) return
        if (current.suites.has(event.id)) fail('suite-start twice', event.id)
        current.suites.add(event.id)
        return
      }
      case 'suite-end': {
        const current = own(event.id, 'suite-end') ? running('suite-end', event.id) : undefined
        if (current === undefined) return
        if (!current.suites.delete(event.id)) return fail('suite-end without suite-start', event.id)
        for (const [id, state] of current.tests) {
          if (id.startsWith(`${event.id}_`) && state.phase !== 'ended') {
            fail(`suite ended while its test ${id} was still running`, event.id)
          }
        }
        return
      }
      case 'test-start': {
        const current = own(event.id, 'test-start') ? running('test-start', event.id) : undefined
        if (current === undefined) return
        if (current.tests.has(event.id)) return fail('test-start twice', event.id)
        current.tests.set(event.id, { phase: 'started', attempts: 0, attempt: undefined })
        return
      }
      case 'test-attempt-start': {
        const state = test(event.id, 'test-attempt-start')
        if (state === undefined) return
        if (state.phase === 'in-attempt')
          return fail('test-attempt-start inside an open attempt', event.id)
        state.phase = 'in-attempt'
        state.attempts++
        state.attempt = { attempt: event.attempt, repeat: event.repeat }
        return
      }
      case 'test-attempt-end': {
        const state = test(event.id, 'test-attempt-end')
        if (state === undefined) return
        if (state.phase !== 'in-attempt' || state.attempt === undefined) {
          return fail('test-attempt-end with no open attempt', event.id)
        }
        if (state.attempt.attempt !== event.attempt || state.attempt.repeat !== event.repeat) {
          fail(
            `test-attempt-end is attempt ${event.attempt}/${event.repeat}, the open one is ${state.attempt.attempt}/${state.attempt.repeat}`,
            event.id,
          )
        }
        state.phase = 'between-attempts'
        state.attempt = undefined
        return
      }
      case 'test-end': {
        const state = test(event.id, 'test-end')
        if (state === undefined) return
        if (state.phase === 'in-attempt') fail('test-end inside an open attempt', event.id)
        else if (
          state.attempts === 0 &&
          event.result.state !== 'skip' &&
          event.result.state !== 'todo'
        ) {
          fail(`test-end (${event.result.state}) without an attempt`, event.id)
        }
        state.phase = 'ended'
        return
      }
      case 'hook-start':
      case 'hook-end': {
        const what = event.type
        if (!own(event.ownerId, what)) return
        if (event.testId !== null) {
          // A hook for a test happens inside one of its attempts.
          if (!own(event.testId, what)) return
          const state = test(event.testId, what)
          if (state === undefined) return
          if (state.phase !== 'in-attempt')
            fail(`${what} (${event.kind}) outside an attempt`, event.testId)
        } else if (running(what, event.ownerId) === undefined) return
        const key = hookKey(event)
        if (event.type === 'hook-start') {
          if (file?.hooks.has(key)) fail(`hook-start twice (${key})`)
          file?.hooks.add(key)
        } else if (!file?.hooks.delete(key)) {
          fail(`hook-end without hook-start (${key})`)
        }
        return
      }
      case 'annotation':
        test(event.testId, 'annotation')
        return
      case 'console':
        if (file === undefined && done > 0) fail('console output after the last fileDone')
        return
      case 'unhandled-error':
        if (file === undefined && done > 0) fail('unhandled-error after the last fileDone')
        return
      case 'coverage':
      case 'deps':
        return
      default:
        return event satisfies never
    }
  }

  return {
    feed(input) {
      if (input.type === 'run') {
        if (file !== undefined) fail('a job was sent before the previous file’s fileDone')
        file = {
          fileId: input.fileId,
          phase: 'sent',
          tests: new Map(),
          collected: new Set(),
          suites: new Set(),
          hooks: new Set(),
        }
      } else if (input.type === 'fileDone') {
        if (file === undefined) return fail('fileDone with no file running')
        if (file.phase !== 'ended') fail(`fileDone before file-end (${file.phase})`)
        file = undefined
        done++
      } else {
        onEvent(input)
      }
    },
    finish() {
      if (file !== undefined) fail('the run ended before fileDone')
      return violations
    },
  }
}

/**
 * Checks a whole sequence at once.
 * @public
 */
export function checkOrder(inputs: readonly OrderInput[]): readonly string[] {
  const checker = createOrderChecker()
  for (const input of inputs) checker.feed(input)
  return checker.finish()
}
