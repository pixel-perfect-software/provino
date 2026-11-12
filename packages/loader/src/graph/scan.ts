// The scan of one node_modules file (T2.6, Track 2 R3): its import edges. `es-module-lexer` finds
// the ES module syntax (static imports, re-exports, `import()`); one pass over `require` finds
// CommonJS edges, since the lexer has no notion of them. The scan over-approximates: a `require`
// in a comment or a string is an edge too, which inlines more, never less (B13d Gap 13). What it
// cannot read it says so (`dynamic`): a computed or aliased `require`, `createRequire`, a file the
// lexer rejects.
import { init, parse } from 'es-module-lexer'

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

/**
 * Starts the lexer's WebAssembly build. `scanSource` works without it (the first scan compiles the
 * module synchronously); a worker awaits this once at start-up, where an `await` is free.
 * @public
 */
export async function initLexer(): Promise<void> {
  await init()
}

/** `require`, or `module.require`, as a whole word and not a property or a `typeof` operand. */
const REQUIRE = /(?<![\w$.])(?<!typeof\s+)(?:module\s*\.\s*)?require(?![\w$])/g
/** Whether a file has module syntax for the lexer: `import`/`export` as words (not `exports`). */
const MODULE_SYNTAX = /(?<![\w$])(?:import|export)(?![\w$])/

/** The index of the first character at or after `at` that is not white space or a comment. */
function skipTrivia(source: string, at: number): number {
  let i = at
  for (;;) {
    const code = source.charCodeAt(i)
    if (code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12) {
      i++
    } else if (code === 47) {
      const next = source.charCodeAt(i + 1)
      if (next === 42) {
        const end = source.indexOf('*/', i + 2)
        if (end === -1) return source.length
        i = end + 2
      } else if (next === 47) {
        const end = source.indexOf('\n', i + 2)
        if (end === -1) return source.length
        i = end + 1
      } else return i
    } else return i
  }
}

/**
 * The literal specifier of a `require(` whose `(` is at `open`, with the index after its `)` or
 * `,`; `null` when the argument is not a plain string.
 */
function literalAfter(
  source: string,
  open: number,
): { readonly specifier: string; readonly end: number } | null {
  const start = skipTrivia(source, open + 1)
  const quote = source[start]
  if (quote !== "'" && quote !== '"' && quote !== '`') return null
  let end = start + 1
  for (; end < source.length; end++) {
    const char = source[end]
    if (char === quote) break
    if (char === '\\' || char === '\n' || (quote === '`' && char === '$')) return null
  }
  if (end >= source.length) return null
  const after = skipTrivia(source, end + 1)
  const closer = source[after]
  if (closer !== ',' && closer !== ')') return null
  return { specifier: source.slice(start + 1, end), end: after + 1 }
}

/**
 * The edges of `source`. A file the lexer can't parse (it holds syntax no engine would run) is
 * `dynamic`, and still gets its `require` edges.
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
  if (MODULE_SYNTAX.test(source)) {
    try {
      const [imports] = parse(source)
      for (const found of imports) {
        if (found.type === 'import-meta') continue
        if (found.type === 'dynamic') {
          if (found.specifier === undefined || found.glob) dynamic = true
          else add(found.specifier, 'import')
        } else if (!found.typeOnly) add(found.specifier, 'import')
      }
    } catch {
      // Its ES edges are lost: say so, and let the `require` scan below still apply.
      dynamic = true
    }
  }
  if (source.includes('createRequire')) dynamic = true
  if (source.includes('require')) {
    REQUIRE.lastIndex = 0
    for (let match = REQUIRE.exec(source); match !== null; match = REQUIRE.exec(source)) {
      const at = skipTrivia(source, REQUIRE.lastIndex)
      const next = source[at]
      // `require.resolve`, `require.cache`: not a load.
      if (next === '.') continue
      // A bare `require` handed on (`const r = require`) is a call the scan can't follow.
      if (next !== '(') {
        dynamic = true
        continue
      }
      const literal = literalAfter(source, at)
      if (literal === null) {
        dynamic = true
        continue
      }
      add(literal.specifier, 'require')
      REQUIRE.lastIndex = literal.end
    }
  }
  return { edges, dynamic }
}
