// Source-mapped stacks (T2.9's consumer): a frame in a module the loader compiled is reported at
// its place in the file as written, not in the code the loader ran. That code is the transform's
// output (Oxc's reprint, a project's Jest transformer, the hoister's moves and late imports) in
// module-runner form, so its lines and columns are not the file's: the import rewrite alone puts
// every import on one line of its own, above everything, so a frame below the imports is off by
// about as many lines as the imports took. Each record keeps the map composed back to the source
// (`Loader.getSourceMap`), and `compile` reports line 1 in the body's own columns, so a frame's
// position is a position in the code that map starts from.
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { SourceMap, type SourceMapping } from 'node:module'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Loader, ModuleId, SourceMapV3 } from '@provino/types'

/** Words that start an expression but name nothing a frame could be called after. */
const RESERVED: ReadonlySet<string> = new Set([
  'new',
  'throw',
  'await',
  'yield',
  'return',
  'typeof',
  'void',
  'delete',
  'function',
  'class',
  'async',
  'this',
  'super',
  'import',
  'if',
  'for',
  'while',
  'switch',
  'try',
  'catch',
  'var',
  'let',
  'const',
  'null',
  'true',
  'false',
  'in',
  'of',
  'do',
  'else',
  'with',
])

type PrepareStackTrace = (error: Error, sites: NodeJS.CallSite[]) => unknown

/**
 * The registered symbol the installed formatter carries its frame mapper under: `(sites) => sites`,
 * each mapped as `.stack` maps it. Code that swaps the formatter out to read structured call sites
 * (the coordinator's `--detectOpenHandles`, in the process an inline worker runs in) finds it on the
 * formatter it swapped out, so it never imports the loader.
 */
export const MAP_CALL_SITES: unique symbol = Symbol.for('provino.mapCallSites')

/** How `installSourceMappedStacks` reads a frame. */
export interface StackOptions {
  /**
   * `mapped-name` names a frame after the name its map holds at the frame's own position
   * (`ModulePolicy.stackFrameNames`); `engine` (the default) keeps the name V8 gave it.
   */
  readonly frameNames?: 'mapped-name' | 'engine'
}

/**
 * Installs an `Error.prepareStackTrace` that maps each frame in a module `loader` compiled through
 * that module's source map, then formats the stack with the formatter it found (Node's own, which
 * keeps Node's header for its coded errors). A frame keeps its file and its function name; only
 * its line and column change, and only when the map has a segment on the frame's own line at or
 * before its column (the lookup `source-map-support` and `@jridgewell/trace-mapping` make). A
 * frame the map can't place, or one in a file the loader didn't compile, stays as V8 gave it.
 * With Node's source maps on (`process.sourceMapsEnabled`), a frame in a file the loader compiled
 * then goes through the map the file names itself (its `sourceMappingURL` comment), as Node maps
 * a file it loaded: Node never sees the loader's `vm` scripts, so its `module.findSourceMap` has
 * none for them. A file Node loaded is left to Node's formatter, which maps it. Off, the cost is
 * one flag read per stack (D115, `speed`).
 * The formatter also carries the frame mapper itself, under `MAP_CALL_SITES`. Returns the
 * uninstall, which puts the previous formatter back if this one is still installed.
 * Process-wide: the worker installs it once, after it made its loader.
 * @public
 */
