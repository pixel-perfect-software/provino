import { fileURLToPath } from 'node:url'

/**
 * A `file:` URL as a path; anything else as it is (V8 names a `vm` script by either, and Node
 * prints a mapped frame's file as a path).
 * @internal
 */
export function pathOfUrl(url: string): string {
  return url.startsWith('file:') ? fileURLToPath(url) : url
}
