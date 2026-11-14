// T8.12: a run's V8 coverage as Istanbul data, as Jest's CoverageReporter makes it under
// `coverageProvider: 'v8'` (`_getCoverageResult`): every take merged with `@bcoe/v8-coverage`'s
// `mergeProcessCovs`, then each script through `v8-to-istanbul` with the code V8 counted, the map
// back to the source and the source from disk, whole (D123: Jest's documented babel-jest with
// `@babel/preset-typescript` hands it the TypeScript text, trailing types included). A file no test loaded is Jest's `(empty-report)`
// range over the file's size in bytes (`generateEmptyCoverage`). Only under `v8Conversion:
// 'v8-to-istanbul'`; the AST converter is B25's.
//
// Jest passes `wrapperLength` 0, because jest-runtime compiles a module with `compileFunction`,
// whose offsets are the code's own. A worker here compiles the module-runner wrapper with the code
// on its first line (T2.9), so the offsets are shifted by the wrapper's length, which goes to
// `v8-to-istanbul` instead: the ranges it reads are the code's own again. What the wrapper opens
// counts only as the module's own function (`moduleBlocks`).
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type FunctionCov, mergeProcessCovs, type ScriptCov } from '@bcoe/v8-coverage'
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
  /** The policy's `coverage.v8Hashbang`: what the counted code kept of a hashbang line. */
  readonly hashbang: CoveragePolicy['v8Hashbang']
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

/** `map` as `v8-to-istanbul` reads it (its own copy), without the `sourcesContent` it would read first. */
function sourceMapInput(map: SourceMapV3) {
  return {
    version: map.version,
    ...(map.sourceRoot === undefined ? {} : { sourceRoot: map.sourceRoot }),
    sources: [...map.sources],
    names: [...map.names],
    mappings: map.mappings,
  }
}

/** The length of `source`'s hashbang line (`#!` to the line's end), 0 when it has none. */
function hashbangLength(source: string): number {
  if (!source.startsWith('#!')) return 0
  const end = source.indexOf('\n')
  return end === -1 ? source.length : end
}

/**
 * The blocks of a script that are the module's own. The loader compiles a module inside a wrapper
 * (`wrapperLength` characters, T2.9), and V8 reports the script's top level and every function
 * the wrapper opens, each starting inside it. The vm script and the function that takes the
 * module's scope bindings run once per worker, not once per load, and are no part of the module:
 * they are left out. The innermost is the module's function, as jest-runtime's `compileFunction`
 * makes it. It stays when `keepModule`, for code that kept the source's positions, where Jest's
 * counts the file once per load (`coverage/v8-commonjs`): v8-to-istanbul reads its start as the
 * code's, and its end is cut to the code's (`codeEnd`), where Jest's ends, before the wrapper's
 * closing characters. Code with a map loses it, as Jest's does: Jest's begins at the `"use strict"` babel
 * writes, which maps to no source, so v8-to-istanbul drops it, where ours could map to a hashbang.
 */
function moduleBlocks(
  functions: readonly FunctionCov[],
  wrapperLength: number,
  codeEnd: number,
  keepModule: boolean,
): readonly FunctionCov[] {
  const startOf = (fn: FunctionCov): number => fn.ranges[0]?.startOffset ?? 0
  let module: FunctionCov | undefined
  for (const fn of functions) {
    const start = startOf(fn)
    if (start >= wrapperLength) continue
    if (module === undefined || start > startOf(module)) module = fn
  }
  const kept: FunctionCov[] = []
  for (const fn of functions) {
    if (startOf(fn) >= wrapperLength) kept.push(fn)
    else if (keepModule && fn === module) {
      kept.push({
        ...fn,
        ranges: fn.ranges.map((range, index) =>
          index === 0 ? { ...range, endOffset: Math.min(range.endOffset, codeEnd) } : range,
        ),
      })
    }
  }
  return kept
}

/** `functions` with every offset `by` characters earlier (`v8-to-istanbul` clamps at the code's start). */
function shifted(functions: readonly FunctionCov[], by: number): readonly FunctionCov[] {
  return functions.map((fn) => ({
    ...fn,
    ranges: fn.ranges.map((range) => ({
      ...range,
      startOffset: range.startOffset - by,
      endOffset: range.endOffset - by,
    })),
  }))
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
      // A module named without its code (`ExecutedModuleRef`): an earlier take carried it.
      if (!('code' in info)) continue
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
    // The policy's `v8Hashbang`: under `removed` the code V8 counted had no hashbang text, so its
    // offsets sit that many characters before ours, which keep the line as a comment (D7).
    const hashbang = options.hashbang === 'removed' ? hashbangLength(original) : 0
    const mapped = info?.map !== null && info?.map !== undefined
    let functions: readonly FunctionCov[] =
      info === undefined
        ? script.functions
        : moduleBlocks(
            script.functions,
            info.wrapperLength,
            info.wrapperLength + info.code.length,
            !mapped,
          )
    // Without a map v8-to-istanbul reads V8's offsets against the source as it is: under
    // `removed` they are the shorter code's. With a map they go through it, line by line.
    if (hashbang !== 0 && info !== undefined && !mapped) functions = shifted(functions, hashbang)
    const converter =
      info?.map === null || info?.map === undefined
        ? // A file no test loaded, or code that kept the source's positions: the source itself.
          v8ToIstanbul(script.url, info?.wrapperLength ?? 0, { source: original })
        : v8ToIstanbul(script.url, info.wrapperLength, {
            source: info.code,
            // The whole source, as Jest's transform starts from it (D123): v8-to-istanbul makes a
            // statement of each of its lines, types included. Never the map's `sourcesContent`,
            // which v8-to-istanbul reads first: a composed map's copy can be another text.
            originalSource: hashbang === 0 ? original : original.slice(hashbang),
            // Jest's `{ file: res.url, ...map }`.
            sourceMap: {
              sourcemap: {
                ...sourceMapInput(info.map),
                file: script.url,
              },
            },
          })
    await converter.load()
    converter.applyCoverage([...functions])
    map.merge(converter.toIstanbul())
  }
  // Jest's v8 report context reads every source from disk: no text to carry.
  return { map, sources: {} }
}
