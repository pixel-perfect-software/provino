// What a run ends with: the verdict and totals, the slowest files, the snapshot totals, what was
// left open, and the failures listed again, one line each. Pure: built once, at `run:end`.

import type { OpenHandle, RunEndReason } from '@provino/types'
import type { Style } from '../../style.ts'
import { openHandlesText } from '../../text/format.ts'
import type { SlowFile } from '../model/state.ts'
import type { Glyphs } from '../terminal/glyphs.ts'
import { fitWidth } from '../terminal/width.ts'
import { fileTime, groupDigits, markOf, plural } from './format.ts'

/** The slowest files the card names. */
export const SLOWEST_SHOWN = 3

/** The snapshot counters the card reads. */
export interface SnapshotCounts {
  readonly added: number
  readonly matched: number
  readonly unmatched: number
  readonly updated: number
  readonly unchecked: number
  /** Snapshot files no test file has: obsolete, or removed when the run updated them. */
  readonly filesRemoved?: number
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
  /** The run's snapshot update mode: `all` (`-u`) removes obsolete files; the others leave them. */
  readonly snapshotUpdate?: 'all' | 'new' | 'none'
  /**
   * How to update snapshots, as the run was started (the dialect's words, given by the caller):
   * shown under the snapshot line when some failed or are obsolete and the run did not update.
   */
  readonly snapshotHint?: string
  /** The run's random seed, shown when the caller asks (`--showSeed`, `--randomize`). */
  readonly seed?: number
  readonly openHandles: readonly OpenHandle[] | undefined
  /** Console writes that arrived after their file ended and were not printed. */
  readonly lateConsole: number
  /** The failures, each already one line. */
  readonly failures: readonly string[]
  /** Failures the run had that `failures` has no room for. */
  readonly failuresMore: number
}

function snapshotLine(counts: SnapshotCounts, update: EndCardInput['snapshotUpdate']): string {
  const parts: string[] = []
  const filesRemoved = counts.filesRemoved ?? 0
  if (counts.unmatched > 0) parts.push(`${groupDigits(counts.unmatched)} failed`)
  if (counts.added > 0) parts.push(`${groupDigits(counts.added)} written`)
  if (counts.updated > 0) parts.push(`${groupDigits(counts.updated)} updated`)
  if (counts.unchecked > 0) parts.push(`${groupDigits(counts.unchecked)} obsolete`)
  if (filesRemoved > 0) {
    parts.push(
      update === 'all'
        ? `${plural(filesRemoved, 'file')} removed`
        : `${plural(filesRemoved, 'obsolete file')}`,
    )
  }
  if (counts.matched > 0) parts.push(`${groupDigits(counts.matched)} passed`)
  return parts.length === 0 ? '' : `snapshots: ${parts.join(' · ')}`
}

/** Whether the run left snapshots to update: some failed, or are obsolete and were not removed. */
function wantsUpdate(counts: SnapshotCounts, update: EndCardInput['snapshotUpdate']): boolean {
  if (counts.unmatched > 0) return true
  if (update === 'all') return false
  return counts.unchecked > 0 || (counts.filesRemoved ?? 0) > 0
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
      : markOf(input.ok ? 'pass' : 'fail', glyphs)
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
    const text = snapshotLine(input.snapshots, input.snapshotUpdate)
    if (text !== '') lines.push(fitWidth(style.dim(text), room))
    if (input.snapshotHint !== undefined && wantsUpdate(input.snapshots, input.snapshotUpdate)) {
      lines.push(fitWidth(style.dim(`  ${input.snapshotHint} to update them`), room))
    }
  }
  if (input.seed !== undefined) lines.push(style.dim(`seed: ${input.seed}`))
  if (input.lateConsole > 0) {
    lines.push(
      style.dim(`${plural(input.lateConsole, 'console write')} came after their file ended`),
    )
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
