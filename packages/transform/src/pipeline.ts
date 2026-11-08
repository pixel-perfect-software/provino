// T3.5: the per-file pipeline (Track 3 R1). Route by extension, TS/JSX through
// `oxc-transform.transformSync` with tsconfig-derived options, the hoist hook point, map
// composition, then the record's import facts from one oxc-parser parse. Sync only: the async oxc
// API would use libuv threads inside our own worker pool.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { findPackageJSON } from 'node:module'
import { dirname } from 'node:path'
import type {
  HoistPolicy,
  Pipeline,
  SourceMapV3,
  StaticMockCall,
  TransformDiagnostic,
  TransformRecord,
  TransformRequest,
} from '@provino/types'
import { type JsxOptions, type OxcError, type TransformOptions, transformSync } from 'oxc-transform'
import { TransformError } from './errors.ts'
import { hoistMocks } from './hoist/index.ts'
import { moduleFacts } from './internal/imports.ts'
import { composeMaps, toSourceMapV3 } from './internal/maps.ts'
import { positionOf } from './internal/position.ts'
import {
  createTsconfigFinder,
  type EmitOptions,
  type LoadedConfig,
  loadEmitOptions,
} from './internal/tsconfig.ts'

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
 * Options for `createPipeline`. Later tasks add the Jest transformer host (T3.8), the Vite plugin
 * host (T3.9), barrel trimming (T3.11), the decorator fallback (T3.10) and the cache (T3.6).
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
  /** The transform cache arrives with T3.6. */
  readonly cache: false
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

/** A stable serialization for fingerprints: regexps as their source, sets sorted. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof RegExp) return v.toString()
    if (v instanceof Set) return [...v].map(String).sort()
    return v
  })
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

  const fingerprint = createHash('sha256')
    .update(
      stableJson({
        transform: ownVersion(),
        oxcTransform: packageVersion('oxc-transform'),
        oxcParser: packageVersion('oxc-parser'),
        typescript: options.typescript,
        tsconfig: options.tsconfig,
        jsx: options.jsx ?? null,
        define: options.define ?? null,
        hoist: options.hoist,
      }),
    )
    .digest('hex')

  function transform(request: TransformRequest): TransformRecord {
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
    const emit = config.emit
    const oxc = oxcOptions(found, emit)
    const runOxc = found.lang !== 'js' || options.define !== undefined

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

    let staticMocks: readonly StaticMockCall[] = []
    // Real Jest hoists in every file its transformer touches, and Vitest's plugin does the same, so
    // the gate is "not a dependency", not "a test or setup file" (B13b Gap 3).
    let lateDeps: readonly string[] = []
    if (options.hoist !== null && request.role !== 'dependency') {
      const hoisted = hoistMocks(code, options.hoist, { filename, original: source })
      code = hoisted.code
      maps.push(hoisted.map)
      staticMocks = hoisted.staticMocks
      lateDeps = hoisted.lateDeps
      diagnostics.push(...hoisted.diagnostics)
    }

    const facts = moduleFacts(filename, source, found.lang, found.sourceType)
    const format =
      found.sourceType === 'commonjs'
        ? 'cjs'
        : facts.hasModuleSyntax || /\.m[jt]s$/.test(filename)
          ? 'esm'
          : 'unknown'
    const cacheKey = createHash('sha256')
      .update(fingerprint)
      .update('\0')
      .update(filename)
      .update('\0')
      .update(stableJson(oxc))
      .update('\0')
      .update(request.role)
      .update(request.instrument ? '\0i\0' : '\0-\0')
      .update(source)
      .digest('hex')

    return {
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
    }
  }

  return {
    transform,
    transformAsync: async (request) => transform(request),
    fingerprint,
  }
}
