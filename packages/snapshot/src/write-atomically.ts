// Writing a file so that a reader never sees half of it, and a failed write leaves the old one:
// a temp file in the same directory, then a rename. The worker's `.snap` files and the
// coordinator's inline snapshot writes both go through it.
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Writes a file through a temp file in its directory, then a rename.
 * @internal
 */
export function writeFileAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    writeFileSync(temp, text)
    renameSync(temp, path)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // The temp file was never made, or is already gone; the first error is the one to report.
    }
    throw error
  }
}
