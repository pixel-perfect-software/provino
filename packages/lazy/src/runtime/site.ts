// A definition's site: the first stack frame outside the lazy API, as a `SourceLocation`, taken
// when the definition is registered. Errors name it, and a worker-scoped value is keyed by it.
import { fileURLToPath } from 'node:url'
import type { SourceLocation } from '@provino/types'

const FRAME = /^\s*at (?:.*? \()?(.+?):(\d+):(\d+)\)?$/
const UNKNOWN: SourceLocation = Object.freeze({ file: '<unknown>', line: 0, column: 0 })

/**
 * The location of the caller of `apiFn`: the first frame above it on the stack.
 * @internal
 */
export function captureSite(apiFn: (...args: never[]) => unknown): SourceLocation {
  const holder: { stack?: string } = {}
  Error.captureStackTrace(holder, apiFn)
  for (const line of (holder.stack ?? '').split('\n')) {
    const match = FRAME.exec(line)
    if (match === null) continue
    const raw = match[1] ?? ''
    let file = raw
    if (raw.startsWith('file://')) {
      try {
        file = fileURLToPath(raw)
      } catch {
        file = raw
      }
    }
    return { file, line: Number(match[2]), column: Number(match[3]) }
  }
  return UNKNOWN
}

/**
 * `file:line:column`, as the messages print it.
 * @internal
 */
export function formatSite(site: SourceLocation): string {
  return `${site.file}:${site.line}:${site.column}`
}
