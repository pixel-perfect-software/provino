import type { UserConfig } from 'tsdown/config'
import { type PackageManifest, readManifest, runtimeDependencyNames } from './package-json.ts'

/**
 * The options every Provino package is built with (T1.6): ESM only, for Node 22.15 and up, with
 * declarations from Oxc's isolated-declarations generator (the repo compiles with
 * `isolatedDeclarations`, so every public type is written out). Declared dependencies stay
 * external and nothing else may be bundled, so a package that imports what it doesn't declare
 * fails its build instead of shipping a hidden copy.
 * @internal
 */
export const PRESET: UserConfig = {
  format: 'esm',
  platform: 'node',
  target: 'node22.15',
  dts: { generator: 'oxc', sourcemap: false },
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  // `"type": "module"` in every package, so `.js` and `.d.ts` are ESM and the `exports` read plainly.
  fixedExtension: false,
  // Stable chunk names: a rebuild of the same source gives the same files.
  hash: false,
  treeshake: true,
  minify: false,
}

/** Declarations only, from Oxc's generator: a types-only package, and the umbrella's second build. */
export const DTS_ONLY: Exclude<UserConfig['dts'], boolean | undefined> = {
  generator: 'oxc',
  sourcemap: false,
  emitDtsOnly: true,
}

/** One subpath of a package's `exports`: where its source is, and what the build writes. */
export interface PackageEntry {
  /** The `exports` key: `.` or `./node`. */
  readonly subpath: string
  /** The entry's name in `dist/`: `index`, `node/index`. */
  readonly name: string
  /** The source file the `provino-source` condition names, relative to the package. */
  readonly source: string
  /** No `import` condition: the entry is declarations only, as `@provino/types` is (T1.2). */
  readonly typesOnly: boolean
}

const SOURCE = /^\.\/(src\/.+\.ts)$/
const BUILT = /^\.\/dist\/(.+)\.js$/
const TYPES = /^\.\/dist\/(.+)\.d\.ts$/

/**
 * The entries of a package, read from its `exports`: each subpath with a `provino-source` `.ts`
 * file is built to the file its `import` condition names, and its `types` condition must name
 * that file's `.d.ts`. A subpath with no `import` condition is declarations only: `types` names
 * `./dist/<name>.d.ts` and nothing is written for JavaScript. A package is one or the other. A subpath whose `provino-source` isn't a `.ts` file (`./package.json`) is
 * not built. `exports` is the one place that says what a package ships, so this never guesses.
 * @internal
 */
export function entriesOf(manifest: PackageManifest): readonly PackageEntry[] {
  const entries: PackageEntry[] = []
  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    const source = SOURCE.exec(conditions['provino-source'] ?? '')?.[1]
    if (source === undefined) continue
    const typesOnly = conditions.import === undefined
    const name = (
      typesOnly ? TYPES.exec(conditions.types ?? '') : BUILT.exec(conditions.import ?? '')
    )?.[1]
    if (name === undefined) {
      throw new Error(
        `${manifest.name}: exports["${subpath}"] needs an "import" condition of the form ./dist/<name>.js (got ${JSON.stringify(conditions.import)}), or a "types" one of the form ./dist/<name>.d.ts and no "import"`,
      )
    }
    if (conditions.types !== `./dist/${name}.d.ts`) {
      throw new Error(
        `${manifest.name}: exports["${subpath}"].types must be ./dist/${name}.d.ts (got ${JSON.stringify(conditions.types)})`,
      )
    }
    entries.push({ subpath, name, source, typesOnly })
  }
  if (new Set(entries.map((entry) => entry.typesOnly)).size > 1) {
    throw new Error(`${manifest.name}: some exports have an "import" condition and some have none`)
  }
  return entries
}

/**
 * The tsdown config for the package in `dir`: the preset, one entry per source subpath, and the
 * package's own declared dependencies as the only imports its output may keep.
 * @internal
 */
export function packageConfig(dir: string): UserConfig {
  const manifest = readManifest(dir)
  const entries = entriesOf(manifest)
  if (entries.length === 0) throw new Error(`${manifest.name} has no exports with a source file`)
  const typesOnly = entries.every((entry) => entry.typesOnly)
  return {
    ...PRESET,
    // A types-only package writes declarations and no JavaScript.
    ...(typesOnly ? { dts: DTS_ONLY } : {}),
    // The config file lives elsewhere, so say which package this is.
    cwd: dir,
    entry: Object.fromEntries(entries.map((entry) => [entry.name, entry.source])),
    deps: {
      // Every dependency a package imports is declared, so none is bundled from node_modules.
      onlyBundle: [],
      // A subpath entry may import its own package by name (a self-reference, which keeps one copy).
      onlyImport: [manifest.name, ...runtimeDependencyNames(manifest)],
    },
  }
}
