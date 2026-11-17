// Records Node's CommonJS loader as the bin found it, before the bin reads a config: next/jest's
// config patches `Module.prototype.require` and `Module._resolveFilename` as it loads (Next.js's
// require hook), and in band the tests run in this process. `@provino/loader` reads the record under
// the same registered symbol (its `internal/node-loader.ts`) and runs a shared external's native
// load with these functions under `module.nativeLoadPatches: 'skip'`, so no such patch reaches a
// test file's modules, as under Jest. One of the bin's light files: it imports `node:module` only.
import Module from 'node:module'

/** The key `@provino/loader` reads the record under. */
const NODE_LOADER_KEY = Symbol.for('provino.nodeLoader')

/**
 * Records `Module.prototype.require`, `Module._load` and `Module._resolveFilename` as they are now,
 * once per process: a record already there (an earlier call, or the loader's own) is kept.
 */
export function recordNodeLoader(): void {
  if (Object.hasOwn(globalThis, NODE_LOADER_KEY)) return
  const internals = Module as unknown as {
    readonly prototype: { readonly require: unknown }
    readonly _load: unknown
    readonly _resolveFilename: unknown
  }
  const record = Object.freeze({
    require: internals.prototype.require,
    load: internals._load,
    resolveFilename: internals._resolveFilename,
  })
  Object.defineProperty(globalThis, NODE_LOADER_KEY, { value: record, configurable: true })
}
