// T11.4: Jest 30.5's config loader, `jest-config` `readConfigFileAndSetRootDir.ts` and
// `readInitialOptions` (`index.ts` L326-L380) rebuilt. A `.json` file may hold comments; a
// `package.json` gives its `jest` key (or `{}`); anything else is imported (`importConfigModule`
// from `@provino/config`, the one config-module loader, build-plan §6), and a function export is
// awaited. TypeScript loads through Node's type stripping (22.18+). When Node can't strip a file,
// Jest falls back to ts-node; Provino uses a TypeScript loader only when the file's
// `@jest-config-loader` docblock names one (gap 12 of `bundles/B14.md`), and otherwise says how to
// fix it. `rootDir` defaults to the file's directory, and a relative one is resolved against it.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, resolve } from 'node:path'
import { ConfigError, importConfigModule } from '@provino/config'
import type { ConfigSource } from '@provino/types'
import { extractDocblock, parsePragmas } from './docblock.ts'
import { JestConfigError, messageOf } from './errors.ts'
import { replaceRootDirInPath } from './paths.ts'
import type { JestInitialOptions } from './types.ts'

/** Whether Node strips TypeScript in this process (`process.features.typescript`, Node 22.18+). */
function nativeTypeScript(): boolean {
  const features: unknown = Reflect.get(process, 'features')
  return typeof features === 'object' && features !== null && !!Reflect.get(features, 'typescript')
}

/**
 * `strip-json-comments` 3 with `whitespace: true`: line and block comments outside strings become
 * spaces (newlines kept). Trailing commas stay, so `JSON.parse` still refuses them, as Jest does.
 */
export function stripJsonComments(text: string): string {
  return stripComments(text).text
}

/**
 * `stripJsonComments`, with where an unclosed block comment starts (strip-json-comments blanks it
 * to the end of the file, so the JSON then fails or not as the rest decides). One pass: each
 * comment's end is found with `indexOf`, and the text between comments is copied in slices.
 */
function stripComments(text: string): { readonly text: string; readonly unclosedAt?: number } {
  const parts: string[] = []
  let copied = 0
  let unclosedAt: number | undefined
  const blank = (from: number, to: number) => {
    parts.push(text.slice(copied, from), text.slice(from, to).replaceAll(/\S/g, ' '))
    copied = to
  }
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '"') {
      index++
      while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1
      index++
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index + 2)
      let stop = newline === -1 ? text.length : newline
      if (text[stop - 1] === '\r' && stop - 1 > index) stop--
      blank(index, stop)
      index = stop
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      if (end === -1) unclosedAt = index
      const stop = end === -1 ? text.length : end + 2
      blank(index, stop)
      index = stop
      continue
    }
    index++
  }
  parts.push(text.slice(copied))
  return { text: parts.join(''), ...(unclosedAt === undefined ? {} : { unclosedAt }) }
}

