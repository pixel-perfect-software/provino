// Where an error happened, shared by the reporters that point at a line (`github-actions`'
// annotations and the `provino` reporter's failure blocks).
import type { SerializedError, SourceLocation } from '@provino/types'
import { userFrames } from '../../text/format.ts'

/** `at fn (path:line:col)` or `at path:line:col`: where the frame is, or `undefined`. */
export function frameLocation(frame: string): SourceLocation | undefined {
  const match = /(?:\(|\bat\s+)(?:async\s+)?(?:.*?\()?(.+?):(\d+):(\d+)\)?\s*$/.exec(frame.trim())
  if (match === null) return undefined
  const [, file, line, column] = match
  if (file === undefined || line === undefined || column === undefined) return undefined
  return { file: file.replace(/^file:\/\//, ''), line: Number(line), column: Number(column) }
}

/** Where an error happened: its own `location`, else the first frame of its stack that isn't a library's. */
export function errorLocation(error: SerializedError): SourceLocation | undefined {
  if (error.location !== undefined) return error.location
  for (const frame of userFrames(error)) {
    const found = frameLocation(frame)
    if (found !== undefined) return found
  }
  return undefined
}
