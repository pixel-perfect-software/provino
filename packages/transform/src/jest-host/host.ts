// T3.8: the Jest transformer host. It loads the transformers a project names (Jest's `transform`
// entries) and calls them as `@jest/transform`'s ScriptTransformer does (jest-transform 30.5,
// `ScriptTransformer.ts`): the first rule whose pattern matches the file picks the transformer,
// `transformIgnorePatterns` (joined with `|`) opts a file out, `getCacheKey(Async)` and
// `process(Async)` get the same options, and the result is `{ code, map }`.
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type {
  JestRawSourceMap,
  JestTransformedSource,
  JestTransformer,
  JestTransformOptions,
  JsonValue,
  SerializedTransformConfig,
  SourceMapV3,
  TransformRequest,
} from '@provino/types'
import { TransformError } from '../errors.ts'
import { toSourceMapV3 } from '../internal/maps.ts'

/**
 * What a hosted transformer produced for one file.
 * @public
 */
export interface HostedSource {
  readonly code: string
  /** The map the transformer gave, or the one inlined in its code; `null` for neither. */
  readonly map: SourceMapV3 | null
  /**
   * The transformer's own `getCacheKey` result for this file, or `null` when it has none (Jest then
   * keys on the content). T3.6's fingerprint takes it: it covers what the transformer's output
   * depends on besides the file's text.
   */
  readonly transformerCacheKey: string | null
}

/**
 * The project's user transformers, loaded.
 * @public
 */
export interface JestHost {
  /** Whether a rule matches `filename` and no ignore pattern does: the file goes to a transformer. */
  handles(filename: string): boolean
  /**
   * Jest's sync `transformSource`: `process`; a transformer with only `processAsync` throws.
   * `cacheKey` is the result of `cacheKey(request)` when the caller already asked (a pipeline with
   * a cache does, before it looks an entry up), so `getCacheKey` runs once per file.
   */
  transform(request: TransformRequest, cacheKey?: string | null): HostedSource
  /** Jest's `transformSourceAsync`: `processAsync` when there is one, else `process`. */
  transformAsync(request: TransformRequest, cacheKey?: string | null): Promise<HostedSource>
  /** The transformer's `getCacheKey` for `request`, or `null` (none, or no rule matches). */
  cacheKey(request: TransformRequest): string | null
  /** `getCacheKeyAsync` when the transformer has it, else `getCacheKey`. */
  cacheKeyAsync(request: TransformRequest): Promise<string | null>
  /**
   * A hash of everything about the setup besides a file: each rule's pattern, transformer path and
   * options, the ignore patterns and the project config.
   */
  readonly fingerprint: string
  /** `SerializedTransformConfig.hoistedMarkers`. */
  readonly hoistedMarkers: readonly string[]
}

