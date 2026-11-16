// Reading a file's text, and the one rewrite every wrapper of a source needs.
import { readFileSync } from 'node:fs'

/** The text of the file at `path`, or `undefined` when it can't be read (Node meets that too). */
export function readSource(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * `source` with a hashbang made a line comment of the same length: a hashbang is legal only at the
 * start of a script or module, and a wrapper puts the body inside a function. The length is kept, so
 * columns, source maps and V8 coverage offsets hold.
 */
export function blankHashbang(source: string): string {
  return source.startsWith('#!') ? `//${source.slice(2)}` : source
}

/** The parameters of Node's CommonJS wrapper, in order (`vm.compileFunction` takes a mutable array). */
export const CJS_WRAPPER: string[] = ['exports', 'require', 'module', '__filename', '__dirname']

/** The same as a parameter list. */
export const CJS_PARAMS: string = CJS_WRAPPER.join(', ')
