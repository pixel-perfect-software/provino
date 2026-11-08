// The `.snap` file: a CommonJS script of `exports[`key`] = `value`;` lines under a header, sorted
// by natural order. Both dialects write exactly this and read it by running it.
import { SnapshotError } from './errors.ts'
import { normalizeNewlines, printBacktickString } from './text.ts'
import { naturalCompare } from './vendor/natural-compare.ts'

/**
 * The snapshots of one file, by key.
 * @public
 */
export type SnapshotData = Record<string, string>

/**
 * Writes a `.snap` file's text: the header, then every entry in natural order, a blank line
 * between them, one newline at the end.
 * @public
 */
export function serializeSnapFile(data: Readonly<SnapshotData>, header: string): string {
  const entries = Object.keys(data)
    .sort(naturalCompare)
    .map(
      (key) =>
        `exports[${printBacktickString(key)}] = ${printBacktickString(
          normalizeNewlines(data[key] ?? ''),
        )};`,
    )
  return `${header}\n\n${entries.join('\n\n')}\n`
}

/**
 * Runs a `.snap` file's text and returns what it exports. A file that throws gives what it had
 * exported by then, as in Jest; the header check is what reports it.
 * @public
 */
export function evaluateSnapFile(text: string): SnapshotData {
  const data: SnapshotData = Object.create(null)
  try {
    new Function('exports', text)(data)
  } catch {
    // Jest ignores a file that doesn't run; `checkSnapHeader` is what notices a broken one.
  }
  return data
}

/**
 * `null` when the file starts with `header`, else why it doesn't. Text, no colour.
 * @public
 */
export function checkSnapHeader(text: string, header: string): string | null {
  const [first = ''] = text.split('\n', 1)
  if (first === header) return null
  if (!/^\/\/ .*\bv\d+/.test(first)) {
    return `Outdated snapshot: no snapshot header found. The file must start with "${header}". Update the snapshots of this file to write it.`
  }
  return `Outdated snapshot: the file's header is "${first}", and this project's is "${header}". Update the snapshots of this file to write the right one.`
}

/**
 * The key of the n-th snapshot of a test, back to the test's name: the number at the end goes.
 * @public
 */
export function keyToTestName(key: string): string {
  if (!/ \d+$/.test(key)) {
    throw new SnapshotError('SNAPSHOT_BAD_KEY', `Snapshot keys must end with a number: "${key}"`)
  }
  return key.replace(/ \d+$/, '')
}
