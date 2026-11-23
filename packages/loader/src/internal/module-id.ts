// What a module id says beyond its file: a query or fragment the specifier carried, and the URL
// schemes the loader reads itself (`data:`) or leaves to Node.
import { statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** The scheme of a module whose source is its own URL (`recordFor` decodes it). */
export const DATA: string = 'data:'

/**
 * A URL a `module.registerHooks` hook may serve: any scheme but `file:` and `node:` (whose misses
 * keep the dialect's not-found text) and `data:` (a user module). Two letters at least, so a
 * Windows drive (`C:\\`) is no scheme.
 */
export const HOOKED_URL: RegExp = /^(?!file:|node:|data:)[a-z][a-z\d+.-]+:/i

/** Where a module id's query or fragment starts (`./x.ts?v`, `./x.ts#f`), in its last segment. */
function suffixStart(id: string): number {
  const segment = Math.max(id.lastIndexOf('/'), id.lastIndexOf('\\')) + 1
  const query = id.indexOf('?', segment)
  const fragment = id.indexOf('#', segment)
  if (query === -1) return fragment
  return fragment === -1 ? query : Math.min(query, fragment)
}

/**
 * The file a module id reads. The resolver keeps a specifier's query or fragment on the path it
 * finds (`import('./x.ts?v')`), so, as in Node, two URLs of one file are two modules, each
 * evaluated once, that read the same file. A file whose name holds the `?` or `#` is that file.
 * Only an id with either character pays for the `stat` (speed).
 */
export function fileOf(id: string): string {
  if (id.startsWith(DATA)) return id
  const at = suffixStart(id)
  if (at === -1 || statSync(id, { throwIfNoEntry: false }) !== undefined) return id
  return id.slice(0, at)
}

/**
 * A module id's URL, its query or fragment kept as written (Node's `import.meta.url`). `path` is
 * the id's file when the caller holds it (`ModuleRecord.path`), so `fileOf` doesn't run again.
 */
export function urlOf(id: string, path: string = fileOf(id)): string {
  if (id.startsWith(DATA)) return id
  return pathToFileURL(path).href + id.slice(path.length)
}
