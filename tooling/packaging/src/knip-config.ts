import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `ignoreDependencies` of one workspace in `knip.jsonc`. The file is JSON with `//` comments on
 * lines of their own; a `//` inside a string (the `$schema` URL) is left alone.
 * @internal
 */
export function knipIgnoredDependencies(root: string, workspace: string): readonly string[] {
  const text = readFileSync(join(root, 'knip.jsonc'), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
  const config: unknown = JSON.parse(text)
  const workspaces =
    typeof config === 'object' && config !== null && 'workspaces' in config
      ? config.workspaces
      : undefined
  const entry =
    typeof workspaces === 'object' && workspaces !== null
      ? (workspaces as Record<string, unknown>)[workspace]
      : undefined
  const ignored =
    typeof entry === 'object' && entry !== null && 'ignoreDependencies' in entry
      ? entry.ignoreDependencies
      : undefined
  return Array.isArray(ignored)
    ? ignored.filter((name): name is string => typeof name === 'string')
    : []
}

/** The package name of an import specifier: `@scope/name/sub` is `@scope/name`. */
function packageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('node:') || specifier.startsWith('/')) {
    return undefined
  }
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/**
 * The packages the TypeScript files under `dirs` import: `from '<pkg>'`, `import '<pkg>'`,
 * `import('<pkg>')` and `require.resolve('<pkg>')`, found by text. Build output and `.tsc` are skipped.
 * @internal
 */
export function importedPackages(root: string, dirs: readonly string[]): ReadonlySet<string> {
  const found = new Set<string>()
  const specifier = /(?:\bfrom\s+|\bimport\s+|\bimport\(\s*|\.resolve\(\s*)['"]([^'"]+)['"]/g
  for (const dir of dirs) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true, recursive: true })) {
      const path = join(entry.parentPath, entry.name)
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
      if (/[\\/](?:\.tsc|dist|node_modules)[\\/]/.test(path)) continue
      for (const match of readFileSync(path, 'utf8').matchAll(specifier)) {
        const name = packageName(match[1] ?? '')
        if (name !== undefined) found.add(name)
      }
    }
  }
  return found
}

/**
 * `knip.jsonc`'s ignore list for `provino` against what `provino` declares. `provino` inlines
 * other packages, so most of its dependencies are imported by their code, not by its own files,
 * and knip needs each of those ignored. A dependency its own files don't import and knip doesn't
 * ignore passes only while a build's `dist/*.d.ts` imports it, which knip reads when it is there
 * (`pnpm knip` on a fresh checkout then fails). An ignore entry for something `provino` neither
 * lists nor imports is stale.
 * @internal
 */
export function knipUmbrellaProblems(input: {
  readonly declared: readonly string[]
  readonly ignored: readonly string[]
  readonly imported: ReadonlySet<string>
}): readonly string[] {
  const ignored = new Set(input.ignored)
  const declared = new Set(input.declared)
  return [
    ...input.declared
      .filter((name) => !ignored.has(name) && !input.imported.has(name))
      .map(
        (name) =>
          `provino lists ${name}, which none of its own files imports and knip.jsonc doesn't ignore: knip passes only while a build's dist/*.d.ts imports it`,
      ),
    ...input.ignored
      .filter((name) => !declared.has(name) && !input.imported.has(name))
      .map(
        (name) =>
          `knip.jsonc ignores ${name} for packages/provino, but provino neither lists nor imports it`,
      ),
  ]
}