/** A 1-based `line L, column C` for an offset. */
function lineColumn(text: string, offset: number): string {
  const before = text.slice(0, offset)
  const line = before.split('\n').length
  const column = offset - (before.lastIndexOf('\n') + 1) + 1
  return `line ${line}, column ${column}`
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJsonFile(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (cause) {
    throw new JestConfigError('JEST_CONFIG_LOAD_FAILED', `can't read the config file "${path}"`, {
      cause,
    })
  }
  const stripped = stripComments(text)
  try {
    return JSON.parse(stripped.text)
  } catch (cause) {
    const unclosed =
      stripped.unclosedAt === undefined
        ? ''
        : `; an unclosed /* comment at ${lineColumn(text, stripped.unclosedAt)} runs to the end of the file`
    throw new JestConfigError(
      'JEST_CONFIG_LOAD_FAILED',
      `${messageOf(cause)} while parsing ${path}${unclosed}`,
      { cause },
    )
  }
}

/** The `@jest-config-loader` pragma, as `hasTsLoaderExplicitlyConfigured` reads it (L160-L164). */
function docblockLoader(path: string): {
  readonly loader: string | readonly string[] | undefined
  readonly options: string | readonly string[] | undefined
} {
  const pragmas = parsePragmas(extractDocblock(readFileSync(path, 'utf8')))
  return { loader: pragmas['jest-config-loader'], options: pragmas['jest-config-loader-options'] }
}

function hasExplicitLoader(path: string): boolean {
  const { loader } = docblockLoader(path)
  return typeof loader === 'string' && loader.trim() !== ''
}

/**
 * `loadTSConfigFile` (L171-L203) for a loader the docblock names: `ts-node` or `esbuild-register`,
 * resolved from the config's own directory (Jest resolves it beside itself, which in a project is
 * the same install), registered for one `require` of the file, then turned off.
 */
async function loadWithDocblockLoader(path: string): Promise<unknown> {
  const { loader, options } = docblockLoader(path)
  if (typeof loader !== 'string') {
    throw new JestConfigError(
      'JEST_CONFIG_TS_LOADER',
      // L180-L186
      `Jest: You can only define a single loader through docblocks, got "${(loader ?? []).join(', ')}"`,
    )
  }
  const extra: Readonly<Record<string, unknown>> =
    typeof options === 'string' ? (JSON.parse(options) as Readonly<Record<string, unknown>>) : {}
  const requireFromConfig = createRequire(path)
  let enable: (on: boolean) => void
  try {
    if (loader === 'ts-node') {
      const tsNode = requireFromConfig('ts-node') as {
        register(options: object): { enabled(on: boolean): void }
      }
      const service = tsNode.register({
        compilerOptions: { module: 'CommonJS' },
        moduleTypes: { '**': 'cjs' },
        ...extra,
      })
      enable = (on) => service.enabled(on)
    } else if (loader === 'esbuild-register') {
      const esbuildRegister = requireFromConfig('esbuild-register/dist/node') as {
        register(options: object): { unregister(): void }
      }
      let instance: { unregister(): void } | undefined
      enable = (on) => {
        if (on) {
          instance = esbuildRegister.register({
            target: `node${process.version.slice(1)}`,
            ...extra,
          })
        } else instance?.unregister()
      }
    } else {
      throw new Error(`Jest: '${loader}' is not a valid TypeScript configuration loader.`)
    }
  } catch (cause) {
    if (cause instanceof Error && Reflect.get(cause, 'code') === 'MODULE_NOT_FOUND') {
      throw new JestConfigError(
        'JEST_CONFIG_TS_LOADER',
        // L235-L238
        `Jest: '${loader}' is required for the TypeScript configuration files. Make sure it is installed\nError: ${cause.message}`,
        { cause },
      )
    }
    throw cause
  }
  enable(true)
  try {
    const required: unknown = requireFromConfig(path)
    let value =
      isRecord(required) && required.__esModule === true
        ? Reflect.get(required, 'default')
        : required
    if (typeof value === 'function') value = await value()
    return value
  } finally {
    enable(false)
  }
}

/** The underlying error of a failed `importConfigModule`. */
function importFailure(error: unknown): unknown {
  return error instanceof ConfigError && error.code === 'CONFIG_LOAD_FAILED' ? error.cause : error
}

/**
 * A TypeScript load failure before `readJestConfigFile` wraps it. A plain `Error` by name, so its
 * text in the wrapped message reads `Error: …`, as Jest's does.
 */
class TypeScriptLoadError extends Error {
  readonly needsLoader: boolean
  constructor(message: string, needsLoader: boolean, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.needsLoader = needsLoader
  }
}

const NO_LOADER_HINT =
  "Node's type stripping can't load this file, and Jest would fall back to ts-node. Provino uses a TypeScript loader only when the file's docblock names one: add /** @jest-config-loader ts-node */ (or esbuild-register) at the top, or keep to TypeScript that Node can strip (no enums, namespaces or parameter properties; `import type` for types)."

/** L52-L104. Throws what Jest's inner block throws; `readJestConfigFile` adds Jest's preamble. */
async function loadTypeScript(path: string): Promise<unknown> {
  const isMts = path.endsWith('.mts')
  if (!isMts && !nativeTypeScript()) {
    if (hasExplicitLoader(path)) return loadWithDocblockLoader(path)
    throw new TypeScriptLoadError(
      `This Node can't strip TypeScript (it needs Node 22.18+, or NODE_OPTIONS=--experimental-strip-types). ${NO_LOADER_HINT}`,
      true,
    )
  }
  try {
    return await requireOrImportModule(path)
  } catch (thrown) {
    const error = importFailure(thrown)
    if (isMts) {
      throw new TypeScriptLoadError(
        // L57-L61
        'jest.config.mts requires native TypeScript support. Ensure you are using Node.js 22.18+ or 23.6+.',
        true,
        error,
      )
    }
    const explicit = hasExplicitLoader(path)
    if (!(error instanceof SyntaxError) && !explicit) throw error
    if (!explicit) {
      throw new TypeScriptLoadError(`${String(error)}\n  ${NO_LOADER_HINT}`, true, error)
    }
    try {
      return await loadWithDocblockLoader(path)
    } catch (loaderError) {
      // L74-L80: a string, which the preamble then prints as it is.
      throw new TypeScriptLoadError(
        '  both with the native node TypeScript support and configured TypeScript loaders.\n' +
          '    Errors were:\n' +
          `    - ${String(error)}\n` +
          `    - ${String(loaderError)}`,
        false,
        loaderError,
      )
    }
  }
}

/** L105-L111: every TypeScript failure gets Jest's preamble. */
function typeScriptFailure(path: string, error: unknown): JestConfigError {
  const needsLoader =
    (error instanceof TypeScriptLoadError && error.needsLoader) ||
    (error instanceof JestConfigError && error.code === 'JEST_CONFIG_TS_LOADER')
  const text =
    error instanceof TypeScriptLoadError && error.message.startsWith('  both with')
      ? error.message
      : String(error)
  return new JestConfigError(
    needsLoader ? 'JEST_CONFIG_TS_LOADER' : 'JEST_CONFIG_LOAD_FAILED',
    `Jest: Failed to parse the TypeScript config file ${path}\n  ${text}`,
    { cause: error },
  )
}

/**
 * `jest-util`'s `requireOrImportModule(path)` (with `interopRequireDefault`): a `.mjs` or `.mts`
 * file is imported and must have a default export; anything else is `require`d, and a module with
 * no default export is its namespace (`{ default: namespace }` unwrapped), named exports and all.
 * Configs and presets load this way. Throws `ConfigError` (`CONFIG_LOAD_FAILED`, the error as
 * `cause`).
 */
export async function requireOrImportModule(path: string): Promise<unknown> {
  const importOnly = path.endsWith('.mjs') || path.endsWith('.mts')
  try {
    return await importConfigModule(path, { withoutDefault: importOnly ? 'error' : 'namespace' })
  } catch (error) {
    if (importOnly && error instanceof ConfigError && error.code === 'CONFIG_INVALID') {
      // jest-util `requireOrImportModule.ts` L27-L31
      throw new ConfigError(
        'CONFIG_LOAD_FAILED',
        `Jest: Failed to load ESM at ${path} - did you use a default export?`,
        { cause: new Error(`Jest: Failed to load ESM at ${path} - did you use a default export?`) },
      )
    }
    throw error
  }
}

async function importModule(path: string): Promise<unknown> {
  try {
    return await requireOrImportModule(path)
  } catch (thrown) {
    const error = importFailure(thrown)
    if (error instanceof JestConfigError) throw error
    throw new JestConfigError('JEST_CONFIG_LOAD_FAILED', messageOf(error), { cause: error })
  }
}

/** Sets `rootDir` as `readConfigFileAndSetRootDir` does (L127-L141). */
function withRootDir(value: unknown, configPath: string): JestInitialOptions {
  if (!isRecord(value)) {
    throw new JestConfigError(
      'JEST_CONFIG_INVALID',
      `the config in "${configPath}" must be an object, or a function that returns one`,
    )
  }
  const rootDir = value.rootDir
  if (rootDir) {
    if (typeof rootDir !== 'string') {
      throw new JestConfigError(
        'JEST_CONFIG_INVALID',
        `"rootDir" in "${configPath}" must be a string`,
      )
    }
    return isAbsolute(rootDir)
      ? value
      : { ...value, rootDir: resolve(dirname(configPath), rootDir) }
  }
  return { ...value, rootDir: dirname(configPath) }
}

/**
 * Reads one config file and sets its `rootDir`: Jest's `readConfigFileAndSetRootDir(configPath)`.
 * Throws `JestConfigError` (`JEST_CONFIG_LOAD_FAILED`, `JEST_CONFIG_TS_LOADER`, `JEST_CONFIG_INVALID`).
 * @public
 */
export async function readJestConfigFile(configPath: string): Promise<JestInitialOptions> {
  const isTs =
    configPath.endsWith('.ts') || configPath.endsWith('.mts') || configPath.endsWith('.cts')
  let value: unknown
  if (isTs) {
    try {
      value = await loadTypeScript(configPath)
    } catch (error) {
      throw typeScriptFailure(configPath, error)
    }
  } else if (configPath.endsWith('.json')) {
    value = readJsonFile(configPath)
  } else {
    value = await importModule(configPath)
  }
  if (configPath.endsWith('package.json')) {
    // L119-L123: no `jest` key reads as `{}`.
    value = (isRecord(value) ? value.jest : undefined) || {}
  }
  if (typeof value === 'function') {
    try {
      value = await value()
    } catch (cause) {
      throw new JestConfigError(
        'JEST_CONFIG_LOAD_FAILED',
        `the config function in "${configPath}" threw: ${messageOf(cause)}`,
        { cause },
      )
    }
  }
  return withRootDir(value, configPath)
}

/**
 * Reads the config a source names, as Jest's `readInitialOptions` does: a file is read and its
 * `rootDir` set; inline JSON (`--config '{…}'`) gets `rootDir` from the source's directory when it
 * has none. Returns the options and the config path (`null` for inline).
 * @public
 */
export async function loadJestConfig(
  source: ConfigSource,
): Promise<{ readonly options: JestInitialOptions; readonly configPath: string | null }> {
  if (source.kind === 'inline') {
    let parsed: unknown
    try {
      parsed = JSON.parse(source.text)
    } catch (cause) {
      throw new JestConfigError(
        'JEST_CONFIG_INVALID',
        // index.ts L357-L359
        'There was an error while parsing the `--config` argument as a JSON string.',
        { cause },
      )
    }
    if (!isRecord(parsed)) {
      throw new JestConfigError('JEST_CONFIG_INVALID', 'the `--config` JSON must be an object')
    }
    return { options: { ...parsed, rootDir: parsed.rootDir || source.path }, configPath: null }
  }
  return { options: await readJestConfigFile(source.path), configPath: source.path }
}

/**
 * An inline project object (`projects: [{ … }]`) as `readInitialOptions` prepares it (L337-L344):
 * its `rootDir` is the parent config's directory, or its own with `<rootDir>` replaced by that.
 * @public
 */
export function inlineProjectOptions(
  project: Readonly<Record<string, unknown>>,
  parentConfigDirname: string,
): JestInitialOptions {
  const rootDir = project.rootDir
  return {
    ...project,
    rootDir:
      typeof rootDir === 'string' && rootDir !== ''
        ? replaceRootDirInPath(parentConfigDirname, rootDir)
        : parentConfigDirname,
  }
}
