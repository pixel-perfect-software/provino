// T3.5: the per-file pipeline (Track 3 R1). Route by extension, TS/JSX through
// `oxc-transform.transformSync` with tsconfig-derived options, the hoist hook point, map
// composition, then the record's import facts from one oxc-parser parse. Sync only: the async oxc
// API would use libuv threads inside our own worker pool.
import { readFileSync } from 'node:fs'
import { findPackageJSON } from 'node:module'
import { dirname } from 'node:path'
import type {
  CoverageInstrumenter,
  HoistPolicy,
  Pipeline,
  SourceMapV3,
  StaticMockCall,
  TransformDiagnostic,
  TransformRecord,
  TransformRequest,
} from '@provino/types'
import { type JsxOptions, type OxcError, type TransformOptions, transformSync } from 'oxc-transform'
import { ownCodeIdentity } from './cache/code-identity.ts'
import { hashParts, pipelineFingerprint, stableJson } from './cache/fingerprint.ts'
import { createTransformCache } from './cache/store.ts'
import { TransformError } from './errors.ts'
import { hoistMocks } from './hoist/index.ts'
import { formatOf, moduleFacts } from './internal/imports.ts'
import { composeMaps, toSourceMapV3 } from './internal/maps.ts'
import { positionOf } from './internal/position.ts'
import {
  createTsconfigFinder,
  type EmitOptions,
  type LoadedConfig,
  loadEmitOptions,
} from './internal/tsconfig.ts'
import type { HostedSource, JestHost } from './jest-host/index.ts'
import { usesModuleRunnerForm } from './module-runner.ts'
import { rewriteModule } from './runner/apply.ts'

/**
 * JSX settings that override the tsconfig's.
 * @public
 */
export interface PipelineJsxOptions {
  readonly runtime: 'automatic' | 'classic'
  readonly importSource?: string
  /** Default `true`: tests get `jsxDEV` with file, line and column. */
  readonly development?: boolean
}

/**
 * Options for `createPipeline`. Later tasks add the Vite plugin host (T3.9), barrel trimming
 * (T3.11) and the decorator fallback (T3.10).
 * @public
 */
export interface PipelineOptions {
  readonly root: string
  /** How TypeScript is stripped. Only `oxc` is implemented; `node-strip` is T3.10. */
  readonly typescript: 'oxc' | 'node-strip' | 'off'
  /** `auto`: the nearest tsconfig.json; a path: that file; `false`: none. */
  readonly tsconfig: 'auto' | false | string
  readonly jsx?: PipelineJsxOptions
  /** Global replacements (`process.env.NODE_ENV` → `"test"`). */
  readonly define?: Readonly<Record<string, string>>
  /** The dialect's hoist policy, or `null` to skip hoisting. */
  readonly hoist: HoistPolicy | null
  /**
   * The transform cache (T3.6): a record is read from `dir` before any work and written after it.
   * `false`: none (`--no-cache`).
   */
  readonly cache: false | { readonly dir: string }
  /**
   * `transformCodeIdentity()`, when the caller already has it: the pipeline otherwise hashes this
   * package's code itself, once per process.
   */
  readonly codeIdentity?: string
  /**
   * The project's user transformers (T3.8, `createJestHost`). A file one of its rules matches goes
   * through the transformer instead of Oxc; every other file takes the Oxc path.
   */
  readonly transformers?: JestHost
  /**
   * Also make each ES module's module-runner form (`TransformRecord.runner`) and keep it in the
   * cache, so a warm run skips that step. The loader sets it; the strip-only benches don't.
   */
  readonly runnerForm?: boolean
  /**
   * Declared for B23b's Istanbul instrumenter, which will run after TypeScript is stripped and
   * before the hoister and the module-runner rewrite. Nothing reads it yet: a request with
   * `instrument: true` is still refused with `TRANSFORM_OPTION_UNSUPPORTED` until the instrumenter
   * is wired.
   */
  readonly instrumenter?: CoverageInstrumenter
}

/**
 * The signature of `createPipeline`.
 * @public
 */
export type CreatePipeline = (options: PipelineOptions) => Pipeline

type Lang = 'js' | 'jsx' | 'ts' | 'tsx' | 'dts'
type SourceType = 'module' | 'commonjs' | 'unambiguous'

interface Route {
  readonly lang: Lang
  readonly sourceType: SourceType
}

