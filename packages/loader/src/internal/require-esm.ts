// The error for a shared external whose native load threw on an ES module (`require-esm`).
import type { LoaderOptions } from '@provino/types'
import { RequireEsmError } from '../errors.ts'
import { esmSyntaxOf, inGraph } from '../graph/index.ts'
import { type EdgeKindState, isExplicitlyCommonjs } from './edge-kind.ts'
import { loaderMessage } from './messages.ts'
import { readSource } from './source.ts'

/** Files that are never source text: an addon or WebAssembly module (binary), JSON (data). */
const NEVER_SOURCE: RegExp = /\.(?:node|wasm|json)$/

/**
 * The error for a shared external whose native load threw (`require-esm`), as jest-runtime's
 * `CjsLoader` raises it (L171-L180, `createRequireEsmError` L336-L349): the dialect's text when the
 * file has ES module syntax (`esmSyntaxOf`, a file the lexer rejects counting as none), is not
 * explicitly CommonJS (`.cjs`, or `"type": "commonjs"` for a `.js`), and Node can't evaluate an ES
 * module graph synchronously (`supportsSyncEvaluate`, where Jest loads it as an ES module instead).
 * `undefined` otherwise, so the load's own error stands; with it, that error is the `cause`.
 *
 * Jest's third condition, a `SyntaxError`, is its own CommonJS compile of the file, which every
 * file with ES module syntax fails: Jest never runs one. Node loads it as an ES module
 * (`require(esm)`), so its error is whatever that load met (`ERR_MODULE_NOT_FOUND` for an
 * extensionless import, `cli/transform-node-modules-ignored`), and any error stands for Jest's.
 * Read only after a load failed, so a load that works pays nothing. An addon, a WebAssembly module
 * or JSON file is never read as source.
 */
export function requireEsmError(
  options: LoaderOptions,
  edgeKinds: EdgeKindState,
  path: string,
  error: unknown,
): RequireEsmError | undefined {
  const message = loaderMessage(options.policy, 'require-esm', { path })
  if (message === undefined || !inGraph(path) || edgeKinds.runtime().syncEvaluate) {
    return undefined
  }
  if (NEVER_SOURCE.test(path) || isExplicitlyCommonjs(edgeKinds, path)) return undefined
  const source = readSource(path)
  if (source === undefined || esmSyntaxOf(source) !== true) return undefined
  return new RequireEsmError(message, { cause: error })
}
