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

/**
 * A frame is `at fn (file:line:col)` or, with no function name, `at file:line:col`, each with an
 * optional `async` or `new` before the name. The two are told apart by the last character of the
 * line, not by looking for ` (` anywhere in it: a path may hold one (`My Project (1)`), and a
 * frame with no name has no parenthesis of its own. (stack-utils's `parseLine`, which Jest uses,
 * splits at the first ` (` it finds, so it reads such a path wrong and `async` as part of the
 * file.)
 */
const NAMED_FRAME = /^\s*at (?:async |new )?.*? \((.+):(\d+):(\d+)\)$/
const BARE_FRAME = /^\s*at (?:async )?(.+):(\d+):(\d+)$/

/**
 * The first frame of `stack` with a file outside `node_modules` and Node's own modules, or
 * `undefined` when there is none.
 */
export function topFrame(stack: string): StackFrame | undefined {
  for (const line of stack.split('\n')) {
    if (line.includes('/node_modules/')) continue
    const match = (line.endsWith(')') ? NAMED_FRAME : BARE_FRAME).exec(line)
    if (match === null) continue
    const [, location, lineText, columnText] = match
    if (location === undefined || location.startsWith('node:')) continue
    const file = location.startsWith('file://') ? fileURLToPath(location) : location
    return { file, line: Number(lineText), column: Number(columnText) }
  }
  return undefined
}
