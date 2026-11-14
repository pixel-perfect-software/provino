// T8.12: a run's V8 coverage as Istanbul data, as Jest's CoverageReporter makes it under
// `coverageProvider: 'v8'` (`_getCoverageResult`): every take merged with `@bcoe/v8-coverage`'s
// `mergeProcessCovs`, then each script through `v8-to-istanbul` with the code V8 counted, the map
// back to the source and the source from disk. A file no test loaded is Jest's `(empty-report)`
// range over the file's size in bytes (`generateEmptyCoverage`). Only under `v8Conversion:
// 'v8-to-istanbul'`; the AST converter is B25's.
//
// Jest passes `wrapperLength` 0, because jest-runtime compiles a module with `compileFunction`,
// whose offsets are the code's own. A worker here compiles the module-runner wrapper with the code
// on its first line (T2.9), so the offsets are shifted by the wrapper's length, which goes to
// `v8-to-istanbul` instead: the ranges it reads are the code's own again.
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mergeProcessCovs, type ScriptCov } from '@bcoe/v8-coverage'
import { TraceMap, traceSegment } from '@jridgewell/trace-mapping'
import type {
  CoveragePolicy,
  ExecutedModuleInfo,
  RawCoverage,
  SourceMapV3,
  V8ScriptCoverage,
} from '@provino/types'
import libCoverage from 'istanbul-lib-coverage'
import v8ToIstanbul from 'v8-to-istanbul'
import { CoverageError } from '../errors.ts'
import type { RemappedCoverage } from './remap.ts'

/**
 * One worker's V8 take.
 * @public
 */
export type V8Coverage = Extract<RawCoverage, { readonly kind: 'v8' }>

/**
 * Options of `convertV8Coverage`.
 * @public
 */
export interface V8ConversionOptions {
  /** The policy's `coverage.v8Conversion`: how a script's ranges become Istanbul data. */
  readonly conversion: CoveragePolicy['v8Conversion']
}

/**
 * The coverage of a file no test loaded, as Jest's `generateEmptyCoverage` makes it under the v8
 * provider: one `(empty-report)` range of count 0 from 0 to the file's size in bytes, which
 * `v8-to-istanbul` reads as every line, function and branch of the file not covered.
 * @public
 */
export function emptyV8Coverage(path: string): V8ScriptCoverage {
  return {
    scriptId: '0',
    url: path,
    functions: [
      {
        functionName: '(empty-report)',
        isBlockCoverage: true,
        ranges: [{ startOffset: 0, endOffset: statSync(path).size, count: 0 }],
      },
    ],
  }
}

/** A script's URL as the path V8 counted it under (Jest's `fileURLToPath(res.url)`). */
function pathOf(url: string): string {
  return url.startsWith('file:') ? fileURLToPath(url) : url
}

/** A script as `mergeProcessCovs` takes it (its own copy), under the path V8 counted it. */
function scriptCov(script: V8ScriptCoverage): ScriptCov {
  return {
    scriptId: script.scriptId,
    url: pathOf(script.url),
    functions: script.functions.map((fn) => ({
      functionName: fn.functionName,
      isBlockCoverage: fn.isBlockCoverage,
      ranges: fn.ranges.map((range) => ({ ...range })),
    })),
  }
}

/** `map` as `v8-to-istanbul` reads it (its own copy). */
function sourceMapInput(map: SourceMapV3) {
  return {
    version: map.version,
    ...(map.sourceRoot === undefined ? {} : { sourceRoot: map.sourceRoot }),
    sources: [...map.sources],
    ...(map.sourcesContent === undefined ? {} : { sourcesContent: [...map.sourcesContent] }),
    names: [...map.names],
    mappings: map.mappings,
  }
}

/**
 * `source` as far as the code V8 ran reaches. `v8-to-istanbul` makes a statement of every line of
 * the original it is given, after trimming its end. Jest's original is the text its transform
 * started from (babel's `sourcesContent`; the recorder's transform strips the types first), so a
 * file that ends in an interface has no statements there. Ours is the file on disk, and the code
 * the worker ran is that file with its types blanked in place (D116), so the end is where the
 * code's last character that is not white space came from: found through `map`, and checked to be
 * the same character. When it can't be found, the whole source.
 */
function ranSource(source: string, code: string, map: TraceMap): string {
  const end = code.trimEnd().length
  if (end === 0) return ''
  const before = code.lastIndexOf('\n', end - 1)
  const line = code.slice(0, end).split('\n').length - 1
  const column = end - 1 - (before + 1)
  const segment = traceSegment(map, line, column)
  if (segment === null || segment.length === 1) return source
  const [generated, , sourceLine, sourceColumn] = segment
  let offset = 0
  for (let index = 0; index < sourceLine; index++) {
    const next = source.indexOf('\n', offset)
    if (next === -1) return source
    offset = next + 1
  }
  const last = offset + sourceColumn + (column - generated)
  return source[last] === code[end - 1] ? source.slice(0, last + 1) : source
}

/**
 * Converts every take and every file no test loaded into one coverage map, file by file as Jest
 * does. `untested` are the `emptyV8Coverage` of the files no test loaded. A conversion other than
 * `v8-to-istanbul` is `COVERAGE_NOT_IMPLEMENTED` (B25).
 * @public
 */
export async function convertV8Coverage(
  takes: readonly V8Coverage[],
  untested: readonly V8ScriptCoverage[],
  options: V8ConversionOptions,
): Promise<RemappedCoverage> {
  if (options.conversion !== 'v8-to-istanbul') {
    throw new CoverageError(
      'COVERAGE_NOT_IMPLEMENTED',
      `the '${options.conversion}' conversion of V8 coverage is not built yet (B25)`,
    )
  }
  // The compiled module of each path, from the first take that had it (Jest's first
  // `codeTransformResult` of a URL); every worker transforms a file alike.
  const modules = new Map<string, ExecutedModuleInfo>()
  for (const take of takes) {
    for (const info of take.modules ?? []) {
      const path = pathOf(info.url)
      if (!modules.has(path)) modules.set(path, info)
    }
  }
  const merged = mergeProcessCovs([
    ...takes.map((take) => ({ result: take.scripts.map(scriptCov) })),
    ...untested.map((script) => ({ result: [scriptCov(script)] })),
  ])

  const map = libCoverage.createCoverageMap({})
  for (const script of merged.result) {
    const info = modules.get(script.url)
    const original = readFileSync(script.url, 'utf8')
    const converter =
      info?.map === null || info?.map === undefined
        ? // A file no test loaded, or code that kept the source's positions: the source itself.
          v8ToIstanbul(script.url, info?.wrapperLength ?? 0, { source: original })
        : v8ToIstanbul(script.url, info.wrapperLength, {
            source: info.code,
            originalSource: ranSource(original, info.code, new TraceMap(sourceMapInput(info.map))),
            // Jest's `{ file: res.url, ...map }`.
            sourceMap: {
              sourcemap: {
                ...sourceMapInput(info.map),
                file: script.url,
              },
            },
          })
    await converter.load()
    converter.applyCoverage(script.functions)
    map.merge(converter.toIstanbul())
  }
  // Jest's v8 report context reads every source from disk: no text to carry.
  return { map, sources: {} }
}
