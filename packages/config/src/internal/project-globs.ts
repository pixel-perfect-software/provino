import { glob, isDynamicPattern } from 'tinyglobby'

export { isDynamicPattern }

/**
 * The directories a glob names, from `base`, as absolute paths in sorted order (tinyglobby, the
 * matcher the orchestrator and the Vitest dialect use, D199). `node_modules` is never entered, and
 * `ignore` leaves out what its patterns match.
 */
export async function matchDirectories(
  base: string,
  pattern: string,
  ignore: readonly string[],
): Promise<string[]> {
  const found = await glob([pattern], {
    cwd: base,
    absolute: true,
    onlyDirectories: true,
    expandDirectories: false,
    ignore: ['**/node_modules/**', ...ignore],
  })
  return found.map((path) => path.replace(/\/$/, '')).toSorted()
}
