// Reading the built package (`dist/`) for the bundle checks: every built file, the files one
// imports, and the chunks a definition marks. Shared by `exports.test.ts` and `native-load.test.ts`.
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'

/** This package's `dist/`. */
export const DIST: string = fileURLToPath(new URL('../dist', import.meta.url))

/**
 * Every built file (the chunks, the entries, the worker's and `internal/`'s, B27f), by path relative
 * to `dist/`, through every directory: an add-on's `dist` (D187) has one per subpath.
 */
export function builtSources(dist: string = DIST, extension = '.js'): Map<string, string> {
  const sources = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(dist, dir), { withFileTypes: true })) {
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith(extension))
        sources.set(path, readFileSync(join(dist, path), 'utf8'))
    }
  }
  walk('')
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

/** Each add-on's `dist` (D187), by its real path, through this package's workspace links. */
export const ADD_ON_DISTS: Readonly<Record<string, string>> = Object.fromEntries(
  ['dialect-jest', 'dialect-vitest'].map((name) => [
    name,
    realpathSync(fileURLToPath(new URL(`../node_modules/@provino/${name}/dist`, import.meta.url))),
  ]),
)

/** One import or re-export of a module a built file makes, and the names it takes (`default`, `*`). */
export interface ModuleRequest {
  readonly specifier: string
  readonly names: readonly string[]
  readonly kind: 'static' | 'dynamic'
}

/**
 * What `source` (a built file) imports and re-exports, read by Oxc's parser rather than a regular
 * expression: `import { a as b }`, `import d`, `import * as n`, `export { x } from`, `export * from`
 * and `import("…")` of a string, whatever the quotes or the layout.
 */
export function moduleRequests(path: string, source: string): ModuleRequest[] {
  const { module } = parseSync(path, source)
  const nameOf = (name: { readonly kind: string; readonly name: string | null }): string =>
    name.kind === 'Default' ? 'default' : name.kind === 'Name' ? (name.name ?? '') : '*'
  const out: ModuleRequest[] = module.staticImports.map((entry) => ({
    specifier: entry.moduleRequest.value,
    names: entry.entries.filter((item) => !item.isType).map((item) => nameOf(item.importName)),
    kind: 'static',
  }))
  for (const entry of module.staticExports) {
    for (const item of entry.entries) {
      if (item.moduleRequest === null || item.isType) continue
      out.push({
        specifier: item.moduleRequest.value,
        names: [nameOf(item.importName)],
        kind: 'static',
      })
    }
  }
  for (const entry of module.dynamicImports) {
    const text = source.slice(entry.moduleRequest.start, entry.moduleRequest.end).trim()
    const literal = /^(["'`])([^"'`]*)\1$/.exec(text)?.[2]
    if (literal !== undefined) out.push({ specifier: literal, names: ['*'], kind: 'dynamic' })
  }
  return out
}

/** Every string a built file's code holds (literals and template text, never a comment), by Oxc's parser. */
export function stringLiterals(path: string, source: string): string[] {
  const found: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (typeof node !== 'object' || node === null) return
    const type: unknown = Reflect.get(node, 'type')
    const value: unknown = Reflect.get(node, 'value')
    if (type === 'Literal' && typeof value === 'string') found.push(value)
    if (type === 'TemplateElement') {
      const cooked: unknown = Reflect.get(Reflect.get(node, 'value') ?? {}, 'cooked')
      if (typeof cooked === 'string') found.push(cooked)
    }
    for (const key of Object.keys(node)) if (key !== 'type') walk(Reflect.get(node, key))
  }
  walk(parseSync(path, source).program)
  return found
}
