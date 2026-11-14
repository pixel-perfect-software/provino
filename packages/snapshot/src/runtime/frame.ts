// Where an inline snapshot's call is, from the stack of the call (B23d B1): the first frame that
// names a file outside `node_modules`, as jest-message-util 30.5.1's `getTopFrame` finds it
// (index.ts L370-L390). The worker's stacks are source-mapped, so the position is the source's.
import { fileURLToPath } from 'node:url'

/** A frame's place: 1-based line and column, as V8 prints them. */
export interface StackFrame {
  readonly file: string
  readonly line: number
  readonly column: number
}

/** `at fn (file:line:col)` or `at file:line:col`; `async` and `new` prefixes included. */
const FRAME = /^\s*at (?:.*? \()?(.+?):(\d+):(\d+)\)?$/

/**
 * The first frame of `stack` with a file outside `node_modules` and Node's own modules, or
 * `undefined` when there is none.
 */
export function topFrame(stack: string): StackFrame | undefined {
  for (const line of stack.split('\n')) {
    if (line.includes('/node_modules/')) continue
    const match = FRAME.exec(line)
    if (match === null) continue
    const [, location, lineText, columnText] = match
    if (location === undefined || location.startsWith('node:')) continue
    const file = location.startsWith('file://') ? fileURLToPath(location) : location
    return { file, line: Number(lineText), column: Number(columnText) }
  }
  return undefined
}
