// The `node_modules` files a project's transform takes (B23e, D115, D130): which of them Node can
// load itself (`native`, shared by the worker) and which it can't (`user`, transformed and
// evaluated per file, as Jest does). The state is its own, as `reevaluate.ts`'s and `edge-kind.ts`'s
// are: it holds what a verdict reads and nothing of the records.
import { extname } from 'node:path'
import { compileFunction } from 'node:vm'
import { ignoreRegExp } from '@provino/transform'
import type { LoaderOptions } from '@provino/types'
import { LoaderError } from '../errors.ts'
import { esmSyntaxOf } from '../graph/index.ts'
import { type EdgeKindState, packageTypeAt } from './edge-kind.ts'
import type { InlineState } from './inline.ts'
import { blankHashbang, CJS_WRAPPER, readSource } from './source.ts'
import { type InlineRules, isThirdParty } from './third-party.ts'

/**
 * What the claims make of a `node_modules` file: no transform's (`ignored`), a transform's but
 * loaded by Node (`native`: CommonJS that Node can parse, as far as is known), or a user module
 * (`user`: transformed and evaluated per file).
 */
export type ClaimVerdict = 'ignored' | 'native' | 'user'

/** `LoaderOptions.transformClaims`, compiled once per worker, and what its verdicts read. */
export interface ClaimsState {
  readonly edgeKinds: EdgeKindState
  /** The graph (its nodes know a file's syntax) and the claimed-reach verdicts. */
  readonly inline: InlineState
  readonly inlineRules: InlineRules
  /** Natively required values of shared externals (`Records.required`): the loads made so far. */
  readonly required: ReadonlyMap<string, unknown>
  /** Native namespaces of shared externals (`Records.externals`). */
  readonly externals: ReadonlyMap<string, object>
  readonly patterns: readonly RegExp[]
  /** The ignore patterns joined with `|`, as Jest joins them; `null` for none. */
  readonly ignore: RegExp | null
  /** Each `node_modules` file asked about. A `native` one becomes `user` when Node can't parse it. */
  readonly verdicts: Map<string, ClaimVerdict>
  /**
   * The files whose verdict is `user`: seeds of the per-file set (D132). Append-only, written by
   * `markUser` alone, since the set reads its length as a watermark of the seeds it has taken.
   */
  readonly users: string[]
}

/** Gives `path` the verdict `user`, and makes it a seed of the per-file set. */
function markUser(claims: ClaimsState, path: string): void {
  claims.verdicts.set(path, 'user')
  claims.users.push(path)
}

function compiled<T>(what: string, make: () => T): T {
  try {
    return make()
  } catch (cause) {
    throw new LoaderError(
      'LOADER_INVALID_TRANSFORM_CLAIMS',
      `transformClaims.${what} is not a regular expression: ${(cause as Error).message}`,
      { cause },
    )
  }
}

/** The claims of `options`, or `null` for none. A pattern that is no regular expression is refused. */
export function compileClaims(
  options: LoaderOptions,
  shared: Pick<ClaimsState, 'edgeKinds' | 'inline' | 'inlineRules' | 'required' | 'externals'>,
): ClaimsState | null {
  const claims = options.transformClaims
  if (claims === undefined || claims.patterns.length === 0) return null
  const patterns = claims.patterns.map((pattern, index) =>
    compiled(`patterns[${index}]`, () => new RegExp(pattern)),
  )
  const ignore = compiled('ignorePatterns (joined with "|")', () =>
    ignoreRegExp(claims.ignorePatterns),
  )
  return { ...shared, patterns, ignore, verdicts: new Map(), users: [] }
}

/**
 * The extensions Node loads without a transform (none is a `.js`-like file too). A claimed file
 * with any other extension (`.ts`, `.tsx`, `.jsx`, `.css`, `.svg`, `.md`) is a user module
 * whatever its text holds: Node strips no types under `node_modules`, runs no JSX, and a `.css`
 * file it `require`s is a `SyntaxError`; Jest runs the transform on every claimed file.
 */
const NODE_EXTENSIONS: ReadonlySet<string> = new Set([
  '',
  '.js',
  '.cjs',
  '.mjs',
  '.json',
  '.node',
  '.wasm',
])

/** Loaded by Node, and never source text: no syntax to read in an addon, WebAssembly or JSON file. */
const NEVER_READ: ReadonlySet<string> = new Set(['.json', '.node', '.wasm'])

/**
 * Whether the file at `path` has ES module syntax, as Node decides a format: `.mjs` does, `.cjs`
 * doesn't, a `.js` under a `"type": "module"` package does, and any other file by its source
 * (`import`/`export` or `import.meta`, as Node's detection reads an ambiguous `.js`), from the
 * graph when it has scanned the file, else from the file. A file the lexer rejects counts as ESM:
 * Node can't run it either. Called once per file a transform takes.
 */
function isEsmFile(claims: ClaimsState, path: string, extension: string): boolean {
  if (extension === '.mjs') return true
  if (extension === '.cjs') return false
  if (extension === '.js' && packageTypeAt(claims.edgeKinds, path) === 'module') return true
  const node = claims.inline.graph?.nodeOf(path)
  if (node !== undefined) return node.esm
  const source = readSource(path)
  // Unreadable: Node meets the same failure when it loads it.
  return source === undefined ? false : (esmSyntaxOf(source) ?? true)
}

