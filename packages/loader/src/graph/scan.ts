// The scan of one node_modules file (T2.6, Track 2 R3): its import edges. `es-module-lexer` finds
// the ES module syntax (static imports, re-exports, `import()`); a scan for `require('…')` finds
// CommonJS edges, since the lexer has no notion of them. The scan over-approximates: a `require`
// in a comment or a string is an edge too, which inlines more, never less (B13d Gap 13).
import { init, parse as parseWasm } from 'es-module-lexer'
import { parse as parseAsm } from 'es-module-lexer/js'

/**
 * How an edge resolves: as an `import` (ES syntax, `import()`) or a `require`.
 * @public
 */
export type EdgeKind = 'import' | 'require'

/**
 * One module request a file makes, with the text as written.
 * @public
 */
export interface ScannedEdge {
  readonly specifier: string
  readonly kind: EdgeKind
}

/**
 * What a file's source holds.
 * @public
 */
export interface Scan {
  readonly edges: readonly ScannedEdge[]
  /**
   * The file calls `require(…)` or `import(…)` with a specifier the scan can't read (a computed
   * one): an edge the graph can't see.
   */
  readonly dynamic: boolean
}

let wasmReady = false

/**
 * Starts the lexer's WebAssembly build. `scanSource` works without it, on the lexer's asm.js
 * build, which is slower; a worker awaits this once at start-up.
 * @public
 */
export async function initLexer(): Promise<void> {
  if (wasmReady) return
  await init
  wasmReady = true
}

const REQUIRE_LITERAL =
  /(?<![\w$.])require\s*\(\s*(?:'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`$\\\n]*)`)\s*[,)]/g
const REQUIRE_CALL = /(?<![\w$.])require\s*\(/g

/**
 * The edges of `source`. A file the lexer can't parse (it holds syntax no engine would run) still
 * gets its `require` edges.
 * @public
 */
export function scanSource(source: string): Scan {
  const edges: ScannedEdge[] = []
  const seen = new Set<string>()
  const add = (specifier: string, kind: EdgeKind): void => {
    const key = `${kind}\0${specifier}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ specifier, kind })
  }
  let dynamic = false
  // The lexer is the slow part of a scan, and a file with module syntax says so.
  if (source.includes('import') || source.includes('export')) {
    try {
      const [imports] = (wasmReady ? parseWasm : parseAsm)(source)
      for (const found of imports) {
        if (found.type === 'import-meta') continue
        if (found.type === 'dynamic') {
          if (found.specifier === undefined || found.glob) dynamic = true
          else add(found.specifier, 'import')
        } else if (!found.typeOnly) add(found.specifier, 'import')
      }
    } catch {
      // Not parseable as a module: the `require` scan below still applies.
    }
  }
  if (source.includes('require')) {
    let literals = 0
    for (const match of source.matchAll(REQUIRE_LITERAL)) {
      const specifier = match[1] ?? match[2] ?? match[3]
      if (specifier === undefined) continue
      literals++
      add(specifier, 'require')
    }
    // Every `require(` that isn't a literal call is a specifier we can't read.
    let calls = 0
    for (const _call of source.matchAll(REQUIRE_CALL)) calls++
    if (calls > literals) dynamic = true
  }
  return { edges, dynamic }
}