interface LoadedRule {
  readonly pattern: RegExp
  readonly path: string
  readonly options: JsonValue
  readonly transformer: JestTransformer
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasFunction(value: unknown, key: string): boolean {
  return isRecord(value) && typeof value[key] === 'function'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Where a rule's `transformer.module` is on disk, for messages and the cache fingerprint. */
function locationOf(module: string): string {
  return module.startsWith('file:') ? fileURLToPath(module) : module
}

/**
 * Jest's `requireOrImportModule` with its default interop: an ES module's `default`, else
 * `module.exports`; an ES module with only a named `createTransformer` is used as it is.
 */
function unwrap(namespace: Record<string, unknown>): unknown {
  let exported: unknown = 'default' in namespace ? namespace.default : namespace
  if (isRecord(exported) && exported.__esModule === true && 'default' in exported) {
    exported = exported.default
  }
  if (!hasFunction(exported, 'createTransformer') && hasFunction(namespace, 'createTransformer')) {
    return namespace
  }
  return exported
}

function invalidTransformer(path: string): TransformError {
  return new TransformError(
    'TRANSFORM_TRANSFORMER_INVALID',
    `Jest: a transformer's \`process\` function must be defined, and it must be a function or a module with a \`createTransformer\` function (\`${path}\`).`,
  )
}

async function loadRule(rule: SerializedTransformConfig['rules'][number]): Promise<LoadedRule> {
  const path = locationOf(rule.transformer.module)
  const url = rule.transformer.module.startsWith('file:')
    ? rule.transformer.module
    : pathToFileURL(rule.transformer.module).href
  let namespace: Record<string, unknown>
  try {
    namespace = await import(url)
  } catch (cause) {
    throw new TransformError(
      'TRANSFORM_TRANSFORMER_LOAD_FAILED',
      `Jest: could not load the transformer \`${path}\`: ${messageOf(cause)}`,
      { cause },
    )
  }
  let loaded = unwrap(namespace)
  if (loaded === null || loaded === undefined) throw invalidTransformer(path)
  if (hasFunction(loaded, 'createTransformer')) {
    try {
      // `loaded` has the factory (checked above); the call is the host's one escape from types.
      loaded = await (loaded as { createTransformer(config: unknown): unknown }).createTransformer(
        rule.options,
      )
    } catch (cause) {
      throw new TransformError(
        'TRANSFORM_TRANSFORMER_LOAD_FAILED',
        `Jest: \`createTransformer\` of \`${path}\` threw: ${messageOf(cause)}`,
        { cause },
      )
    }
  }
  if (!hasFunction(loaded, 'process') && !hasFunction(loaded, 'processAsync')) {
    throw invalidTransformer(path)
  }
  return {
    pattern: new RegExp(rule.pattern),
    path,
    options: rule.options,
    transformer: loaded as JestTransformer,
  }
}

const INLINE_MAP = /\/\/[#@] sourceMappingURL=data:application\/json[^,]*?(;base64)?,([^\s'"]+)\s*$/

/** The map a transformer inlined at the end of its code (Jest reads it with `convert-source-map`). */
function inlineMap(code: string): SourceMapV3 | null {
  const found = INLINE_MAP.exec(code)
  if (found === null) return null
  try {
    const text =
      found[1] === undefined
        ? decodeURIComponent(found[2] ?? '')
        : Buffer.from(found[2] ?? '', 'base64').toString('utf8')
    return mapFrom(JSON.parse(text))
  } catch {
    return null
  }
}

function mapFrom(value: unknown): SourceMapV3 | null {
  if (!isRecord(value) || !Array.isArray(value.sources) || typeof value.mappings !== 'string') {
    return null
  }
  const raw: JestRawSourceMap = {
    version: 3,
    sources: value.sources as string[],
    names: Array.isArray(value.names) ? (value.names as string[]) : [],
    mappings: value.mappings,
    ...(typeof value.file === 'string' ? { file: value.file } : {}),
    ...(typeof value.sourceRoot === 'string' ? { sourceRoot: value.sourceRoot } : {}),
    ...(Array.isArray(value.sourcesContent)
      ? { sourcesContent: value.sourcesContent as (string | null)[] }
      : {}),
  }
  return toSourceMapV3(raw)
}

/** A transformer's `map` (an object, or its JSON text), else the one in the code. */
function mapOf(processed: JestTransformedSource): SourceMapV3 | null {
  const { map } = processed
  if (map !== null && map !== undefined && map !== '') {
    if (typeof map === 'string') {
      try {
        return mapFrom(JSON.parse(map))
      } catch {
        return null
      }
    }
    return mapFrom(map)
  }
  return inlineMap(processed.code)
}

function realpathOf(filename: string): string {
  try {
    return realpathSync(filename)
  } catch {
    return filename
  }
}

function invalidReturn(path: string): TransformError {
  return new TransformError(
    'TRANSFORM_TRANSFORMER_INVALID',
    `Jest: a transform's \`process\` must return a string, or an object with a \`code\` key containing a string. Check the transformer at \`${path}\`.`,
  )
}

/**
 * Loads the transformers of `config.rules`, in the worker, from their own paths: the transformer
 * is the project's (its `node_modules`, its version), and this package takes no dependency on it.
 * `createTransformer` runs once per rule with the rule's options.
 * @public
 */
export async function createJestHost(config: SerializedTransformConfig): Promise<JestHost> {
  const rules = await Promise.all(config.rules.map(loadRule))
  const ignore =
    config.ignorePatterns.length === 0 ? null : new RegExp(config.ignorePatterns.join('|'))
  const configString = JSON.stringify(config.config, (_key, value: unknown) =>
    isRecord(value) && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
      : value,
  )
  const cacheFS = new Map<string, string>()
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        rules: rules.map((rule) => [rule.pattern.source, rule.path, rule.options]),
        ignore: config.ignorePatterns,
        config: configString,
        hoistedMarkers: config.hoistedMarkers,
      }),
    )
    .digest('hex')

