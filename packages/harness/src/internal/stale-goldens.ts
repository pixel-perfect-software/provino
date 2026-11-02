import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { GOLDENS_DIR } from '../fixture.ts'
import { compareStrings, isRecord } from './guards.ts'

async function entriesOf(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (cause) {
    if (isRecord(cause) && cause.code === 'ENOENT') return []
    throw cause
  }
}

/** Every `__goldens__/*.json` under a directory, skipping `node_modules`. */
async function goldenFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await entriesOf(dir)) {
    const full = path.join(dir, entry.name)
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    if (entry.name === GOLDENS_DIR) {
      for (const golden of await entriesOf(full)) {
        if (golden.isFile() && golden.name.endsWith('.json')) out.push(path.join(full, golden.name))
      }
    } else {
      out.push(...(await goldenFiles(full)))
    }
  }
  return out
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
