// Reads the tsconfig compiler options that change emit (Track 3 R1 step 2): the nearest
// tsconfig.json for `'auto'`, following `extends` (relative paths and package specifiers).
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { TransformError } from '../errors.ts'

/** The compiler options the transform reads. */
export interface EmitOptions {
  readonly jsx?: string
  readonly jsxImportSource?: string
  readonly jsxFactory?: string
  readonly jsxFragmentFactory?: string
  readonly experimentalDecorators?: boolean
  readonly emitDecoratorMetadata?: boolean
  readonly verbatimModuleSyntax?: boolean
  readonly useDefineForClassFields?: boolean
  readonly target?: string
}

const KEYS: readonly (keyof EmitOptions)[] = [
  'jsx',
  'jsxImportSource',
  'jsxFactory',
  'jsxFragmentFactory',
  'experimentalDecorators',
  'emitDecoratorMetadata',
  'verbatimModuleSyntax',
  'useDefineForClassFields',
  'target',
]

/** Calls `visit` for each character outside a string, and copies strings through unchanged. */
function scan(text: string, visit: (index: number) => number | string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
      continue
    }
    const step = visit(i)
    if (typeof step === 'number') i = step
    else {
      out += step
      i++
    }
  }
  return out
}

/** Removes comments and trailing commas outside strings, so `JSON.parse` reads tsconfig JSONC. */
export function stripJsonc(text: string): string {
  const noComments = scan(text, (i) => {
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i)
      return end === -1 ? text.length : end
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2)
      return end === -1 ? text.length : end + 2
    }
    return text[i] ?? ''
  })
  const closer = /\s*[}\]]/y
  return scan(noComments, (i) => {
    if (noComments[i] !== ',') return noComments[i] ?? ''
    closer.lastIndex = i + 1
    return closer.test(noComments) ? i + 1 : ','
  })
}

interface RawConfig {
  readonly extends?: unknown
  readonly compilerOptions?: unknown
}

function readConfig(path: string): RawConfig {
  try {
    const parsed: unknown = JSON.parse(stripJsonc(readFileSync(path, 'utf8')))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object')
    }
    return parsed
  } catch (error) {
    throw new TransformError('TRANSFORM_TSCONFIG_INVALID', `cannot read ${path}`, {
      cause: error,
    })
  }
}

/** Resolves an `extends` entry the way TypeScript does, or `null` when it can't be found. */
function resolveExtends(specifier: string, from: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const path = resolve(dirname(from), specifier)
    if (existsSync(path)) return path
    return !path.endsWith('.json') && existsSync(`${path}.json`) ? `${path}.json` : null
  }
  const require = createRequire(from)
  const candidates = specifier.endsWith('.json')
    ? [specifier]
    : [`${specifier}/tsconfig.json`, `${specifier}.json`, specifier]
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate)
    } catch {
      // Try the next form, as TypeScript does.
    }
  }
  return null
}

function pick(compilerOptions: unknown): EmitOptions {
  if (compilerOptions === null || typeof compilerOptions !== 'object') return {}
  const picked: Record<string, unknown> = {}
  for (const key of KEYS) {
    const value: unknown = Reflect.get(compilerOptions, key)
    if (typeof value === 'string' || typeof value === 'boolean') picked[key] = value
  }
  return picked
}

/** A config's emit options, and the `extends` entries that couldn't be found. */
export interface LoadedConfig {
  readonly emit: EmitOptions
  readonly missing: readonly string[]
}

/**
 * A config's emit options with its `extends` chain applied (later entries win, own last). Like
 * tsc, a base that can't be found is reported and skipped; one that can't be parsed throws.
 */
export function loadEmitOptions(path: string, seen: ReadonlySet<string> = new Set()): LoadedConfig {
  if (seen.has(path)) {
    throw new TransformError('TRANSFORM_TSCONFIG_INVALID', `${path} extends itself`)
  }
  const config = readConfig(path)
  const bases =
    config.extends === undefined
      ? []
      : Array.isArray(config.extends)
        ? config.extends
        : [config.extends]
  let merged: EmitOptions = {}
  const missing: string[] = []
  for (const base of bases) {
    if (typeof base !== 'string') continue
    const basePath = resolveExtends(base, path)
    if (basePath === null) {
      missing.push(`${path} extends "${base}", which cannot be found`)
      continue
    }
    const loaded = loadEmitOptions(basePath, new Set([...seen, path]))
    merged = { ...merged, ...loaded.emit }
    missing.push(...loaded.missing)
  }
  return { emit: { ...merged, ...pick(config.compilerOptions) }, missing }
}

/** Finds the nearest tsconfig.json at or above `dir`, with a per-instance cache. */
export function createTsconfigFinder(): (dir: string) => string | null {
  const cache = new Map<string, string | null>()
  const find = (dir: string): string | null => {
    const cached = cache.get(dir)
    if (cached !== undefined) return cached
    const candidate = join(dir, 'tsconfig.json')
    const parent = dirname(dir)
    const found = existsSync(candidate) ? candidate : parent === dir ? null : find(parent)
    cache.set(dir, found)
    return found
  }
  return find
}