export function installSourceMappedStacks(
  loader: Pick<Loader, 'getSourceMap'>,
  options: StackOptions = {},
): () => void {
  const renames = options.frameNames === 'mapped-name'
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

  const sourceLines = new WeakMap<SourceMapV3, Map<number, readonly string[]>>()

  /**
   * The name Jest's source-map support would give the frame: the map's own `names` entry, or, when
   * the map has none (Oxc's don't), the identifier the original source holds at the mapped
   * position, which is where Babel puts one. A reserved word (`new`, `throw`) isn't one.
   */
  function nameAt(file: string, entry: Partial<SourceMapping>): string | null {
    // Node's `SourceMapping` carries the map's `name`, which its types leave out.
    const named = (entry as { readonly name?: unknown }).name
    if (typeof named === 'string' && named !== '') return named
    const raw = loader.getSourceMap(file as ModuleId)
    if (raw === null || typeof entry.originalSource !== 'string') return null
    const index = raw.sources.indexOf(entry.originalSource)
    const content = index === -1 ? undefined : raw.sourcesContent?.[index]
    if (typeof content !== 'string') return null
    let byIndex = sourceLines.get(raw)
    if (byIndex === undefined) {
      byIndex = new Map()
      sourceLines.set(raw, byIndex)
    }
    let lines = byIndex.get(index)
    if (lines === undefined) {
      lines = content.split('\n')
      byIndex.set(index, lines)
    }
    const text = lines[entry.originalLine ?? -1]
    if (text === undefined) return null
    const word = /^[A-Za-z_$][\w$]*/.exec(text.slice(entry.originalColumn ?? 0))?.[0]
    return word === undefined || RESERVED.has(word) ? null : word
  }

  const ownMaps = new WeakMap<SourceMapV3, OwnMap | null>()

  /**
   * The map the file at `file` names itself (its last `sourceMappingURL` comment), read once per
   * record the loader holds for it, so a recompiled file is read again. `null` when it has none
   * or it can't be read.
   */
  function ownMapOf(file: string, record: SourceMapV3): OwnMap | null {
    let own = ownMaps.get(record)
    if (own === undefined) {
      own = readOwnMap(file)
      ownMaps.set(record, own)
    }
    return own
  }

  /** `site` moved on through Node's source map of its file (see `installSourceMappedStacks`). */
  function nodeMapped(site: NodeJS.CallSite, file: string): NodeJS.CallSite {
    const record = loader.getSourceMap(file as ModuleId)
    // A file Node loaded is Node's: its formatter, which this one hands the frames to, maps it.
    if (record === null) return site
    const own = ownMapOf(file, record)
    if (own === null) return site
    const line = site.getLineNumber()
    const column = site.getColumnNumber()
    if (line === null || column === null) return site
    const entry: Partial<SourceMapping> = own.map.findEntry(line - 1, column - 1)
    const { originalSource, originalLine, originalColumn } = entry
    if (
      typeof originalSource !== 'string' ||
      originalSource === '' ||
      typeof originalLine !== 'number' ||
      typeof originalColumn !== 'number'
    ) {
      return site
    }
    return new MappedCallSite(
      site,
      originalLine + 1,
      originalColumn + 1,
      null,
      own.source(originalSource),
    )
  }

  function mapped(site: NodeJS.CallSite, nodeMaps = false): NodeJS.CallSite {
    // A throw here would replace the whole stack with it: any failure leaves the frame as it was.
    try {
      if (site.isEval() || site.isNative()) return site
      const file: unknown = site.getFileName()
      if (typeof file !== 'string') return site
      if (!nodeMaps) return loaderMapped(site, file)
      return nodeMapped(loaderMapped(site, file), file)
    } catch {
      return site
    }
  }

  function loaderMapped(site: NodeJS.CallSite, file: string): NodeJS.CallSite {
    try {
      const line = site.getLineNumber()
      const column = site.getColumnNumber()
      if (line === null || column === null) return site
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
      const name = renames ? nameAt(file as ModuleId, entry) : null
      return new MappedCallSite(site, entry.originalLine + 1, entry.originalColumn + 1, name)
    } catch {
      return site
    }
  }

  const prepareStackTrace = Object.assign(
    (error: Error, sites: NodeJS.CallSite[]): unknown => {
      const nodeMaps = process.sourceMapsEnabled === true
      const frames = sites.map((site) => mapped(site, nodeMaps))
      if (typeof format === 'function') return (format as PrepareStackTrace)(error, frames)
      return defaultFormat(error, frames)
    },
    {
      [MAP_CALL_SITES]: (sites: readonly NodeJS.CallSite[]) => {
        const nodeMaps = process.sourceMapsEnabled === true
        return sites.map((site) => mapped(site, nodeMaps))
      },
    },
  )

  Error.prepareStackTrace = prepareStackTrace
  return () => {
    if (Error.prepareStackTrace !== prepareStackTrace) return
    if (previous === undefined) Reflect.deleteProperty(Error, 'prepareStackTrace')
    else Object.defineProperty(Error, 'prepareStackTrace', previous)
  }
}

/** A file's own source map, and how a source it names becomes the frame's file. */
interface OwnMap {
  readonly map: SourceMap
  readonly source: (source: string) => string
}

