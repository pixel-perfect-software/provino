import path from 'node:path'
import { GOLDENS_DIR } from '../fixture.ts'
import { compareStrings, isNotFound } from './guards.ts'
import { isNodeModules, walkFiles } from './walk.ts'

/** Every `__goldens__/*.json` under a directory, skipping `node_modules`. */
async function goldenFiles(dir: string): Promise<string[]> {
  try {
    const found = await walkFiles(dir, {
      // The goldens directory is entered, but nothing inside it is: its subdirectories hold none.
      skipDir: (relative) =>
        isNodeModules(relative) || relative.split('/').slice(0, -1).includes(GOLDENS_DIR),
      keep: (relative) => relative.endsWith('.json') && relative.split('/').at(-2) === GOLDENS_DIR,
    })
    return found.map((relative) => path.join(dir, relative))
  } catch (cause) {
    if (isNotFound(cause)) return []
    throw cause
  }
}

/**
 * The goldens under `roots` that a run did not produce, sorted: a runner removed from
 * `fixture.json`, a fixture that lost its manifest, or a stray file. `produced` holds the absolute
 * paths the run wrote or compared.
 * @internal
 */
export async function findStaleGoldens(
  roots: readonly string[],
  produced: ReadonlySet<string>,
): Promise<string[]> {
  const found: string[] = []
  for (const root of roots) found.push(...(await goldenFiles(path.resolve(root))))
  return found.filter((file) => !produced.has(file)).toSorted(compareStrings)
}
