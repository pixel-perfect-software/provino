import { relative, sep } from 'node:path'

/**
 * `path` with `/` between its parts whatever the platform: a native path (Windows's `\`) becomes a
 * POSIX one, and on a POSIX host a backslash stays, as part of a name. `separator` is the
 * platform's, given by tests.
 */
export function toPosix(path: string, separator: string = sep): string {
  return separator === '/' ? path : path.split(separator).join('/')
}

/** `path` relative to `root`, with `/` between the parts whatever the platform. */
export function posixRelative(root: string, path: string): string {
  return toPosix(relative(root, path))
}
