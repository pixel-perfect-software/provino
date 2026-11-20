import { stat } from 'node:fs/promises'

/** What `path` is: a directory, a file, or `undefined` when it is neither or can't be read. */
export async function kindOf(path: string): Promise<'directory' | 'file' | undefined> {
  try {
    const stats = await stat(path)
    return stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : undefined
  } catch {
    return undefined
  }
}
