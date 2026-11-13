import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { TextSink } from '../sink.ts'

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

/** Where a document reporter's text goes: `outputFile` (written atomically) or, without one, `stream`. */
export interface DocumentTarget {
  readonly outputFile?: string | undefined
  /** Default: `process.stdout`. */
  readonly stream?: TextSink | undefined
}

/** Writes a document reporter's text to its `outputFile`, else its `stream` (`process.stdout` by default). */
export async function writeDocument(target: DocumentTarget, text: string): Promise<void> {
  if (target.outputFile !== undefined) {
    await writeAtomically(resolve(target.outputFile), text)
  } else {
    await (target.stream ?? process.stdout).write(text)
  }
}
