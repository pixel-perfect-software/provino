import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * This package's own `package.json`, as a path (reached through the package's `exports`, so source
 * and build both find it).
 * @internal
 */
export function ownManifestPath(): string {
  return fileURLToPath(import.meta.resolve('provino/package.json'))
}

/**
 * The `version` of the `package.json` at `path`, or `undefined` when it has none.
 * @internal
 */
export function versionOf(path: string): string | undefined {
  const manifest: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof manifest === 'object' && manifest !== null && 'version' in manifest) {
    if (typeof manifest.version === 'string') return manifest.version
  }
  return undefined
}

let version: string | undefined

/**
 * This package's version, read once.
 * @internal
 */
export function packageVersion(): string {
  version ??= versionOf(ownManifestPath())
  if (version === undefined) throw new Error('the package.json of "provino" has no version')
  return version
}
