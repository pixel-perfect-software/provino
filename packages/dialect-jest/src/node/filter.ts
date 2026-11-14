// `--filter` (jest-core `cli/index.ts` L190-L219 and `SearchSource.ts` L326-L351, Jest 30.5.2): a
// module that exports a function from the list of a project's test paths to `{ filtered }`.
import { createRequire } from 'node:module'
import type { JestGlobalConfig } from './types.ts'

/**
 * What a filter module is, as `runCLI` reads it: a function, and optionally a `setup` that runs
 * once before the first filtering.
 */
interface RawFilter {
  (paths: string[]): unknown
  setup?: () => unknown
}

/**
 * A project's test paths in, the ones that run out.
 * @public
 */
export type JestFilter = (testPaths: readonly string[]) => Promise<readonly string[]>

/**
 * The module `--filter` (or the config's `filter`) names, loaded as `runCLI` does with a plain
 * `require` (no transform), or `undefined` with no filter or with `--skipFilter`. A `setup` export
 * starts at once; an error it throws is raised when the first project is filtered, not before.
 * The filter is called once per project with that project's test paths (absolute); anything it
 * returns without a `filtered` array is a `TypeError` (`SearchSource.getTestPaths`).
 * @public
 */
export function loadJestFilter(globalConfig: {
  readonly filter: JestGlobalConfig['filter']
  readonly skipFilter: boolean
}): JestFilter | undefined {
  const { filter: filterPath } = globalConfig
  if (filterPath === undefined || filterPath === '' || globalConfig.skipFilter) return undefined
  const raw = createRequire(filterPath)(filterPath) as RawFilter
  let setupError: Promise<unknown> | undefined
  if (raw.setup) {
    const { setup } = raw
    // Wrapped, so the rejection is not "uncaught" before the first filtering reads it.
    setupError = (async () => {
      try {
        await setup.call(raw)
      } catch (error) {
        return error
      }
      return undefined
    })()
  }
  return async (testPaths) => {
    if (setupError !== undefined) {
      const error = await setupError
      if (error) throw error
    }
    const result = (await raw([...testPaths])) as { readonly filtered?: unknown }
    // A result with no object to read it from throws what `filterResult.filtered` does in Jest.
    const filtered = result.filtered
    if (!Array.isArray(filtered)) {
      throw new TypeError(`Filter ${filterPath} did not return a valid test list`)
    }
    const kept = new Set<unknown>(filtered)
    return testPaths.filter((path) => kept.has(path))
  }
}
