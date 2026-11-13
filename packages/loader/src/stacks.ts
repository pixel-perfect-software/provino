// Source-mapped stacks (T2.9's consumer): a frame in a module the loader compiled is reported at
// its place in the file as written, not in the code the loader ran. That code is the transform's
// output (Oxc's reprint, a project's Jest transformer, the hoister's moves and late imports) in
// module-runner form, so its lines and columns are not the file's: the import rewrite alone puts
// every import on one line of its own, above everything, so a frame below the imports is off by
// about as many lines as the imports took. Each record keeps the map composed back to the source
// (`Loader.getSourceMap`), and `compile` reports line 1 in the body's own columns, so a frame's
// position is a position in the code that map starts from.
import { SourceMap, type SourceMapping } from 'node:module'
import type { Loader, ModuleId, SourceMapV3 } from '@provino/types'

type PrepareStackTrace = (error: Error, sites: NodeJS.CallSite[]) => unknown

/**
 * The registered symbol the installed formatter carries its frame mapper under: `(sites) => sites`,
 * each mapped as `.stack` maps it. Code that swaps the formatter out to read structured call sites
 * (the coordinator's `--detectOpenHandles`, in the process an inline worker runs in) finds it on the
 * formatter it swapped out, so it never imports the loader.
 */
export const MAP_CALL_SITES: unique symbol = Symbol.for('provino.mapCallSites')

/**
 * Installs an `Error.prepareStackTrace` that maps each frame in a module `loader` compiled through
 * that module's source map, then formats the stack with the formatter it found (Node's own, which
 * keeps Node's header for its coded errors). A frame keeps its file and its function name; only
 * its line and column change, and only when the map has a segment on the frame's own line at or
 * before its column (the lookup `source-map-support` and `@jridgewell/trace-mapping` make). A
 * frame the map can't place, or one in a file the loader didn't compile, stays as V8 gave it.
 * The formatter also carries the frame mapper itself, under `MAP_CALL_SITES`. Returns the
 * uninstall, which puts the previous formatter back if this one is still installed.
 * Process-wide: the worker installs it once, after it made its loader.
 * @public
 */
export function installSourceMappedStacks(loader: Pick<Loader, 'getSourceMap'>): () => void {
  const previous = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace')
  const format: unknown = previous?.value
  const decoded = new WeakMap<SourceMapV3, SourceMap | null>()

  /** The decoded map of the module V8 calls `file`, or `null` when it has none or it can't be read. */
  function mapOf(file: string): SourceMap | null {
    const map = loader.getSourceMap(file as ModuleId)
    if (map === null) return null
    let sourceMap = decoded.get(map)
    if (sourceMap === undefined) {
      try {
        // Node's payload, without the sources' text: a lookup reads only the mappings.
        sourceMap = new SourceMap({
          version: map.version,
          file: map.file ?? '',
          sourceRoot: map.sourceRoot ?? '',
          sources: map.sources.map((source) => source ?? ''),
          sourcesContent: [],
          names: [...map.names],
          mappings: map.mappings,
        })
      } catch {
        sourceMap = null
      }
      decoded.set(map, sourceMap)
    }
    return sourceMap
  }

  function mapped(site: NodeJS.CallSite): NodeJS.CallSite {
    // A throw here would replace the whole stack with it: any failure leaves the frame as it was.
    try {
      if (site.isEval() || site.isNative()) return site
      const file: unknown = site.getFileName()
      const line = site.getLineNumber()
      const column = site.getColumnNumber()
      if (typeof file !== 'string' || line === null || column === null) return site
      const sourceMap = mapOf(file)
      if (sourceMap === null) return site
      const entry: Partial<SourceMapping> = sourceMap.findEntry(line - 1, column - 1)
      // `findEntry` takes the nearest segment at or before the position even on an earlier line;
      // only one on the frame's own line places it, as in the other source-map readers.
      if (
        entry.generatedLine !== line - 1 ||
        typeof entry.originalSource !== 'string' ||
        typeof entry.originalLine !== 'number' ||
        typeof entry.originalColumn !== 'number'
      ) {
        return site
      }
      return new MappedCallSite(site, entry.originalLine + 1, entry.originalColumn + 1)
    } catch {
      return site
    }
  }

  const prepareStackTrace = Object.assign(
    (error: Error, sites: NodeJS.CallSite[]): unknown => {
      const frames = sites.map(mapped)
      if (typeof format === 'function') return (format as PrepareStackTrace)(error, frames)
      return defaultFormat(error, frames)
    },
    { [MAP_CALL_SITES]: (sites: readonly NodeJS.CallSite[]) => sites.map(mapped) },
  )

  Error.prepareStackTrace = prepareStackTrace
  return () => {
    if (Error.prepareStackTrace !== prepareStackTrace) return
    if (previous === undefined) Reflect.deleteProperty(Error, 'prepareStackTrace')
    else Object.defineProperty(Error, 'prepareStackTrace', previous)
  }
}

