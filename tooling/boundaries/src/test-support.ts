// Helpers shared by the tests. Not a test file: `node --test` runs only `*.test.ts`.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after } from 'node:test'
import { type Manifest, parseManifest } from './manifest.ts'

const scratch: string[] = []
after(() => Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true }))))

/**
 * A fresh directory under the OS temp dir holding `files` (path → content), removed after the
 * test file finishes.
 * @public
 */
export async function scratchDir(
  prefix: string,
  files: Readonly<Record<string, string>> = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `provino-${prefix}-`))
  scratch.push(dir)
  await writeFiles(dir, files)
  return dir
}

/**
 * Writes `files` (path → content) under `dir`, creating directories as needed.
 * @public
 */
export async function writeFiles(
  dir: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
}

/**
 * A manifest of just `nodes`, with the given slices and no whole-policy names.
 * @public
 */
export function manifestOf(
  nodes: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  slices: Readonly<Record<string, string>> = {},
): Manifest {
  return parseManifest({ slices, wholePolicyTypes: [], wholePolicyValues: [], nodes })
}
