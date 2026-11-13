import { relative, sep } from 'node:path'

/** `path` relative to `root`, with `/` between the parts whatever the platform. */
export function posixRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}