/** A `file:` URL as a path, which is how Node prints a mapped frame's file; anything else as it is. */
function printedSource(source: string): string {
  return source.startsWith('file:') ? fileURLToPath(source) : source
}

/** Node's `sourceMappingURL` comment: the last one in the file wins. */
const MAGIC_COMMENT = /\/[*/]#\s+sourceMappingURL=([^\s]+)/g

/**
 * The map the file names in its last `sourceMappingURL` comment (a `data:` URL or a URL relative
 * to the file), with its sources resolved against the map's URL as Node resolves them.
 */
function readOwnMap(file: string): OwnMap | null {
  try {
    const text = readFileSync(file, 'utf8')
    let url: string | undefined
    for (const match of text.matchAll(MAGIC_COMMENT)) url = match[1]
    if (url === undefined) return null
    const fileUrl = pathToFileURL(file)
    let json: string
    let base: URL = fileUrl
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',')
      if (comma === -1) return null
      const body = url.slice(comma + 1)
      json = url.slice(0, comma).endsWith(';base64')
        ? Buffer.from(body, 'base64').toString('utf8')
        : decodeURIComponent(body)
    } else {
      base = new URL(url, fileUrl)
      json = readFileSync(base, 'utf8')
    }
    const payload = JSON.parse(json) as Partial<SourceMapV3>
    const root =
      typeof payload.sourceRoot === 'string' && payload.sourceRoot !== ''
        ? new URL(`${payload.sourceRoot.replace(/\/?$/, '/')}`, base)
        : base
    const map = new SourceMap(payload as ConstructorParameters<typeof SourceMap>[0])
    return { map, source: (source) => printedSource(new URL(source, root).href) }
  } catch {
    return null
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
  readonly #name: string | null
  /** The file the position is in, when it is another than the site's (a map's source). */
  readonly #file: string | null

  constructor(
    site: NodeJS.CallSite,
    line: number,
    column: number,
    name: string | null = null,
    file: string | null = null,
  ) {
    this.#site = site
    this.#line = line
    this.#column = column
    this.#name = name
    this.#file = file
  }

  getLineNumber(): number {
    return this.#line
  }

  getColumnNumber(): number {
    return this.#column
  }

  toString(): string {
    if (this.#name !== null) return this.#named(this.#name)
    const text = this.#site.toString()
    const position = `:${this.#site.getLineNumber()}:${this.#site.getColumnNumber()}`
    const at = this.#file === null ? text.lastIndexOf(position) : -1
    if (at !== -1) {
      return `${text.slice(0, at)}:${this.#line}:${this.#column}${text.slice(at + position.length)}`
    }
    const where = `${this.#site.getScriptNameOrSourceURL() ?? this.#site.getFileName() ?? ''}${position}`
    const from = this.#file === null || where === position ? -1 : text.lastIndexOf(where)
    if (from === -1) return text
    const moved = `${this.#file}:${this.#line}:${this.#column}`
    return `${text.slice(0, from)}${moved}${text.slice(from + where.length)}`
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
    return this.#name ?? this.#site.getFunctionName()
  }

  /**
   * The frame with the map's name as its function name, laid out as V8 lays out a call site
   * (`Type.name [as method] (file:line:column)`), the layout Jest's source-map support rebuilds
   * (jest-source-map `callSiteToString`).
   */
  #named(name: string): string {
    const site = this.#site
    const file = this.#file ?? site.getScriptNameOrSourceURL() ?? site.getFileName()
    const where = `${file ?? '<anonymous>'}:${this.#line}:${this.#column}`
    const constructing = site.isConstructor()
    if (constructing) return `new ${name} (${where})`
    if (site.isToplevel()) return `${name} (${where})`
    const type = site.getTypeName()
    const method = site.getMethodName()
    let line = ''
    if (type !== null && type !== '' && !name.startsWith(type)) line += `${type}.`
    line += name
    if (
      method !== null &&
      method !== '' &&
      name.indexOf(`.${method}`) !== name.length - method.length - 1
    ) {
      line += ` [as ${method}]`
    }
    return `${line} (${where})`
  }

  getMethodName(): string | null {
    return this.#site.getMethodName()
  }

  getFileName(): string | null {
    return this.#file ?? this.#site.getFileName()
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
    return this.#file ?? this.#site.getScriptNameOrSourceURL()
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
