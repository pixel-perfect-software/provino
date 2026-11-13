import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Writes `text` to a temp file beside `path` and renames it over `path`, so a reader (or a second
 * run writing the same path) never sees half a file. A failed write removes the temp file.
 */
export async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, text)
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}
