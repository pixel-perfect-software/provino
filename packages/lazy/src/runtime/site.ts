// A definition's site: the first stack frame outside the lazy API, as a `SourceLocation`, taken
// when the definition is registered. Errors name it, and a worker-scoped value is keyed by it.
import { fileURLToPath } from 'node:url'
import type { SourceLocation } from '@provino/types'

const FRAME = /^\s*at (?:.*? \()?(.+?):(\d+):(\d+)\)?$/
const UNKNOWN: SourceLocation = Object.freeze({ file: '<unknown>', line: 0, column: 0 })

// A public forwarder (api.ts) that calls into a shared-group function names itself here for that one
// call, under a `Symbol.for` key so a forwarder of one copy of this package reaches the runtime of
// another. The function reads it first thing and clears it, so nothing it calls inherits it.
const VIA: unique symbol = Symbol.for('provino.lazy.site-via') as never

type Via = (...args: never[]) => unknown

/**
 * Called by a public forwarder just before it calls the runtime: the next `takeSiteVia` returns
 * `fn`, so the site is the caller of the forwarder.
 * @internal
 */
export function setSiteVia(fn: Via): void {
  ;(globalThis as { [VIA]?: Via })[VIA] = fn
}

/**
 * The forwarder that called, or `own` when the user called the runtime directly. Clears it.
 * @internal
 */
export function takeSiteVia(own: Via): Via {
  const holder = globalThis as { [VIA]?: Via }
  const via = holder[VIA]
  if (via === undefined) return own
  Reflect.deleteProperty(holder, VIA)
  return via
}

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
