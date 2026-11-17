// What a run ends with: the verdict and totals, the slowest files, the snapshot totals, what was
// left open, and the failures listed again, one line each. Pure: built once, at `run:end`.

import type { OpenHandle, RunEndReason } from '@provino/types'
import type { Style } from '../../style.ts'
import { openHandlesText } from '../../text/format.ts'
import type { SlowFile } from '../model/state.ts'
import type { Glyphs } from '../terminal/glyphs.ts'
import { fitWidth } from '../terminal/width.ts'
import { fileTime, groupDigits } from './format.ts'

/** The slowest files the card names. */
export const SLOWEST_SHOWN = 3

/** The snapshot counters the card reads. */
export interface SnapshotCounts {
  readonly added: number
  readonly matched: number
  readonly unmatched: number
  readonly updated: number
  readonly unchecked: number
}

/**
 * What the end card says.
 * @beta
 */
export interface EndCardInput {
  readonly ok: boolean
  readonly reason: RunEndReason
  readonly passed: number
  readonly failed: number
  readonly skipped: number
  readonly todo: number
  readonly filesDone: number
  readonly filesFailed: number
  readonly durationMs: number
  readonly slowest: readonly SlowFile[]
  readonly snapshots: SnapshotCounts | undefined
  readonly openHandles: readonly OpenHandle[] | undefined
  /** The failures, each already one line. */
  readonly failures: readonly string[]
  /** Failures the run had that `failures` has no room for. */
  readonly failuresMore: number
}

function plural(count: number, noun: string): string {
  return `${groupDigits(count)} ${noun}${count === 1 ? '' : 's'}`
}

function snapshotLine(counts: SnapshotCounts): string {
  const parts: string[] = []
  if (counts.unmatched > 0) parts.push(`${groupDigits(counts.unmatched)} failed`)
  if (counts.added > 0) parts.push(`${groupDigits(counts.added)} written`)
  if (counts.updated > 0) parts.push(`${groupDigits(counts.updated)} updated`)
  if (counts.unchecked > 0) parts.push(`${groupDigits(counts.unchecked)} obsolete`)
  if (counts.matched > 0) parts.push(`${groupDigits(counts.matched)} passed`)
  return parts.length === 0 ? '' : `snapshots: ${parts.join(' · ')}`
}

/**
 * The card's lines, none wider than `columns - 1` columns except the open handles' text.
 * @beta
 */
export function endCardLines(
  input: EndCardInput,
  columns: number,
  glyphs: Glyphs,
  style: Style,
): string[] {
  const room = Math.max(1, columns - 1)
  const mark =
    glyphs.set === 'emoji'
      ? input.ok
        ? glyphs.passed
        : glyphs.failed
      : input.ok
        ? glyphs.pass
        : glyphs.fail
  const time = fileTime(input.durationMs)
  let headline: string
  if (input.ok) {
    const extra = [
      input.skipped > 0 ? `${groupDigits(input.skipped)} skipped` : '',
      input.todo > 0 ? `${groupDigits(input.todo)} todo` : '',
    ].filter(Boolean)
    headline = `${plural(input.passed, 'test')} passed${extra.map((part) => ` · ${part}`).join('')} in ${plural(input.filesDone, 'file')} · ${time}`
  } else {
    const parts: string[] = []
    if (input.failed > 0) parts.push(`${groupDigits(input.failed)} failed`)
    else if (input.filesFailed > 0) parts.push(`${plural(input.filesFailed, 'file')} failed`)
    else parts.push(input.reason)
    parts.push(`${groupDigits(input.passed)} passed`)
    if (input.skipped > 0) parts.push(`${groupDigits(input.skipped)} skipped`)
    if (input.todo > 0) parts.push(`${groupDigits(input.todo)} todo`)
    parts.push(plural(input.filesDone, 'file'), time)
    headline = parts.join(' · ')
  }
  const lines = [
    '',
    fitWidth(`${input.ok ? style.green(mark) : style.red(mark)} ${style.bold(headline)}`, room),
  ]
  if (input.slowest.length > 0) {
    const lead = glyphs.set === 'emoji' ? `${glyphs.slow} ` : ''
    const slow = input.slowest
      .slice(0, SLOWEST_SHOWN)
      .map((file) => `${file.path} ${fileTime(file.durationMs)}`)
      .join(' · ')
    lines.push(fitWidth(style.dim(`${lead}slowest: ${slow}`), room))
  }
  if (input.snapshots !== undefined) {
    const text = snapshotLine(input.snapshots)
    if (text !== '') lines.push(style.dim(text))
  }
  if (input.openHandles !== undefined && input.openHandles.length > 0) {
    lines.push(...openHandlesText(input.openHandles).replace(/\n+$/, '').split('\n'))
  }
  if (input.failures.length > 0) {
    lines.push('', style.red('failed:'))
    for (const failure of input.failures) lines.push(failure)
    if (input.failuresMore > 0)
      lines.push(style.dim(`  … and ${groupDigits(input.failuresMore)} more`))
  }
  return lines
}
