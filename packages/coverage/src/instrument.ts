// U6, Track 8 F9 (D110): the Istanbul instrumenter a worker hands to the transform pipeline. It
// runs `@vitest/istanbul-lib-instrument` (vendored, on oxc-parser) the way `babel-plugin-istanbul`
// runs in Jest's `_instrumentFile`: the transformed code goes in with the map that leads from it to
// the source, the counters are written into the code, and the input map is embedded in the
// coverage data, where `istanbul-lib-source-maps` finds it when the report is remapped.
import type { CoverageInstrumenter, IstanbulFileCoverageData, SourceMapV3 } from '@provino/types'
import { ownCodeIdentity } from './code-identity.ts'
import { CoverageError } from './errors.ts'
import type { InputSourceMap } from './vendor/istanbul-lib-instrument/index.ts'
import { createInstrumenter } from './vendor/istanbul-lib-instrument/index.ts'

/**
 * Options of `istanbulInstrumenter`.
 * @public
 */
export interface IstanbulInstrumenterOptions {
  /** The global the counters live in. Jest: `__coverage__` (`istanbulVariable`). */
  readonly coverageVariable?: string
}

/** The vendored instrumenter's encoded map, as the pipeline's `SourceMapV3`. */
function toSourceMap(map: {
  readonly sources: readonly (string | null)[]
  readonly names: readonly string[]
  readonly mappings: string | readonly unknown[]
  readonly sourcesContent?: readonly (string | null)[] | undefined
}): SourceMapV3 {
  if (typeof map.mappings !== 'string') {
    throw new CoverageError('COVERAGE_INSTRUMENT_FAILED', 'the instrumenter gave a decoded map')
  }
  return {
    version: 3,
    sources: [...map.sources],
    names: [...map.names],
    mappings: map.mappings,
    ...(map.sourcesContent === undefined ? {} : { sourcesContent: [...map.sourcesContent] }),
  }
}

/**
 * The Istanbul instrumenter (`CoverageInstrumenter`) for the transform pipeline. `instrument`
 * returns the instrumented code, the map from it to the code it was given (`inputMap`, when there
 * is one, is embedded in the coverage data and not composed into this map: the pipeline composes
 * its steps), and the file's initial coverage (every counter zero). A file the source marks
 * `istanbul ignore file` comes back with its code unchanged and no counters.
 * @public
 */
export function istanbulInstrumenter(
  options: IstanbulInstrumenterOptions = {},
): CoverageInstrumenter {
  const coverageVariable = options.coverageVariable ?? '__coverage__'
  const instrumenter = createInstrumenter({
    coverageVariable,
    esModules: true,
    autoWrap: true,
    produceSourceMap: true,
    // The pipeline composes maps step by step; the input map is stored in the coverage data.
    combineSourceMaps: false,
    inputSourceMap: true,
  })
  return {
    name: `istanbul:@vitest/istanbul-lib-instrument@2.1.0:${ownCodeIdentity()}:${coverageVariable}`,
    instrument(code, filename, inputMap) {
      try {
        const instrumented = instrumenter.instrumentSync(
          code,
          filename,
          inputMap === null ? undefined : (inputMap as unknown as InputSourceMap),
        )
        const map = instrumenter.lastSourceMap()
        // `lastFileCoverage()` is the instrumenter's own object; the record is read-only data.
        const coverage = instrumenter.lastFileCoverage() as unknown as IstanbulFileCoverageData
        return {
          code: instrumented,
          map: map === null || map === undefined ? null : toSourceMap(map),
          coverage,
        }
      } catch (cause) {
        if (cause instanceof CoverageError) throw cause
        throw new CoverageError(
          'COVERAGE_INSTRUMENT_FAILED',
          `could not instrument ${filename}: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        )
      }
    },
  }
}
