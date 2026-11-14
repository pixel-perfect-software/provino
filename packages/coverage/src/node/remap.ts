// T8.10: the merged Istanbul map moved back to the sources, as Jest's CoverageReporter does it
// (`_getCoverageResult`: `createSourceMapStore().transformCoverage(map)`). A file instrumented after
// a transform that moved its code carries the map that leads back (`inputSourceMap`, which the
// instrumenter embeds); `istanbul-lib-source-maps` follows it, and leaves every other file as it is.
import type libCoverage from 'istanbul-lib-coverage'
import libSourceMaps from 'istanbul-lib-source-maps'

/**
 * The remapped map, and the source lookup its reports read (the original text a map carried, else
 * the file on disk).
 * @public
 */
export interface RemappedCoverage {
  readonly map: libCoverage.CoverageMap
  readonly sourceFinder: (path: string) => string
}

/**
 * Remaps `map` through each file's `inputSourceMap`.
 * @public
 */
export async function remapCoverage(map: libCoverage.CoverageMap): Promise<RemappedCoverage> {
  const store = libSourceMaps.createSourceMapStore()
  const remapped = await store.transformCoverage(map)
  return { map: remapped, sourceFinder: (path) => store.sourceFinder(path) }
}
