// The neutral dialect's behaviour keys. Neutral policy points at these by ModuleRef
// (`@provino/policy/behaviours`), so it serializes like any dialect's policy.

import { inspect } from 'node:util'
import type { EnvironmentConditions, FormatEachTitle, SnapshotKey } from '@provino/types'

// `$name` or `$a.b`; a path never ends in a dot, so `$value.` keeps its period.
const PLACEHOLDER = /%[%#$sdifjoOp]|\$([A-Za-z_]\w*(?:\.\w+)*)/g

/**
 * Formats a `.each` title. `%s %d %i %f %j %o %O %p` take the row's values in order, `%#` is the
 * row index, `%$` the 1-based row number and `%%` a percent sign. `$name` (or `$a.b`) reads a
 * key of an object row. Strings print bare; other values print on one line as `util.inspect`
 * does. A value `%j` can't encode (a cycle) prints as `[Circular]`, so a title never throws.
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

const INSPECT = { depth: 2, breakLength: Infinity, compact: true } as const

function show(value: unknown, kind: string): string {
  switch (kind) {
    case 's':
      return typeof value === 'string' ? value : inspect(value, INSPECT)
    case 'd':
    case 'i':
    case 'f': {
      if (typeof value === 'bigint') return `${value}n`
      const n = typeof value === 'symbol' ? Number.NaN : Number(value)
      return String(kind === 'i' ? Math.trunc(n) : n)
    }
    case 'j':
      return toJson(value)
    default:
      return inspect(value, INSPECT)
  }
}

function toJson(value: unknown): string {
  try {
    return (
      JSON.stringify(value, (_key, item: unknown) =>
        typeof item === 'bigint' ? `${item}n` : item,
      ) ?? 'undefined'
    )
  } catch (err) {
    if (err instanceof TypeError && /circular/i.test(err.message)) return '[Circular]'
    throw err
  }
}
