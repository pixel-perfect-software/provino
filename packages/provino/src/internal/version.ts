import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * This package's version, from its own `package.json` (reached through the package's `exports`,
 * so source and build both find it).
 * @internal
 */
export function packageVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(fileURLToPath(import.meta.resolve('provino/package.json')), 'utf8'),
  )
  if (typeof manifest === 'object' && manifest !== null && 'version' in manifest) {
    if (typeof manifest.version === 'string') return manifest.version
  }
  throw new Error('the package.json of "provino" has no version')
}