/**
 * What the claims make of a `node_modules` file (B23e, D115): a transform takes it when a rule's
 * pattern matches its real path and no ignore pattern does (Jest's
 * `ScriptTransformer.shouldTransform`), and it is transformed only when Node can't load it
 * natively: an extension Node doesn't run as JavaScript (`NODE_EXTENSIONS`), or ES module syntax,
 * whose imports Jest resolves as `require`s. A CommonJS file a transform takes is `native`, shared
 * and loaded by Node, until its native load fails to parse (`demoteOnParseFailure`). One regular
 * expression test for a file the ignore patterns opt out, and each verdict is kept for the worker.
 */
function claimVerdict(claims: ClaimsState, path: string): ClaimVerdict {
  let verdict = claims.verdicts.get(path)
  if (verdict === undefined) {
    if (claims.ignore?.test(path) === true || !claims.patterns.some((p) => p.test(path))) {
      verdict = 'ignored'
    } else {
      const extension = extname(path)
      verdict =
        !NODE_EXTENSIONS.has(extension) ||
        (!NEVER_READ.has(extension) && isEsmFile(claims, path, extension))
          ? 'user'
          : 'native'
    }
    if (verdict === 'user') markUser(claims, path)
    else claims.verdicts.set(path, verdict)
  }
  return verdict
}

/**
 * The verdict for `path`, or `undefined` when it is not a third-party file (an `inline` rule names
 * it, or it is outside `node_modules`). A path asked about before skips the third-party test: only
 * third-party paths have a verdict.
 */
function thirdPartyVerdict(claims: ClaimsState, path: string): ClaimVerdict | undefined {
  return (
    claims.verdicts.get(path) ??
    (isThirdParty(path, claims.inlineRules) ? claimVerdict(claims, path) : undefined)
  )
}

/**
 * Whether a `node_modules` file is a user module because a transform takes it, so a shared
 * external whose closure reaches it is inlined too (`claimedReach`): loaded natively, it would
 * `require` Node's copy, a second instance, or a crash on what the transform resolves.
 */
export function isClaimedUserModule(claims: ClaimsState, path: string): boolean {
  return thirdPartyVerdict(claims, path) === 'user'
}

/**
 * Whether a resolved file loads natively, shared by the worker: a `node_modules` file `inline`
 * doesn't name and no transform takes as a user module. (An addon is the caller's own test.)
 */
export function isClaimedExternal(claims: ClaimsState, path: string): boolean {
  const verdict = thirdPartyVerdict(claims, path)
  return verdict !== undefined && verdict !== 'user'
}

/**
 * What an edge to the external at `path` has to do about the claims, from one read of its verdict:
 * `user` (a claimed file that became a user module since it was resolved), `untried` (a claimed
 * file Node loads that has not loaded yet in this worker: load it now, so a native load Node can't
 * parse turns it into a user module before the edge takes its route), or `native`.
 */
export function claimedLoad(claims: ClaimsState, path: string): 'user' | 'untried' | 'native' {
  const verdict = claims.verdicts.get(path)
  if (verdict === 'user') return 'user'
  if (verdict === 'native' && !claims.required.has(path) && !claims.externals.has(path)) {
    return 'untried'
  }
  return 'native'
}

/** Whether `error` is a `SyntaxError`, by name as jest-runtime tests it (any realm's). */
function isSyntaxError(error: unknown): boolean {
  return error instanceof Error && error.name === 'SyntaxError'
}

/**
 * Whether the file at `path` compiles as Node compiles a CommonJS module (its wrapper, a hashbang
 * and a byte order mark dropped). A file that can't be read is taken to: its load's error stands.
 */
function compilesAsCommonJs(path: string): boolean {
  let source = readSource(path)
  if (source === undefined) return true
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1)
  try {
    compileFunction(blankHashbang(source), CJS_WRAPPER, { filename: path })
    return true
  } catch (error) {
    return !isSyntaxError(error)
  }
}

/**
 * Handles the native load of a `native` claimed file throwing `error`: whether it threw because
 * Node can't parse the file (JSX, Flow or TypeScript syntax in a CommonJS `.js` file: a React
 * Native package under `transformIgnorePatterns: ['node_modules/(?!react-native/)']`). Nothing of it
 * ran, so it becomes a user module for the worker (transformed, and evaluated per file; the
 * verdicts it changes are the walk's, cleared), and the edge takes that route. A `SyntaxError` the
 * module's own code threw (`JSON.parse`, `new Function`) leaves it `native`: it ran, and running it
 * again would repeat what it did. So would a file that requires a module Node can't parse: the
 * error is that module's, and the file itself parses. Asked only after a native load threw, so a
 * load that works pays nothing; the compile is once per file that threw.
 */
export function demoteOnParseFailure(claims: ClaimsState, path: string, error: unknown): boolean {
  if (!isSyntaxError(error) || !/\.c?js$/.test(path) || compilesAsCommonJs(path)) return false
  markUser(claims, path)
  claims.inline.claimed.clear()
  return true
}
