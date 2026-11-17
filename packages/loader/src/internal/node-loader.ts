// Node's CommonJS loader as Provino found it (`module.nativeLoadPatches: 'skip'`). A shared external
// loads natively, so its own `require`s go through `Module.prototype.require`, `Module._load` and
// `Module._resolveFilename`, which code the process loads outside any test file may have replaced:
// Next.js's require hook (which next/jest's config and transformer install) rewrites a
// `.shared-runtime` request to its server runtime and aliases `styled-jsx`. jest-runtime loads a
// test's modules itself and never calls Node's loader, so under Jest none of that reaches them
// (`cli/module-patch-outer-realm`). `withNodeLoader` runs a native load with the three functions as
// they were first seen, and puts the process's back after it.
//
// "First seen" is the earliest of: `provino`'s bin, which records them under `NODE_LOADER_KEY` before
// it reads a config (next/jest's patches as it loads), and this module's own evaluation, which in a
// worker comes before any transformer loads. The record is three functions, frozen, one per process.
import Module from 'node:module'

/** One of the loader's functions, as the record holds it. */
type LoaderFunction = (this: unknown, ...args: never[]) => unknown

/** The three functions a native load runs with. */
interface NodeLoader {
  readonly require: LoaderFunction
  readonly load: LoaderFunction
  readonly resolveFilename: LoaderFunction
}

/** `Module` with the two internals the record reads and swaps. */
interface ModuleInternals {
  prototype: { require: LoaderFunction }
  _load: LoaderFunction
  _resolveFilename: LoaderFunction
}

/**
 * The registered symbol the first Provino code in the process records the loader under. `provino`'s
 * bin (`internal/node-loader.ts`) writes the same record under the same key.
 */
const NODE_LOADER_KEY = Symbol.for('provino.nodeLoader')

const internals = Module as unknown as ModuleInternals

function isNodeLoader(value: unknown): value is NodeLoader {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<Record<keyof NodeLoader, unknown>>
  return (
    typeof record.require === 'function' &&
    typeof record.load === 'function' &&
    typeof record.resolveFilename === 'function'
  )
}

/** The record the process holds, made now when none is there. */
function adopt(): NodeLoader {
  const host = globalThis as unknown as Record<symbol, unknown>
  const recorded = host[NODE_LOADER_KEY]
  if (isNodeLoader(recorded)) return recorded
  const record: NodeLoader = Object.freeze({
    require: internals.prototype.require,
    load: internals._load,
    resolveFilename: internals._resolveFilename,
  })
  Object.defineProperty(globalThis, NODE_LOADER_KEY, { value: record, configurable: true })
  return record
}

const found: NodeLoader = adopt()

/**
 * Runs `load` (a synchronous native load) with Node's loader as Provino found it, and puts the
 * process's functions back after it. A function the load itself replaced is left as the load left
 * it (a package that hooks the loader on purpose keeps its hook). Nothing is swapped when the
 * loader is as found.
 */
export function withNodeLoader<T>(load: () => T): T {
  const prototype = internals.prototype
  const current = {
    require: prototype.require,
    load: internals._load,
    resolveFilename: internals._resolveFilename,
  }
  if (
    current.require === found.require &&
    current.load === found.load &&
    current.resolveFilename === found.resolveFilename
  ) {
    return load()
  }
  prototype.require = found.require
  internals._load = found.load
  internals._resolveFilename = found.resolveFilename
  try {
    return load()
  } finally {
    if (prototype.require === found.require) prototype.require = current.require
    if (internals._load === found.load) internals._load = current.load
    if (internals._resolveFilename === found.resolveFilename) {
      internals._resolveFilename = current.resolveFilename
    }
  }
}
