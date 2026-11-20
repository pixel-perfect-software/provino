import { readdir } from 'node:fs/promises'
import { join, parse } from 'node:path'

/** Whether a `projects` entry has glob characters (`*` or `?`) and so names several directories. */
export function isGlob(entry: string): boolean {
  return /[*?]/.test(entry)
}

/** One path segment's glob (`*`, `?`) as a regular expression over a directory name. */
function segmentPattern(segment: string): RegExp {
  const source = segment
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${source}$`)
}

async function subdirectories(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

async function walk(
  directory: string,
  segments: readonly string[],
  found: Set<string>,
): Promise<void> {
  const [segment, ...rest] = segments
  if (segment === undefined) {
    found.add(directory)
    return
  }
  const names = await subdirectories(directory)
  if (segment === '**') {
    // Zero directories, then each one down.
    await walk(directory, rest, found)
    for (const name of names) {
      if (name !== 'node_modules' && !name.startsWith('.')) {
        await walk(join(directory, name), segments, found)
      }
    }
    return
  }
  const pattern = segmentPattern(segment)
  for (const name of names) {
    // A wildcard never reaches `node_modules` or a dot directory; a segment that names one does.
    if (isGlob(segment) && (name === 'node_modules' || name.startsWith('.'))) continue
    if (pattern.test(name)) await walk(join(directory, name), rest, found)
  }
}

/**
 * The directories a glob names (`*`, `?`, `**`), from `base` (the glob's own root when it is
 * absolute), sorted. No `node_modules` and no dot directory is entered by a wildcard.
 */
export async function matchDirectories(base: string, pattern: string): Promise<string[]> {
  const root = parse(pattern).root
  const relative = pattern.slice(root.length)
  const segments = relative.split('/').filter((segment) => segment !== '' && segment !== '.')
  const found = new Set<string>()
  await walk(root === '' ? base : root, segments, found)
  return [...found].sort()
}
