// The oracles of B20 (T3.13). Oracle A: oxc's `moduleRunnerTransformSync` (0.156.0), compared as
// ASTs. Oracle B: the module run in a stub linker with the loader's wrapper parameters. Test-only:
// this is the one place (with the bench) that may name the deprecated oxc API.

import { TransformError, toModuleRunner } from '@provino/transform'
import type { TransformRecord } from '@provino/types'
import { type ParserOptions, parseSync } from 'oxc-parser'
import { moduleRunnerTransformSync } from 'oxc-transform'
import { EXEMPTIONS } from './runner-exemptions.ts'

const DROP: ReadonlySet<string> = new Set(['start', 'end', 'range', 'loc', 'raw', 'parent'])
const LISTS: ReadonlySet<string> = new Set(['body', 'consequent'])

const PARSE: ParserOptions = { lang: 'jsx', sourceType: 'module', preserveParens: false }

/** How to read past oxc's mishandling of `import d, * as n` (see the exemption of that name). */
export interface Relax {
  readonly side: 'oracle' | 'ours'
  /** The local names of the default imports declared together with a namespace import. */
  readonly names: ReadonlySet<string>
}

const DEFAULT_BINDING = { type: 'DefaultBinding' }

/**
 * An AST with positions, raw text and empty statements in lists dropped. With `relax`, a reference
 * to such a default import reads as one marker on both sides: a free name in oracle A's output
 * (it never rewrote it), `ns.default` in ours.
 */
export function normalise(value: unknown, relax?: Relax, key = ''): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => normalise(item, relax))
    return LISTS.has(key)
      ? items.filter((item) => (item as { type?: unknown } | null)?.type !== 'EmptyStatement')
      : items
  }
  if (value !== null && typeof value === 'object') {
    const node = value as Record<string, unknown>
    if (
      relax?.side === 'oracle' &&
      node.type === 'Identifier' &&
      relax.names.has(String(node.name))
    ) {
      return DEFAULT_BINDING
    }
    if (
      relax !== undefined &&
      node.type === 'MemberExpression' &&
      node.computed === false &&
      (node.property as { name?: unknown } | undefined)?.name === 'default'
    ) {
      return DEFAULT_BINDING
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) {
      if (DROP.has(k) || (relax !== undefined && k === 'shorthand')) continue
      out[k] = normalise(v, relax, k)
    }
    return out
  }
  return value
}

