import { dirname, join, resolve } from 'node:path'
import { kindOf } from './internal/kind.ts'

/**
 * The extensions a `provino.config.*` may have, in the order they are looked for.
 * @public
 */
export const PROVINO_CONFIG_EXTENSIONS: readonly string[] = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs']

/** What ends the walk up: a directory holding one of these is the top of a project or workspace. */
const ROOT_MARKERS: readonly string[] = ['.git', 'pnpm-workspace.yaml']

/**
 * The `provino.config.*` file in `directory` itself, as an absolute path, or `undefined`.
 * @public
 */
export async function findConfigInDirectory(directory: string): Promise<string | undefined> {
  for (const extension of PROVINO_CONFIG_EXTENSIONS) {
    const file = join(directory, `provino.config.${extension}`)
    if ((await kindOf(file)) === 'file') return file
  }
  return undefined
}

/**
 * The first `provino.config.*` found walking up from `from` (D196): `from` itself, then each
 * parent, stopping after the first directory that holds `.git` or `pnpm-workspace.yaml` (a
 * config there is still found) or at the filesystem root. `undefined` when there is none.
 * @public
 */
export async function findConfigUpward(from: string): Promise<string | undefined> {
  let directory = resolve(from)
  for (;;) {
    const found = await findConfigInDirectory(directory)
    if (found !== undefined) return found
    const markers = await Promise.all(
      ROOT_MARKERS.map(async (name) => (await kindOf(join(directory, name))) !== undefined),
    )
    if (markers.some(Boolean)) return undefined
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}
