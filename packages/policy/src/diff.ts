import { inspect, isDeepStrictEqual } from 'node:util'
import type { Policy } from '@provino/types'
import { isGroup, joinPath } from './internal/objects.ts'

/**
 * One policy key whose value differs between two policies.
 * @public
 */
export interface PolicyDifference {
  /** The key, e.g. `core.hookOrder.afterAll`. */
  readonly path: string
  readonly a: unknown
  readonly b: unknown
}

/**
 * Lists every key whose value differs between two policies, in key order. Groups of keys are
 * compared key by key; other values (arrays, refs, RegExps) are compared whole, and closures by
 * identity.
 * @public
 */
export function diffPolicy(a: Policy, b: Policy): readonly PolicyDifference[] {
  const out: PolicyDifference[] = []
  walk(a, b, '', out)
  return out
}

function walk(a: unknown, b: unknown, path: string, out: PolicyDifference[]): void {
  if (isGroup(a) && isGroup(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of [...keys].sort()) walk(a[key], b[key], joinPath(path, key), out)
    return
  }
  if (!isDeepStrictEqual(a, b)) out.push({ path, a, b })
}

/**
 * Prints `diffPolicy` rows as an aligned key-by-key table, one line per key.
 * @public
 */
export function formatPolicyDiff(
  rows: readonly PolicyDifference[],
  labels: readonly [string, string] = ['a', 'b'],
): string {
  const table = [['key', ...labels], ...rows.map((row) => [row.path, show(row.a), show(row.b)])]
  const widths = [0, 1].map((col) => Math.max(...table.map((cells) => cells[col]?.length ?? 0)))
  return table
    .map((cells) =>
      cells
        .map((cell, col) => (col < 2 ? cell.padEnd(widths[col] ?? 0) : cell))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}

function show(value: unknown): string {
  if (typeof value === 'function') return `[closure ${value.name || 'anonymous'}]`
  return inspect(value, { depth: 4, breakLength: Infinity, compact: true })
}