/** V8's own layout, for a process with no formatter to hand the frames to. */
function defaultFormat(error: Error, sites: readonly NodeJS.CallSite[]): string {
  let header: string
  try {
    header = Error.prototype.toString.call(error)
  } catch {
    header = 'Error'
  }
  return sites.length === 0 ? header : `${header}\n    at ${sites.join('\n    at ')}`
}

/**
 * A V8 call site at another line and column. Every method answers as the site does except the
 * position, and `toString` is the site's own text with its position swapped, so the frame keeps
 * V8's layout (`async`, `new`, `[as m]`, the function and type names).
 */
class MappedCallSite implements NodeJS.CallSite {
  readonly #site: NodeJS.CallSite
  readonly #line: number
  readonly #column: number

  constructor(site: NodeJS.CallSite, line: number, column: number) {
    this.#site = site
    this.#line = line
    this.#column = column
  }

  getLineNumber(): number {
    return this.#line
  }

  getColumnNumber(): number {
    return this.#column
  }

  toString(): string {
    const text = this.#site.toString()
    const position = `:${this.#site.getLineNumber()}:${this.#site.getColumnNumber()}`
    const at = text.lastIndexOf(position)
    if (at === -1) return text
    return `${text.slice(0, at)}:${this.#line}:${this.#column}${text.slice(at + position.length)}`
  }

  getThis(): unknown {
    return this.#site.getThis()
  }

  getTypeName(): string | null {
    return this.#site.getTypeName()
  }

  getFunction(): ReturnType<NodeJS.CallSite['getFunction']> {
    return this.#site.getFunction()
  }

  getFunctionName(): string | null {
    return this.#site.getFunctionName()
  }

  getMethodName(): string | null {
    return this.#site.getMethodName()
  }

  getFileName(): string | null {
    return this.#site.getFileName()
  }

  getEnclosingLineNumber(): number | null {
    return this.#site.getEnclosingLineNumber()
  }

  getEnclosingColumnNumber(): number | null {
    return this.#site.getEnclosingColumnNumber()
  }

  getEvalOrigin(): string | undefined {
    return this.#site.getEvalOrigin()
  }

  getScriptNameOrSourceURL(): string | null {
    return this.#site.getScriptNameOrSourceURL()
  }

  getScriptHash(): string {
    return this.#site.getScriptHash()
  }

  getPosition(): number {
    return this.#site.getPosition()
  }

  getPromiseIndex(): number | null {
    return this.#site.getPromiseIndex()
  }

  isToplevel(): boolean {
    return this.#site.isToplevel()
  }

  isEval(): boolean {
    return this.#site.isEval()
  }

  isNative(): boolean {
    return this.#site.isNative()
  }

  isConstructor(): boolean {
    return this.#site.isConstructor()
  }

  isAsync(): boolean {
    return this.#site.isAsync()
  }

  isPromiseAll(): boolean {
    return this.#site.isPromiseAll()
  }
}