/** The first place two normalised ASTs differ, as a path and the two values, or `null`. */
export function firstDifference(a: unknown, b: unknown, path = '$'): string | null {
  if (Object.is(a, b)) return null
  if (Array.isArray(a) && Array.isArray(b)) {
    const length = Math.max(a.length, b.length)
    for (let i = 0; i < length; i++) {
      const found = firstDifference(a[i], b[i], `${path}[${i}]`)
      if (found !== null) return found
    }
    return null
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys) {
      const found = firstDifference(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${path}.${k}`,
      )
      if (found !== null) return found
    }
    return null
  }
  return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`
}

export interface OracleResult {
  readonly code: string | null
  /** The first error's message, when the transform failed. */
  readonly error: string | null
  readonly deps: readonly string[]
  readonly dynamicDeps: readonly string[]
}

/** Oracle A's output for `code`. */
export function oracleA(filename: string, code: string): OracleResult {
  const result = moduleRunnerTransformSync(filename, code, { sourcemap: false })
  const [first] = result.errors
  if (first !== undefined) return { code: null, error: first.message, deps: [], dynamicDeps: [] }
  return { code: result.code, error: null, deps: result.deps, dynamicDeps: result.dynamicDeps }
}

/** Our output, in the same shape. */
export function ours(filename: string, code: string): OracleResult {
  try {
    const result = toModuleRunner(filename, { ...EMPTY_RECORD, code })
    return { code: result.code, error: null, deps: result.deps, dynamicDeps: result.dynamicDeps }
  } catch (error) {
    if (error instanceof TransformError && error.code === 'TRANSFORM_RUNNER_FAILED') {
      const prefix = `the module-runner transform failed on ${filename}: `
      return { code: null, error: error.message.slice(prefix.length), deps: [], dynamicDeps: [] }
    }
    throw error
  }
}

const EMPTY_RECORD: TransformRecord = {
  code: '',
  map: null,
  diagnostics: [],
  imports: [],
  staticMocks: [],
  lateDeps: [],
  format: 'esm',
  hasTopLevelAwait: false,
  cacheKey: '',
  fromCache: false,
}

/** Names of the `Object.defineProperty(__vite_ssr_exports__, "name", …)` getters in `code`. */
export function exportNames(code: string): string[] {
  const names: string[] = []
  for (const match of code.matchAll(
    /Object\.defineProperty\(__vite_ssr_exports__, ("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g,
  )) {
    names.push((match[1] as string).slice(1, -1))
  }
  return names.sort()
}

/**
 * Compares our output with oracle A's. Returns the reason they differ, or `null` when they have
 * equal ASTs, errors, `deps` as sets, `dynamicDeps` and export names.
 */
export function compareWithOracle(filename: string, code: string): string | null {
  return compareOutputs(filename, oracleA(filename, code), ours(filename, code))
}

function defaultImportNames(input: string): ReadonlySet<string> {
  const names = new Set<string>()
  for (const match of input.matchAll(/\bimport\s+([\w$]+)\s*,\s*\*\s*as\b/g)) {
    names.add(match[1] as string)
  }
  return names
}

export interface Verdict {
  /** Why the outputs differ, when they do and no exemption covers it. */
  readonly reason: string | null
  /** The exemption that covers the difference. */
  readonly exemption: string | null
}

/** `compareWithOracle` plus the exemption list: a difference an entry covers is not a failure. */
export function judge(
  filename: string,
  input: string,
  expected: OracleResult,
  actual: OracleResult,
): Verdict {
  const strict = compareOutputs(filename, expected, actual)
  if (strict === null) return { reason: null, exemption: null }
  for (const entry of EXEMPTIONS) {
    if (!entry.applies(input, expected, actual)) continue
    if (
      entry.relax === undefined ||
      compareOutputs(filename, expected, actual, defaultImportNames(input)) === null
    ) {
      return { reason: null, exemption: entry.id }
    }
  }
  return { reason: strict, exemption: null }
}

/** The comparison `compareWithOracle` makes, on two results already in hand. */
export function compareOutputs(
  filename: string,
  expected: OracleResult,
  actual: OracleResult,
  defaults?: ReadonlySet<string>,
): string | null {
  if (expected.error !== null || actual.error !== null) {
    return expected.error === actual.error
      ? null
      : `errors differ: oracle ${JSON.stringify(expected.error)}, ours ${JSON.stringify(actual.error)}`
  }
  const expectedCode = expected.code as string
  const actualCode = actual.code as string
  const left = parseSync(filename, expectedCode, PARSE)
  const right = parseSync(filename, actualCode, PARSE)
  if (right.errors.some((error) => String(error.severity) === 'Error')) {
    return `our output does not parse: ${right.errors[0]?.message}`
  }
  const diff = firstDifference(
    normalise(left.program, defaults && { side: 'oracle', names: defaults }),
    normalise(right.program, defaults && { side: 'ours', names: defaults }),
  )
  if (diff !== null) return `AST differs at ${diff}`
  // oracle A's order is a hash's; ours is source order (Gap 3), so both compare as sets.
  if ([...new Set(expected.deps)].sort().join('\n') !== [...actual.deps].sort().join('\n')) {
    return `deps differ: oracle ${JSON.stringify(expected.deps)}, ours ${JSON.stringify(actual.deps)}`
  }
  if (
    [...new Set(expected.dynamicDeps)].sort().join('\n') !==
    [...actual.dynamicDeps].sort().join('\n')
  ) {
    return `dynamicDeps differ: oracle ${JSON.stringify(expected.dynamicDeps)}, ours ${JSON.stringify(actual.dynamicDeps)}`
  }
  if (exportNames(expectedCode).join('\n') !== exportNames(actualCode).join('\n')) {
    return 'export names differ'
  }
  return null
}

// ---- Oracle B: the stub linker ---------------------------------------------------------------

/** What running a module did: the linker's log, its exports and any error. */
export interface Execution {
  readonly log: readonly string[]
  readonly exports: Readonly<Record<string, string>>
  readonly error: string | null
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>

const PARAMS = [
  '__vite_ssr_exports__',
  '__vite_ssr_import_meta__',
  '__vite_ssr_import__',
  '__vite_ssr_dynamic_import__',
  '__vite_ssr_exportAll__',
  '__provino_import__',
] as const

function describe(value: unknown): string {
  if (typeof value === 'function') return `function ${(value as { name: string }).name}`
  if (typeof value === 'symbol') return value.toString()
  if (value !== null && typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return Object.prototype.toString.call(value)
    }
  }
  return String(value)
}

/**
 * A value that stands for `path`: reading a member gives another, calling it logs the call (and
 * what `this` was) and returns the path as text.
 */
function stub(path: string, log: string[], owner: () => object | undefined): object {
  const proxy: object = new Proxy(() => {}, {
    get(_, key) {
      if (key === Symbol.toPrimitive) return () => path
      if (key === 'then' || typeof key === 'symbol') return undefined
      return stub(`${path}.${key}`, log, () => proxy)
    },
    apply(_, thisArg, args) {
      log.push(
        `call ${path} this=${thisArg === undefined ? 'undefined' : thisArg === owner() ? 'owner' : 'other'} args=${args.map(describe).join(',')}`,
      )
      return `${path}()`
    },
    construct(_, args) {
      log.push(`new ${path} args=${args.map(describe).join(',')}`)
      return { constructed: path }
    },
    has: () => true,
  })
  return proxy
}

function namespaceOf(specifier: string, log: string[]): object {
  const cache = new Map<string, object>()
  const ns: object = new Proxy(
    {},
    {
      get(_, key) {
        if (typeof key === 'symbol' || key === 'then') return undefined
        let member = cache.get(key)
        if (member === undefined) {
          member = stub(`${specifier}#${key}`, log, () => ns)
          cache.set(key, member)
        }
        return member
      },
      has: () => true,
      ownKeys: () => ['default'],
      getOwnPropertyDescriptor: (_, key) =>
        key === 'default' ? { value: undefined, enumerable: true, configurable: true } : undefined,
    },
  )
  return ns
}

/** Runs `code` in the loader's wrapper with a stub linker. */
export async function execute(code: string): Promise<Execution> {
  const log: string[] = []
  const exports: Record<string, unknown> = {}
  const namespaces = new Map<string, object>()
  const load = (specifier: string): object => {
    let ns = namespaces.get(specifier)
    if (ns === undefined) {
      ns = namespaceOf(specifier, log)
      namespaces.set(specifier, ns)
    }
    return ns
  }
  const importer = (specifier: string, options?: { importedNames?: string[] }): object => {
    log.push(
      `import ${specifier}${options?.importedNames === undefined ? '' : ` {${options.importedNames.join(',')}}`}`,
    )
    return load(specifier)
  }
  const dynamic = (specifier: unknown): Promise<object> => {
    log.push(`import() ${String(specifier)}`)
    return Promise.resolve(load(String(specifier)))
  }
  const exportAll = (ns: object): void => {
    log.push('exportAll')
    void ns
  }
  let error: string | null = null
  try {
    const fn = new AsyncFunction(...PARAMS, `'use strict';${code}`)
    await fn(exports, { url: 'file:///stub.js' }, importer, dynamic, exportAll, importer)
  } catch (thrown) {
    const e = thrown as { name?: string; message?: string }
    error = `${e.name}: ${e.message}`
  }
  const values: Record<string, string> = {}
  for (const key of Object.keys(exports).sort()) {
    try {
      values[key] = describe(exports[key])
    } catch (thrown) {
      values[key] = `throws ${(thrown as { name?: string }).name}`
    }
  }
  return { log, exports: values, error }
}
