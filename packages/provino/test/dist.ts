// Reading the built package (`dist/`) for the bundle checks: every built file, the files one
// imports, and the chunks a definition marks. Shared by `exports.test.ts` and `native-load.test.ts`.
import { readdirSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This package's `dist/`. */
export const DIST: string = fileURLToPath(new URL('../dist', import.meta.url))

/** Every built file (the chunks, the entries and the worker's), by path relative to `dist/`. */
export function builtSources(dist: string = DIST): Map<string, string> {
  const sources = new Map<string, string>()
  for (const dir of ['', 'worker']) {
    for (const file of readdirSync(join(dist, dir)).filter((name) => name.endsWith('.js'))) {
      const path = dir === '' ? file : `${dir}/${file}`
      sources.set(path, readFileSync(join(dist, path), 'utf8'))
    }
  }
  return sources
}

/** The built files `source` (at `from`) imports with a static `import`/`export … from`, multiline included. */
export function staticImports(from: string, source: string): string[] {
  const targets = [
    ...source.matchAll(/\bfrom\s*["'](\.{1,2}\/[^"']+)["']/g),
    ...source.matchAll(/\bimport\s*["'](\.{1,2}\/[^"']+)["']/g),
  ].map((match) => match[1] ?? '')
  return targets.map((target) => posix.normalize(posix.join(posix.dirname(from), target)))
}

/** The built files `source` reaches with a dynamic `import("./…")`. */
export function dynamicImports(from: string, source: string): string[] {
  return [...source.matchAll(/\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)].map((match) =>
    posix.normalize(posix.join(posix.dirname(from), match[1] ?? '')),
  )
}

/** The files that define something `defines` finds, then any file that imports only files already in the set. */
export function chunkFiles(sources: ReadonlyMap<string, string>, defines: RegExp): Set<string> {
  const found = new Set<string>()
  for (const [path, source] of sources) {
    if (defines.test(source)) found.add(path)
  }
  for (let grew = true; grew; ) {
    grew = false
    for (const [path, source] of sources) {
      const imports = staticImports(path, source)
      if (!found.has(path) && imports.length > 0 && imports.every((file) => found.has(file))) {
        found.add(path)
        grew = true
      }
    }
  }
  return found
}
