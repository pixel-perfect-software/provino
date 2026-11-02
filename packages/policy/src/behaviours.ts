// The neutral dialect's behaviour keys. Neutral policy points at these by ModuleRef
// (`@provino/policy/behaviours`), so it serializes like any dialect's policy.

import { inspect } from 'node:util'
import type { EnvironmentConditions, FormatEachTitle, SnapshotKey } from '@provino/types'

const PLACEHOLDER = /%[%#$sdifjoOp]|\$([A-Za-z_][\w.]*)/g

/**
 * Formats a `.each` title. `%s %d %i %f %j %o %O %p` take the row's values in order, `%#` is the
 * row index, `%$` the 1-based row number and `%%` a percent sign. `$name` (or `$a.b`) reads a
 * key of an object row. Strings print bare; other values print as `util.inspect` does.
 * @public
 */
export const formatEachTitle: FormatEachTitle = (template, row, index) => {
  const values = Array.isArray(row) ? row : [row]
  let next = 0
  return template.replace(PLACEHOLDER, (match: string, path: string | undefined) => {
    if (path !== undefined) return Array.isArray(row) ? match : show(readPath(row, path), 's')
    const kind = match.slice(1)
    if (kind === '%') return '%'
    if (kind === '#') return String(index)
    if (kind === '$') return String(index + 1)
    if (next >= values.length) return match
    return show(values[next++], kind)
  })
}

/**
 * Names the `count`-th snapshot of a test: `` `${fullName} ${count}` ``.
 * @public
 */
export const snapshotKey: SnapshotKey = (fullName, count) => `${fullName} ${count}`

const DOM_ENVIRONMENTS: ReadonlySet<string> = new Set(['jsdom', 'happy-dom'])

/**
 * Export conditions for an environment: its own list if it has one, `['browser']` for the DOM
 * environments, otherwise `['node']`.
 * @public
 */
export const environmentConditions: EnvironmentConditions = (env) =>
  env.conditions ?? (DOM_ENVIRONMENTS.has(env.name) ? ['browser'] : ['node'])

function readPath(row: unknown, path: string): unknown {
  let value = row
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined
    value = (value as Readonly<Record<string, unknown>>)[key]
  }
  return value
}

function show(value: unknown, kind: string): string {
  switch (kind) {
    case 's':
      return typeof value === 'string' ? value : inspect(value, { depth: 2, breakLength: Infinity })
    case 'd':
    case 'i':
      return String(kind === 'i' ? Math.trunc(Number(value)) : Number(value))
    case 'f':
      return String(Number(value))
    case 'j':
      return JSON.stringify(value) ?? 'undefined'
    default:
      return inspect(value, { depth: 2, breakLength: Infinity })
  }
}