function route(filename: string): Route | null {
  if (/\.d\.[cm]?ts$/.test(filename)) return { lang: 'dts', sourceType: 'module' }
  const ext = /\.[cm]?[jt]sx?$/.exec(filename)?.[0]
  switch (ext) {
    case '.ts':
    case '.mts':
      return { lang: 'ts', sourceType: 'module' }
    case '.cts':
      return { lang: 'ts', sourceType: 'commonjs' }
    case '.tsx':
      return { lang: 'tsx', sourceType: 'module' }
    case '.jsx':
      return { lang: 'jsx', sourceType: 'module' }
    case '.js':
      return { lang: 'js', sourceType: 'unambiguous' }
    case '.mjs':
      return { lang: 'js', sourceType: 'module' }
    case '.cjs':
      return { lang: 'js', sourceType: 'commonjs' }
    default:
      return null
  }
}

function packageVersion(specifier: string): string {
  const path = findPackageJSON(specifier, import.meta.url)
  if (path === undefined) return 'unknown'
  const pkg: { readonly version?: unknown } = JSON.parse(readFileSync(path, 'utf8'))
  return typeof pkg.version === 'string' ? pkg.version : 'unknown'
}

function ownVersion(): string {
  const pkg: { readonly version?: unknown } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  )
  return typeof pkg.version === 'string' ? pkg.version : 'unknown'
}

const PRE_ES2022 = /^es(?:3|5|201[5-9]|202[01])$/i

/** TypeScript's `useDefineForClassFields`: its default follows `target` (TS 6+ defaults to the latest). */
function useDefineForClassFields(emit: EmitOptions): boolean {
  if (emit.useDefineForClassFields !== undefined) return emit.useDefineForClassFields
  return emit.target === undefined || !PRE_ES2022.test(emit.target)
}

function jsxOptions(emit: EmitOptions, override: PipelineJsxOptions | undefined): JsxOptions {
  if (override !== undefined) {
    return {
      runtime: override.runtime,
      development: override.development ?? true,
      ...(override.importSource === undefined ? {} : { importSource: override.importSource }),
    }
  }
  if (emit.jsx?.toLowerCase() === 'react') {
    return {
      runtime: 'classic',
      development: true,
      ...(emit.jsxFactory === undefined ? {} : { pragma: emit.jsxFactory }),
      ...(emit.jsxFragmentFactory === undefined ? {} : { pragmaFrag: emit.jsxFragmentFactory }),
    }
  }
  return {
    runtime: 'automatic',
    development: true,
    ...(emit.jsxImportSource === undefined ? {} : { importSource: emit.jsxImportSource }),
  }
}

function diagnostic(source: string, error: OxcError): TransformDiagnostic {
  const label = error.labels[0]
  return {
    severity: String(error.severity) === 'Error' ? 'error' : 'warning',
    code: 'PARSE_ERROR',
    message: error.message,
    ...(label === undefined ? {} : { loc: positionOf(source, label.start) }),
    ...(error.codeframe === null ? {} : { codeFrame: error.codeframe }),
  }
}

/**
 * A hash of this package's own code, computed once per process. It is part of every cache entry's
 * key, so a coordinator computes it and passes it on (`PipelineOptions.codeIdentity`) rather than
 * having every worker read the package again.
 * @public
 */
export function transformCodeIdentity(): string {
  return ownCodeIdentity(new URL('./', import.meta.url))
}

/**
 * Creates the transform pipeline.
 * @public
 */
