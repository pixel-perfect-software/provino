// Reading a file's text, and the one rewrite every wrapper of a source needs.
import { readFileSync } from 'node:fs'
import { LoaderError } from '../errors.ts'

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

/** Node's reading of a `data:` URL's path (`internal/modules/esm/load`): MIME type, base64 or not, body. */
const DATA_URL = /^([^/]+\/[^;,]+)(?:[^,]*?)(;base64)?,([\s\S]*)$/

/** A `data:` URL's MIME type and its body as text, base64 or percent-encoded; `null` when it is none. */
export function decodeDataUrl(
  url: string,
): { readonly mime: string; readonly text: string } | null {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return null
  }
  const match = DATA_URL.exec(pathname)
  if (match === null) return null
  const body = decodeURIComponent(match[3] ?? '')
  const text = Buffer.from(body, match[2] === undefined ? 'utf8' : 'base64').toString('utf8')
  return { mime: match[1] ?? '', text }
}

/**
 * The source of a `data:` module and whether it is JSON: only the types Node's default loader takes
 * as source, `text/javascript` and `application/json`; any other is `LOADER_UNSUPPORTED_MODULE`.
 */
export function dataSource(url: string): { readonly json: boolean; readonly text: string } {
  const decoded = decodeDataUrl(url)
  const mime = decoded?.mime
  if (decoded === null || (mime !== 'text/javascript' && mime !== 'application/json')) {
    throw new LoaderError(
      'LOADER_UNSUPPORTED_MODULE',
      `cannot load a data: URL of type ${mime ?? 'unknown'} as a module`,
    )
  }
  return { json: mime === 'application/json', text: decoded.text }
}
