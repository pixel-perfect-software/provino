// The verbose reporter's per-file list: Jest's `VerboseReporter` layout, recorded from Jest 30.5.2
// (`cli/report-verbose`). A file's tests sit under their `describe` titles, two spaces per level;
// a suite's own tests come first, then its inner suites; a skipped or todo test is listed after the
// others of its suite (`skipped <title>`, `todo <title>`) unless `expand` keeps declaration order;
// a blank line ends the list.
import type { FileTask, SuiteTask, TaskId, TaskNode, TaskResult, TestTask } from '@provino/types'
import type { Style } from '../style.ts'

/** The marks Jest's `specialChars.ICONS` has. */
const ICONS = { fail: '✕', skip: '○', pass: '✓', todo: '✎' } as const

/** What the list is made of. */
export interface VerboseOptions {
  /** List skipped and todo tests in declaration order, with the others (Jest's `--expand`). */
  readonly expand: boolean
}

/** A test that ended, with its result. */
interface Ended {
  readonly task: TestTask
  readonly result: TaskResult
}

/** The `(3 ms)` after a test's title; none for a test that took less than a millisecond. */
function timeSuffix(result: TaskResult): string {
  const ms = Math.round(result.durationMs)
  return ms > 0 ? ` (${ms} ms)` : ''
}

function icon(state: TaskResult['state'], style: Style): string {
  if (state === 'fail') return style.red(ICONS.fail)
  if (state === 'skip') return style.yellow(ICONS.skip)
  if (state === 'todo') return style.magenta(ICONS.todo)
  return style.green(ICONS.pass)
}

/**
 * The file's tests as the verbose reporter lists them, one string per line, ending with a blank
 * line. Only tests that ended are listed, and a suite none of whose tests did is left out. An
 * empty list (no test ended) gives no lines.
 */
export function verboseList(
  tasks: readonly TaskNode[],
  results: ReadonlyMap<TaskId, TaskResult>,
  style: Style,
  options: VerboseOptions,
): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const root = tasks.find((task): task is FileTask => task.type === 'file')
  if (root === undefined) return []

  /** The ended tests directly under `parent`, then the suites with something to show. */
  function members(parent: FileTask | SuiteTask): { tests: Ended[]; suites: SuiteTask[] } {
    const tests: Ended[] = []
    const suites: SuiteTask[] = []
    for (const id of parent.children) {
      const child = byId.get(id)
      if (child === undefined) continue
      if (child.type === 'test') {
        const result = results.get(child.id)
        if (result !== undefined && result.state !== 'queued' && result.state !== 'running') {
          tests.push({ task: child, result })
        }
      } else if (child.type === 'suite' && hasEnded(child)) {
        suites.push(child)
      }
    }
    return { tests, suites }
  }

  function hasEnded(suite: SuiteTask): boolean {
    const { tests, suites } = members(suite)
    return tests.length > 0 || suites.length > 0
  }

  function line(text: string, level: number): string {
    return `${'  '.repeat(level)}${text}`
  }

  function testLine({ task, result }: Ended, level: number, plain: boolean): string {
    if (!plain && (result.state === 'skip' || result.state === 'todo')) {
      const word = result.state === 'skip' ? 'skipped' : 'todo'
      return line(`${icon(result.state, style)} ${style.dim(`${word} ${task.name}`)}`, level)
    }
    return line(
      `${icon(result.state, style)} ${style.dim(`${task.name}${timeSuffix(result)}`)}`,
      level,
    )
  }

  function render(parent: FileTask | SuiteTask, level: number): string[] {
    const { tests, suites } = members(parent)
    const lines: string[] = []
    if (options.expand) {
      for (const test of tests) lines.push(testLine(test, level, true))
    } else {
      const ran = tests.filter(({ result }) => result.state !== 'skip' && result.state !== 'todo')
      const skipped = tests.filter(({ result }) => result.state === 'skip')
      const todo = tests.filter(({ result }) => result.state === 'todo')
      for (const test of ran) lines.push(testLine(test, level, true))
      for (const test of [...skipped, ...todo]) lines.push(testLine(test, level, false))
    }
    for (const suite of suites) {
      lines.push(line(suite.name, level), ...render(suite, level + 1))
    }
    return lines
  }

  const lines = render(root, 1)
  return lines.length === 0 ? [] : [...lines, '']
}