  function ruleFor(filename: string): LoadedRule | undefined {
    return rules.find((rule) => rule.pattern.test(filename))
  }

  function handles(filename: string): boolean {
    const path = realpathOf(filename)
    if (ignore?.test(path) === true) return false
    return ruleFor(path) !== undefined
  }

  // Jest's CommonJS path: nothing ESM-only is offered to a transformer (jest-runtime L82-L85).
  function optionsFor(rule: LoadedRule, instrument: boolean): JestTransformOptions {
    return {
      cacheFS,
      config: config.config as unknown as JestTransformOptions['config'],
      configString,
      transformerConfig: rule.options,
      instrument,
      supportsDynamicImport: false,
      supportsExportNamespaceFrom: false,
      supportsStaticESM: false,
      supportsTopLevelAwait: false,
    }
  }

  function pick(request: TransformRequest): { rule: LoadedRule; filename: string } {
    const filename = realpathOf(request.filename)
    const rule = ruleFor(filename)
    if (rule === undefined || ignore?.test(filename) === true) {
      throw new TransformError(
        'TRANSFORM_UNSUPPORTED_FILE',
        `no Jest transformer handles ${request.filename}`,
      )
    }
    return { rule, filename }
  }

  function finish(
    rule: LoadedRule,
    processed: unknown,
    transformerCacheKey: string | null,
  ): HostedSource {
    if (!isRecord(processed) || typeof processed.code !== 'string') {
      throw invalidReturn(rule.path)
    }
    const source = processed as unknown as JestTransformedSource
    return { code: source.code, map: mapOf(source), transformerCacheKey }
  }

  function cacheKey(request: TransformRequest): string | null {
    const { rule, filename } = pick(request)
    const { transformer } = rule
    if (typeof transformer.getCacheKey !== 'function') return null
    return transformer.getCacheKey(request.source, filename, optionsFor(rule, request.instrument))
  }

  async function cacheKeyAsync(request: TransformRequest): Promise<string | null> {
    const { rule, filename } = pick(request)
    const { transformer } = rule
    const get = transformer.getCacheKeyAsync ?? transformer.getCacheKey
    if (typeof get !== 'function') return null
    return await get(request.source, filename, optionsFor(rule, request.instrument))
  }

  return {
    handles,
    fingerprint,
    hoistedMarkers: config.hoistedMarkers,
    cacheKey,
    cacheKeyAsync,
    transform(request, knownKey) {
      const { rule, filename } = pick(request)
      const { transformer } = rule
      if (typeof transformer.process !== 'function') {
        throw new TransformError(
          'TRANSFORM_TRANSFORMER_INVALID',
          `Jest: the transformer at \`${rule.path}\` has only \`processAsync\`, and ${request.filename} is loaded synchronously. Provino loads a CommonJS file with \`require\`, which cannot wait for it.`,
        )
      }
      const options = optionsFor(rule, request.instrument)
      const key = knownKey === undefined ? cacheKey(request) : knownKey
      return finish(rule, transformer.process(request.source, filename, options), key)
    },
    async transformAsync(request, knownKey) {
      const { rule, filename } = pick(request)
      const { transformer } = rule
      const process = transformer.processAsync ?? transformer.process
      if (typeof process !== 'function') throw invalidTransformer(rule.path)
      const options = optionsFor(rule, request.instrument)
      const key = knownKey === undefined ? await cacheKeyAsync(request) : knownKey
      return finish(rule, await process(request.source, filename, options), key)
    },
  }
}
