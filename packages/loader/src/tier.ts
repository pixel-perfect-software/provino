// T2.11: which isolation tier a test file runs at. The project's setting is the floor; the file's
// own `@provino-isolate <tier>` docblock pragma, and a tier an earlier run learned for it (IDEAS
// I1), can only raise it. `process` is a fresh worker for the file: that is the coordinator's to
// give (the pool key), so `tierFor` just says it.
//
// The docblock reader is deliberately narrow: it reads one pragma. The worker reads the full
// docblock (`@jest-environment` and the rest) when it sets the file's environment up; this one runs
// in the coordinator before the file is queued, so it reads as little as it can.
import { open, readFile } from 'node:fs/promises'
import type { IsolationTier, Pragmas, TierChoice, TierSource, TierSources } from '@provino/types'

/** The docblock pragma that raises a file's tier: `@provino-isolate realm`. */
export const ISOLATE_PRAGMA = 'provino-isolate'

/** The tiers from the least isolated to the most. */
const TIERS: readonly IsolationTier[] = ['none', 'registry', 'realm', 'process']

function rank(tier: IsolationTier): number {
  return TIERS.indexOf(tier)
}

/** Whether `value` names an isolation tier. */
export function isIsolationTier(value: string): value is IsolationTier {
  return TIERS.some((tier) => tier === value)
}

/** The values of `pragma` in `pragmas`: none, one, or the several a repeated pragma holds. */
function valuesOf(pragmas: Pragmas | undefined, pragma: string): readonly string[] {
  const value = pragmas?.[pragma]
  if (value === undefined) return []
  return typeof value === 'string' ? [value] : value
}

/**
 * The tier a test file runs at, from the sources that name one.
 *
 * - It **raises and never lowers**: a docblock or a learned tier below the project's changes
 *   nothing (and says nothing: a shared template may name a tier a stricter project already
 *   exceeds).
 * - A `@provino-isolate` value that is not a tier (`none`, `registry`, `realm`, `process`) is
 *   ignored with a warning, and the file keeps what the other sources give it. A pragma given
 *   twice counts each value.
 * - When two sources name the tier chosen, `source` is the first of `config`, `docblock`,
 *   `learned`.
 * - `testFile` only names the file in a warning.
 * @public
 */
export function tierFor(testFile: string, sources: TierSources): TierChoice {
  let tier = sources.configured
  let source: TierSource = 'config'
  const warnings: string[] = []
  const consider = (candidate: IsolationTier, from: TierSource): void => {
    if (rank(candidate) > rank(tier)) {
      tier = candidate
      source = from
    }
  }
  for (const value of valuesOf(sources.docblock, ISOLATE_PRAGMA)) {
    if (isIsolationTier(value)) consider(value, 'docblock')
    else {
      warnings.push(
        `${testFile}: @${ISOLATE_PRAGMA} ${JSON.stringify(value)} is not an isolation tier (use ${TIERS.join(', ')}); the file keeps its tier`,
      )
    }
  }
  if (sources.learned !== undefined) consider(sources.learned, 'learned')
  return { tier, source, warnings }
}

/** How much of a file is read first: nearly every docblock fits. */
const HEAD_BYTES = 4096

/** A carriage return not before `\n`, or a line separator: jest-docblock's `.` skips them inside a comment. */
const NOT_IN_COMMENT = /\r(?!\n)|[\u2028\u2029]/

/**
 * The `@provino-isolate` pragma of the leading block comment of `source`, as `Pragmas`; `undefined`
 * when there is none. The grammar is jest-docblock's for one pragma: the first comment only (after
 * whitespace), an optional `*` before each line, `@provino-isolate value` on its own line, `//`
 * comments dropped from the value, and a repeated pragma as a list. A comment that is not closed
 * has no pragma.
 * @public
 */
export function isolatePragmaOf(source: string): Pragmas | undefined {
  const start = source.length - source.trimStart().length
  if (source.charCodeAt(start) !== 0x2f || source.charCodeAt(start + 1) !== 0x2a) return undefined
  const end = source.indexOf('*/', start + 2)
  if (end < 0) return undefined
  const comment = source.slice(start, end + 2)
  if (NOT_IN_COMMENT.test(comment) || !comment.includes(`@${ISOLATE_PRAGMA}`)) return undefined
  const inner = comment
    .replace(/^\/\*\*?/, '')
    .replace(/\*\/$/, '')
    .replaceAll(/(\r?\n|^) *\* ?/g, '$1')
  const values: string[] = []
  for (const line of inner.split(/\r?\n/)) {
    const match = /^ *@provino-isolate(?![\w-])[ \t]*(.*)$/.exec(line)
    if (match === null) continue
    values.push((match[1] ?? '').replaceAll(/(^|\s+)\/\/.*$/g, '').trim())
  }
  if (values.length === 0) return undefined
  return { [ISOLATE_PRAGMA]: values.length === 1 ? (values[0] as string) : values }
}

/**
 * `isolatePragmaOf` of the file at `path`, reading its first 4 KiB (all of it when the leading
 * comment does not end there). A file that can't be read has no pragma: the worker reports it
 * when it loads the file.
 * @public
 */
export async function readIsolatePragma(path: string): Promise<Pragmas | undefined> {
  try {
    const handle = await open(path, 'r')
    try {
      const head = Buffer.allocUnsafe(HEAD_BYTES)
      const { bytesRead } = await handle.read(head, 0, HEAD_BYTES, 0)
      const text = head.toString('utf8', 0, bytesRead)
      const trimmed = text.trimStart()
      // Not a comment, or closed inside the head: what the head holds decides.
      const unclosed = trimmed.startsWith('/*') && !trimmed.includes('*/', 2)
      if (!unclosed || bytesRead < HEAD_BYTES) return isolatePragmaOf(text)
    } finally {
      await handle.close()
    }
    return isolatePragmaOf(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}
