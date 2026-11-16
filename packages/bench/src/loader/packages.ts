// Generated packages for the loader benches: one way to put a package into a project's
// `node_modules`.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Writes the package `name` into `<root>/node_modules/<name>`: a `package.json` (with `main` when
 * one is given) and `files`, keyed by their path inside the package.
 */
export function writePackage(
  root: string,
  name: string,
  files: Iterable<readonly [string, string]>,
  main?: string,
): void {
  const dir = join(root, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  const manifest = main === undefined ? { name } : { name, main }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest)}\n`)
  const made = new Set<string>([dir])
  for (const [path, text] of files) {
    const file = join(dir, path)
    const parent = dirname(file)
    if (!made.has(parent)) {
      mkdirSync(parent, { recursive: true })
      made.add(parent)
    }
    writeFileSync(file, text)
  }
}
