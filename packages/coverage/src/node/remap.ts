// T8.10: the merged Istanbul map moved back to the sources, as Jest's CoverageReporter does it
// (`_getCoverageResult`: `createSourceMapStore().transformCoverage(map)`). A file instrumented after
// a transform that moved its code carries the map that leads back (`inputSourceMap`, which the
// instrumenter embeds); `istanbul-lib-source-maps` follows it, and leaves every other file as it is.
import { existsSync } from 'node:fs'
import type libCoverage from 'istanbul-lib-coverage'
import libSourceMaps from 'istanbul-lib-source-maps'

/**
 * The remapped map, and the original text of each of its sources that is not on disk at its mapped
 * path (generated, virtual or moved), from the maps' `sourcesContent`: plain data, so it can cross
 * to the reports in `RunSummary.coverage`, where a report reads it before the disk (Jest's report
 * context takes `this._sourceMapStore.sourceFinder`).
 * @public
 */
export interface RemappedCoverage {
  readonly map: libCoverage.CoverageMap
  readonly sources: Readonly<Record<string, string>>
}

/**
 * Remaps `map` through each file's `inputSourceMap`.
 * @public
 */
export async function remapCoverage(map: libCoverage.CoverageMap): Promise<RemappedCoverage> {
  const store = libSourceMaps.createSourceMapStore()
  const remapped = await store.transformCoverage(map)
  const sources: Record<string, string> = {}
  for (const path of remapped.files()) {
    if (existsSync(path)) continue
    try {
      sources[path] = store.sourceFinder(path)
    } catch {
      // No map carried its text either: the report says so when it reads the file, as Jest's does.
    }
  }
  return { map: remapped, sources }
}
