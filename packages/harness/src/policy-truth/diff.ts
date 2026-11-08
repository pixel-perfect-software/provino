// `provino-harness policy-diff jest vitest` (T1.8): every leaf where two dialects differ, over the
// same leaves T1.7 checks (the resolved policy, the hoisting rules under `hoist.`, the globals'
// names), in path order.
import { inspect, isDeepStrictEqual } from 'node:util'
import type { PolicyDifference } from '@provino/policy'
import type { FixtureRunner } from '../fixture.ts'
import { SUBJECTS, subjectLeaves } from './subjects.ts'

/** Every leaf whose value differs between the two dialects, sorted by path. */
export function dialectDiff(a: FixtureRunner, b: FixtureRunner): readonly PolicyDifference[] {
  const left = subjectLeaves(SUBJECTS[a])
  const right = subjectLeaves(SUBJECTS[b])
  const paths = [...new Set([...left.keys(), ...right.keys()])].toSorted()
  return paths
    .filter((path) => !isDeepStrictEqual(left.get(path), right.get(path)))
    .map((path) => ({ path, a: left.get(path), b: right.get(path) }))
}

/** How much of a value a row shows: a hoisting rule's name list runs to hundreds of entries. */
const MAX_VALUE = 60

function show(value: unknown): string {
  const text =
    typeof value === 'object' && value !== null && 'module' in value && 'export' in value
      ? `ref ${String((value as { export: unknown }).export)}`
      : inspect(value, { depth: 4, breakLength: Infinity, compact: true })
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text
}

/**
 * The table `policy-diff` prints: a heading, then one line per differing leaf with each dialect's
 * value, a long value cut at 60 characters, and the row count last.
 */
export function formatDialectDiff(a: FixtureRunner, b: FixtureRunner): string {
  const rows = dialectDiff(a, b)
  const table: (readonly [string, string, string])[] = [
    ['key', a, b],
    ...rows.map((row) => [row.path, show(row.a), show(row.b)] as const),
  ]
  const keyWidth = Math.max(...table.map(([key]) => key.length))
  const aWidth = Math.max(...table.map(([, left]) => left.length))
  const lines = table.map(([key, left, right]) =>
    `${key.padEnd(keyWidth)}  ${left.padEnd(aWidth)}  ${right}`.trimEnd(),
  )
  return `${lines.join('\n')}\n\n${rows.length} keys differ`
}