export const createPipeline: CreatePipeline = (options) => {
  if (options.typescript !== 'oxc') {
    throw new TransformError(
      'TRANSFORM_OPTION_UNSUPPORTED',
      `typescript: '${options.typescript}' is not supported yet (only 'oxc'; 'node-strip' is T3.10).`,
    )
  }
  const findTsconfig = createTsconfigFinder()
  const configs = new Map<string, LoadedConfig>()
  const NO_CONFIG: LoadedConfig = { emit: {}, missing: [] }

  function configFor(filename: string): LoadedConfig {
    const mode = options.tsconfig
    if (mode === false) return NO_CONFIG
    const path = mode === 'auto' ? findTsconfig(dirname(filename)) : mode
    if (path === null) return NO_CONFIG
    let config = configs.get(path)
    if (config === undefined) {
      config = loadEmitOptions(path)
      configs.set(path, config)
    }
    return config
  }

  function oxcOptions(found: Route, emit: EmitOptions): TransformOptions {
    const define = useDefineForClassFields(emit)
    return {
      lang: found.lang,
      sourceType: found.sourceType,
      target: 'esnext',
      sourcemap: true,
      jsx: jsxOptions(emit, options.jsx),
      typescript: {
        onlyRemoveTypeImports: emit.verbatimModuleSyntax === true,
        ...(define ? {} : { removeClassFieldsWithoutInitializer: true }),
      },
      ...(define ? {} : { assumptions: { setPublicClassFields: true } }),
      ...(emit.experimentalDecorators === true
        ? {
            decorator: { legacy: true, emitDecoratorMetadata: emit.emitDecoratorMetadata === true },
          }
        : {}),
      ...(options.define === undefined ? {} : { define: { ...options.define } }),
    }
  }

  // The options for a route and a config, and their text for the key: both are the same for every
  // file that shares them, and a warm run pays for the text on every file.
  const oxcMemo = new Map<LoadedConfig, Map<string, { oxc: TransformOptions; text: string }>>()
  function oxcFor(found: Route, config: LoadedConfig): { oxc: TransformOptions; text: string } {
    let byRoute = oxcMemo.get(config)
    if (byRoute === undefined) {
      byRoute = new Map()
      oxcMemo.set(config, byRoute)
    }
    const routeKey = `${found.lang}:${found.sourceType}`
    let entry = byRoute.get(routeKey)
    if (entry === undefined) {
      const oxc = oxcOptions(found, config.emit)
      // A tsconfig `extends` that can't be found changes what the options are once it can.
      entry = { oxc, text: stableJson([oxc, config.missing]) }
      byRoute.set(routeKey, entry)
    }
    return entry
  }

  const fingerprint = pipelineFingerprint({
    versions: {
      transform: ownVersion(),
      code: options.codeIdentity ?? transformCodeIdentity(),
      oxcTransform: packageVersion('oxc-transform'),
      oxcParser: packageVersion('oxc-parser'),
    },
    typescript: options.typescript,
    nodeVersion: process.version,
    tsconfig: options.tsconfig,
    jsx: options.jsx,
    define: options.define,
    hoist: options.hoist,
    transformers: options.transformers?.fingerprint ?? null,
    runnerForm: options.runnerForm === true,
  })
  const cache = options.cache === false ? undefined : createTransformCache(options.cache.dir)

  /**
   * The entry key of a hosted file: the pipeline, the file, its role and the transformer's own key
   * (without one, as in Jest, the content).
   */
  function hostedKey(request: TransformRequest, transformerKey: string | null): string {
    return hashParts([
      fingerprint,
      request.filename,
      request.role,
      request.instrument ? 'instrument' : 'plain',
      transformerKey === null ? 'content' : 'transformer',
      transformerKey ?? request.source,
    ])
  }

  /**
   * Hoists the `mock` calls of `code` (when the policy hoists and the file is not a dependency),
   * adding the hoister's map and diagnostics to the step lists. Real Jest hoists in every file its
   * transformer touches, and Vitest's plugin does the same, so the gate is "not a dependency", not
   * "a test or setup file" (B13b Gap 3).
   */
  function applyHoist(
    code: string,
    request: TransformRequest,
    original: string,
    maps: (SourceMapV3 | null)[],
    diagnostics: TransformDiagnostic[],
  ): { code: string; staticMocks: readonly StaticMockCall[]; lateDeps: readonly string[] } {
    if (options.hoist === null || request.role === 'dependency') {
      return { code, staticMocks: [], lateDeps: [] }
    }
    const hoisted = hoistMocks(code, options.hoist, { filename: request.filename, original })
    maps.push(hoisted.map)
    diagnostics.push(...hoisted.diagnostics)
    return { code: hoisted.code, staticMocks: hoisted.staticMocks, lateDeps: hoisted.lateDeps }
  }

  /**
   * The record for a file a user transformer produced (T3.8). The output is what Jest would run
   * (CommonJS: `supportsStaticESM` is false), so the format comes from its own syntax. Our hoister
   * runs on it unless the output carries one of the host's markers: a transformer that hoisted
   * leaves nothing to move, so the calls stay once, in the order it wrote them.
   */
  function hostedRecord(
    request: TransformRequest,
    host: JestHost,
    source: HostedSource,
    cacheKey: string,
  ) {
    const { filename } = request
    const maps: (SourceMapV3 | null)[] = [source.map]
    const diagnostics: TransformDiagnostic[] = []
    const alreadyHoisted = host.hoistedMarkers.some((marker) => source.code.includes(marker))
    const { code, staticMocks, lateDeps } = alreadyHoisted
      ? { code: source.code, staticMocks: [], lateDeps: [] }
      : applyHoist(source.code, request, request.source, maps, diagnostics)
    const lang = /\.[cm]?[jt]sx$/.test(filename) ? 'jsx' : 'js'
    const facts = moduleFacts(filename, code, lang, 'unambiguous')
    const format = formatOf(facts, false)
    return {
      code,
      // Maps compose to the original source only when the transformer gave one.
      map: source.map === null ? null : composeMaps(maps),
      format,
      imports: facts.imports,
      staticMocks,
      hasTopLevelAwait: facts.hasTopLevelAwait,
      lateDeps,
      diagnostics,
      cacheKey,
      fromCache: false,
    } satisfies TransformRecord
  }

  /** A transformer that throws is a `TRANSFORMER_FAILED` error on the record, as for a parse error. */
  function failedRecord(error: unknown): TransformRecord {
    return {
      code: '',
      map: null,
      format: 'unknown',
      imports: [],
      staticMocks: [],
      hasTopLevelAwait: false,
      lateDeps: [],
      diagnostics: [
        {
          severity: 'error',
          code: 'TRANSFORMER_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      cacheKey: '',
      fromCache: false,
    }
  }

  /**
   * Stores a record that came from work, and returns it. With `runnerForm`, an ES module's
   * module-runner form is made first, so it is stored and a warm run doesn't make it again.
   */
  function stored(key: string, filename: string, record: TransformRecord): TransformRecord {
    let result = record
    if (
      options.runnerForm === true &&
      !record.diagnostics.some((diagnostic) => diagnostic.severity === 'error') &&
      usesModuleRunnerForm(record)
    ) {
      try {
        result = { ...record, runner: rewriteModule(filename, record.code) }
      } catch {
        // No form is kept: the failure surfaces, named, when the loader calls `toModuleRunner`.
      }
    }
    cache?.set(key, result)
    return result
  }

  function transform(request: TransformRequest): TransformRecord {
    const host = options.transformers
    if (host?.handles(request.filename) === true) {
      try {
        const transformerKey = host.cacheKey(request)
        const key = hostedKey(request, transformerKey)
        const hit = cache?.get(key)
        if (hit !== undefined) return hit
        const source = host.transform(request, transformerKey)
        return stored(key, request.filename, hostedRecord(request, host, source, key))
      } catch (error) {
        return failedRecord(error)
      }
    }
    return transformOxc(request)
  }

  function transformOxc(request: TransformRequest): TransformRecord {
    const found = route(request.filename)
    if (found === null) {
      throw new TransformError(
        'TRANSFORM_UNSUPPORTED_FILE',
        `no transform handles ${request.filename}`,
      )
    }
    if (request.instrument) {
      throw new TransformError(
        'TRANSFORM_OPTION_UNSUPPORTED',
        'coverage instrumentation is not supported yet (U6, with Track 8).',
      )
    }
    const { filename, source } = request
    const config = found.lang === 'js' ? NO_CONFIG : configFor(filename)
    const { oxc, text: oxcText } = oxcFor(found, config)
    const runOxc = found.lang !== 'js' || options.define !== undefined
    const cacheKey = hashParts([
      fingerprint,
      filename,
      oxcText,
      request.role,
      request.instrument ? 'instrument' : 'plain',
      source,
    ])
    const hit = cache?.get(cacheKey)
    if (hit !== undefined) return hit

    let code = source
    const maps: (SourceMapV3 | null)[] = []
    const diagnostics: TransformDiagnostic[] = config.missing.map((message) => ({
      severity: 'warning',
      code: 'TSCONFIG_EXTENDS_NOT_FOUND',
      message,
    }))
    if (runOxc) {
      const result = transformSync(filename, source, oxc)
      code = result.code
      maps.push(result.map === undefined ? null : toSourceMapV3(result.map))
      for (const error of result.errors) diagnostics.push(diagnostic(source, error))
    }

    const hoisted = applyHoist(code, request, source, maps, diagnostics)
    code = hoisted.code
    const { staticMocks, lateDeps } = hoisted

    const facts = moduleFacts(filename, source, found.lang, found.sourceType)
    const format =
      found.sourceType === 'commonjs' ? 'cjs' : formatOf(facts, /\.m[jt]s$/.test(filename))
    return stored(cacheKey, filename, {
      code,
      map: composeMaps(maps),
      format,
      imports: facts.imports,
      staticMocks,
      // `moduleFacts` reads the original source. The `await`s of rewritten imports are not the
      // module's own top-level await: they are late dependencies the loader can load either way (D38).
      hasTopLevelAwait: facts.hasTopLevelAwait,
      lateDeps,
      diagnostics,
      cacheKey,
      fromCache: false,
    })
  }

  return {
    transform,
    transformAsync: async (request) => {
      const host = options.transformers
      if (host?.handles(request.filename) === true) {
        try {
          const transformerKey = await host.cacheKeyAsync(request)
          const key = hostedKey(request, transformerKey)
          const hit = cache?.get(key)
          if (hit !== undefined) return hit
          const source = await host.transformAsync(request, transformerKey)
          return stored(key, request.filename, hostedRecord(request, host, source, key))
        } catch (error) {
          return failedRecord(error)
        }
      }
      return transformOxc(request)
    },
    fingerprint,
  }
}
