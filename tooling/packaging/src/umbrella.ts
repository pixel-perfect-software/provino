import { rmSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import type { UserConfig } from 'tsdown/config'
import {
  ADD_ONS,
  augmentationTarget,
  inPackage,
  isInternalEntry,
  type PluginList,
  rewriteResolveCalls,
} from './internal-entries.ts'
import { readManifest, runtimeDependencyNames } from './package-json.ts'
import { DTS_ONLY, entriesOf, PRESET } from './preset.ts'

/**
 * The modules a worker loads by file URL (DECISIONS D21): the coordinator resolves each with
 * `import.meta.resolve('<package>/<entry>')` and the worker imports the answer. In the umbrella
 * every `@provino/*` package is inlined, so each of these is an entry of the one build, and the
 * resolve becomes a path to that entry's file (`workerRefs`). Every worker-side module then comes
 * from one chunk graph, with one copy of the engine, instead of a second copy per package.
 * @internal
 */
export const WORKER_ENTRIES: Readonly<Record<string, string>> = {
  '@provino/orchestrator/worker/bootstrap': 'worker/bootstrap',
  '@provino/orchestrator/worker/main': 'worker/main',
  '@provino/expect/table': 'worker/expect-table',
  // The dialects' own worker modules (`/runtime`, `/global-setup`, `/inline-snapshots`,
  // `/affected`) are not here since B27f (D187): each add-on ships them, and its refs name its
  // own files. Vite's alias rule as a mapper, loaded by the worker's loader when a Vitest project has aliases.
  '@provino/resolver/vite-alias': 'worker/vite-alias',
  // The Vite plugin host (B25d, T3.9), created by a worker whose project has plugins: no run
  // without them imports it, and it never imports Vite (the project's plugins do).
  '@provino/transform/vite': 'worker/vite-host',
  '@provino/policy/behaviours': 'worker/policy-behaviours',
  '@provino/env-node': 'worker/env-node',
  '@provino/env-jsdom': 'worker/env-jsdom',
  // The native runtime (B27b, D186): the served `provino` module and its globals, for a project
  // with no dialect.
  '@provino/api': 'worker/api',
}

/**
 * The add-ons' worker modules (D187), which the umbrella built until B27f: entries of the public
 * declarations pass still, and nothing else. The pass's chunk graph, and with it the names
 * Rolldown's declaration bundler gives the types its chunks share (the mangled names
 * `etc/provino.api.md` lists, D67), is then the one it was: without them every one of those
 * names moved, with no public change. Their own files are not written (`dropDeclarations`):
 * `provino` ships no such module.
 */
const DECLARATION_ONLY_ENTRIES: Readonly<Record<string, string>> = {
  '@provino/dialect-jest/runtime': 'worker/jest-runtime',
  '@provino/dialect-jest/global-setup': 'worker/jest-global-setup',
  '@provino/dialect-jest/inline-snapshots': 'worker/jest-inline-snapshots',
  '@provino/dialect-jest/affected': 'worker/jest-affected',
  '@provino/dialect-vitest/runtime': 'worker/vitest-runtime',
}

/** The registries a program fills by declaration merging, which `provino/config` exports. */
const REGISTRIES = ['DialectRegistry', 'PluginRegistry', 'ProvidedContext'] as const

/**
 * The internal declarations name the public registries instead of defining their own. An
 * augmentation merges into one interface, so a second copy (the chunks of `internal/`) would stay
 * empty for a program that augments the one `provino/config` exports and `defineConfig` reads.
 * Each registry's declaration (and its doc comment) is cut from the chunk that holds it and
 * imported from `provino/config` instead; the build fails when a registry is not found, so a
 * change to how they are declared can't bring the second copy back unseen.
 */
function sharedRegistries(): PluginList {
  return [
    {
      name: 'provino-shared-registries',
      generateBundle(_options, bundle) {
        const found = new Set<string>()
        for (const item of Object.values(bundle)) {
          if (item.type !== 'chunk' || !item.fileName.endsWith('.d.ts')) continue
          let code = item.code
          const cut: string[] = []
          for (const name of REGISTRIES) {
            const declaration = new RegExp(
              `(?:/\\*\\*(?:(?!\\*/)[\\s\\S])*?\\*/\\n)?interface ${name} \\{\\}\\n`,
            )
            if (!declaration.test(code)) continue
            code = code.replace(declaration, '')
            cut.push(name)
            found.add(name)
          }
          if (cut.length > 0) {
            item.code = `import type { ${cut.join(', ')} } from "provino/config";\n${code}`
          }
        }
        const missing = REGISTRIES.filter((name) => !found.has(name))
        if (missing.length > 0) {
          throw new Error(
            `the internal declarations hold no empty \`interface ${missing.join(', ')}\` to share with provino/config: the registries are declared another way, so update sharedRegistries`,
          )
        }
      },
    },
  ]
}

/** Drops the declaration files of `DECLARATION_ONLY_ENTRIES` from the output. */
function dropDeclarations(): PluginList {
  return [
    {
      name: 'provino-drop-declaration-only-entries',
      generateBundle(_options, bundle) {
        for (const name of Object.values(DECLARATION_ONLY_ENTRIES)) delete bundle[`${name}.d.ts`]
      },
    },
  ]
}

/**
 * The entries `table` names (specifier to entry name), each with the source the `provino-source`
 * condition of that subpath gives in its package: a subpath that moved fails here, by name.
 */
function sourcesOf(dir: string, table: Readonly<Record<string, string>>): Record<string, string> {
  const entries: Record<string, string> = {}
  for (const [specifier, name] of Object.entries(table)) {
    const [, pkg = '', rest] = /^@provino\/([^/]+)(?:\/(.+))?$/.exec(specifier) ?? []
    const subpath = rest === undefined ? '.' : `./${rest}`
    const source = entriesOf(readManifest(join(dir, '..', pkg))).find(
      (entry) => entry.subpath === subpath,
    )?.source
    if (source === undefined) {
      throw new Error(`${specifier}: ${pkg} has no "${subpath}" export with a provino-source file`)
    }
    entries[name] = posix.join('..', pkg, source)
  }
  return entries
}

/** Every `@provino/*` import is bundled from source: what the declarations build inlines. */
const PROVINO_SCOPE: RegExp[] = [/^@provino\//]

/** An add-on (D187) or one of its subpaths: an external import, reached by a dynamic import only. */
function isAddOnImport(id: string): boolean {
  return ADD_ONS.some((name) => inPackage(id, name))
}

/** What the JavaScript build inlines: every `@provino/*` package but the add-ons. */
function isEngine(id: string): boolean {
  return PROVINO_SCOPE.some((scope) => scope.test(id)) && !isAddOnImport(id)
}

/**
 * The files the bin answers `--version` and `--help` from before it imports the rest (`usage` lists
 * the reporters, which `reporter-names` holds), and `native-binding`, which says what to do when
 * Oxc's binding is missing: kept out of both chunk groups, so `dist/cli.js` and its own small
 * chunks import nothing that loads an Oxc package.
 */
const BIN_LIGHT_FILES = [
  'usage',
  'reporter-names',
  'version',
  'native-binding',
  'quick',
  'compile-cache',
  'node-loader',
]

/**
 * The umbrella's entries, name to source: the subpaths of `provino`'s own `exports`, its bin
 * (`bin` is the source, `publishConfig.bin` names the file in `dist/`), and each worker module,
 * whose source is the `provino-source` of that subpath in its package.
 * @internal
 */
export function umbrellaEntries(dir: string): Readonly<Record<string, string>> {
  const manifest = readManifest(dir)
  const entries: Record<string, string> = {}
  for (const entry of entriesOf(manifest)) entries[entry.name] = entry.source
  for (const [bin, built] of Object.entries(manifest.publishBin)) {
    const name = /^\.\/dist\/(.+)\.js$/.exec(built)?.[1]
    const source = manifest.bin[bin]?.replace(/^\.\//, '')
    if (name === undefined || source === undefined) {
      throw new Error(
        `${manifest.name}: bin "${bin}" needs a "bin" source and a publishConfig.bin of the form ./dist/<name>.js`,
      )
    }
    entries[name] = source
  }
  return { ...entries, ...sourcesOf(dir, WORKER_ENTRIES) }
}

const MARK = '__provino_ref__:'

/**
 * The coordinator's source files: nothing a worker imports. `provino`'s own files are the bin's
 * and `run()`'s; the dialect's policy values (the files that build `jestDialect`) are read by the
 * coordinator, and its `runtime` by the worker.
 */
const COORDINATOR = new RegExp(
  [
    'orchestrator[\\/]src[\\/](?!worker[\\/])',
    // The live terminal output and the HTML report are chunks of their own (`LIVE`, `HTML`),
    // loaded only when they are chosen.
    'reporters[\\/]src[\\/](?!live[\\/]|html[\\/])',
    'config[\\/]src[\\/]',
    'snapshot[\\/]src[\\/]node[\\/]',
    // provino's own files, but not the bin's light ones, nor the engine entries an add-on imports
    // (`internal/engine/`: a worker reads `internal/runtime`, so it must not import this chunk).
    `provino[\\/]src[\\/](?!internal[\\/](?:(?:${BIN_LIGHT_FILES.join('|')})\\.ts|engine[\\/]))`,
  ]
    .map((alternative) => `[\\/]packages[\\/]${alternative}`)
    .join('|'),
)

/** `BIN_LIGHT_FILES`, as a test of a module id. */
const BIN_LIGHT = new RegExp(
  [
    `[\\\\/]packages[\\\\/]provino[\\\\/]src[\\\\/]internal[\\\\/](?:${BIN_LIGHT_FILES.join('|')})\\.ts$`,
    // The compile cache the bin turns on first (T3.7): a leaf that imports only `node:` modules, and
    // the one file of the transform it shares (the `CACHEDIR.TAG` writer). The V8 code cache's
    // `cache.ts` and `pack.ts`, which only the loader uses, are `LOADING`'s (B27e): as a chunk of
    // their own they were one more file in every worker's cold start.
    `[\\\\/]packages[\\\\/]transform[\\\\/]src[\\\\/](?:v8cache[\\\\/](?:index|mode|native)\\.ts$|cache[\\\\/]store\\.ts$)`,
  ].join('|'),
)

/**
 * The loading stack: the transform, the resolver and the loader. Their third-party packages are
 * Oxc's natives (`oxc-parser`, `oxc-transform`, `oxc-resolver`), `oxc-walker`, `magic-string` and
 * `@jridgewell/*`, about 17 ms of cold import that a worker pays when it runs a file and
 * `import { expect } from 'provino'` does not. Kept in a chunk of their own, the `expect` runtime's
 * graph (`worker/jest-runtime.js` and the `shared` chunk it imports) loads none of them.
 */
const LOADING = /[\\/]packages[\\/](?:transform|resolver|loader)[\\/]src[\\/]/

/**
 * The coverage package (B23b): the Istanbul instrumenter, the collectors and the filter, with the
 * parser and the code writer they import. A worker loads it only when its project asks for
 * coverage, so it is a chunk no other code reaches without a dynamic import.
 */
const COVERAGE = /[\\/]packages[\\/]coverage[\\/]src[\\/]/

/**
 * `provino vitest`'s own file (`vitest-command.ts`, B25g): it imports the Vitest dialect's `/node`,
 * which is the add-on's (D187) and external here, so it is a chunk only `cli.ts`'s dynamic import
 * reaches: in `coordinator.js` every command would need `@provino/dialect-vitest` installed.
 */
const VITEST_NODE = /[\\/]packages[\\/]provino[\\/]src[\\/]internal[\\/]vitest-command\.ts$/

/**
 * `provino jest`'s own files (B27e): `jest-command.ts` and the files only it imports. They import
 * the Jest dialect's `/node`, which is the add-on's since B27f (D187) and stays an external import,
 * so they are a chunk that only `cli.ts`'s dynamic import reaches: `provino run` on a native
 * project loads none of it (`packages/provino/test/native-load.test.ts`), and a missing add-on is
 * found at that import (the install line). The chunk imports `coordinator.js` and `shared.js`,
 * never the other way. Watch's own files stay `WATCH`'s (priority 5, taken first).
 */
const JEST_NODE = new RegExp(
  [
    'provino[\\/]src[\\/]internal[\\/](?:jest-command|jest-reporters|jest-selection|jest-root-hint|provino-flags|select-projects)\\.ts$',
  ]
    .map((alternative) => `[\\\\/]packages[\\\\/]${alternative}`)
    .join('|'),
)

/**
 * Watch mode (B23f): the driver, its interrupt latch, the orchestrator's watch session and file
 * watcher, and Jest's watch loop rebuilt in the dialect. `provino jest` imports the driver
 * dynamically under `--watch` and `--watchAll`, so no other run reads them. The plugin error
 * and the terminal constants are the files of the loop the bin names on every run, so they stay out
 * (`plugin-error.ts`, `terminal.ts`).
 */
const WATCH = new RegExp(
  [
    'orchestrator[\\\\/]src[\\\\/]watch[\\\\/](?!.*\\.test\\.ts$)',
    'provino[\\\\/]src[\\\\/]internal[\\\\/](?:jest-watch|watch-interrupt)\\.ts$',
  ]
    .map((alternative) => `[\\\\/]packages[\\\\/]${alternative}`)
    .join('|'),
)

/**
 * The `provino` reporter (B26): `@provino/reporters/live`, the renderer and the live terminal output.
 * `provino` imports it with `await import()` only when the reporter is chosen, so a worker, the
 * `expect` import and a run with another reporter load none of it. What it shares with the other
 * reporters (`style.ts`, the error serializer) stays in `coordinator.js`, which it imports.
 */
const LIVE = /[\\/]packages[\\/]reporters[\\/]src[\\/]live[\\/](?!.*\.test\.ts$)/

/**
 * The `html` reporter (B26 Phase 5): `@provino/reporters/html`, the report's data, its document and
 * the page's script and styles. `provino` imports it with `await import()` only when `html` is
 * chosen, so a worker, the `expect` import and a run with another reporter load none of it. What it
 * shares with the other reporters (the collector, `formatErrors`, `writeAtomically`) stays in
 * `coordinator.js`, which it imports. The page's script is `renderReport` written out by
 * `Function.prototype.toString()`, so it must close over nothing: the chunk is built without
 * minification, and `packages/provino/test/exports.test.ts` runs the built page's script.
 */
const HTML = /[\\/]packages[\\/]reporters[\\/]src[\\/]html[\\/](?!.*\.test\.ts$)/

/**
 * `@provino/lazy`'s forwarders (`api.ts`) and the three leaves they import: `import 'provino'` and
 * the native runtime (`worker/api`, which serves them) both use them, and `index.js` must not reach
 * `shared.js` for them.
 */
const LAZY_API = /[\\/]packages[\\/]lazy[\\/]src[\\/](?:api|errors|slot|runtime[\\/]site)\.ts$/

/** A source file of a workspace package. */
const SHARED = /[\\/]packages[\\/][^\\/]+[\\/]src[\\/]/

/**
 * Rewrites `import.meta.resolve('@provino/…')` of a worker module into a URL of that module's
 * file in this build. Two steps: `transform` marks the call (which chunk it lands in isn't known
 * yet), `renderChunk` writes the path relative to that chunk. A `@provino/…` specifier this table
 * doesn't know fails the build: it would resolve to a package the umbrella doesn't install.
 * @internal
 */
export function workerRefs(): NonNullable<UserConfig['plugins']> {
  return [
    {
      name: 'provino-worker-refs',
      transform: {
        filter: { code: 'import.meta.resolve' },
        handler(code, id) {
          const out = rewriteResolveCalls(code, id, (specifier) => {
            if (!specifier.startsWith('@provino/')) return undefined
            const entry = WORKER_ENTRIES[specifier]
            if (entry === undefined) {
              throw new Error(
                `${id}: import.meta.resolve('${specifier}') names a package the umbrella doesn't bundle as an entry (add it to WORKER_ENTRIES; an add-on's file is the add-on's own to name, D187: take the ref from its value, which resolves its files where it is installed)`,
              )
            }
            return `new URL(${JSON.stringify(`${MARK}${entry}.js`)}, import.meta.url).href`
          })
          return out === undefined ? null : { code: out, map: null }
        },
      },
      renderChunk(code, chunk) {
        if (!code.includes(MARK)) return null
        const from = dirname(chunk.fileName)
        const out = code.replace(new RegExp(`${MARK}([^"]+)`, 'g'), (_match, file: string) => {
          const relative = posix.relative(from, file)
          return relative.startsWith('.') ? relative : `./${relative}`
        })
        return { code: out, map: null }
      },
    },
  ]
}

/**
 * The tsdown configs of the `provino` package, built in its directory: the JavaScript, then the
 * declarations. Every `@provino/*` package is inlined (from source, through `provino-source`), the
 * third-party packages the umbrella declares stay external, and nothing else may be imported by
 * the output. The two are separate builds because the chunk groups of the first would name the
 * declarations' own intermediate chunks too, and the two kinds of chunk would overwrite each other.
 * `dist` is emptied here, once, so the builds (which run together) never clean each other's files.
 * @internal
 */
export function umbrellaConfig(dir: string): UserConfig[] {
  const manifest = readManifest(dir)
  rmSync(join(dir, 'dist'), { recursive: true, force: true })
  const entries = umbrellaEntries(dir)
  const publicEntries = {
    ...Object.fromEntries(Object.entries(entries).filter(([name]) => !isInternalEntry(name))),
    ...sourcesOf(dir, DECLARATION_ONLY_ENTRIES),
  }
  const internalEntries = Object.fromEntries(
    Object.entries(entries).filter(([name]) => isInternalEntry(name)),
  )
  const common: UserConfig = {
    ...PRESET,
    cwd: dir,
    clean: false,
    entry: entries,
    inputOptions: {
      resolve: { conditionNames: ['provino-source', 'import', 'node', 'default'] },
    },
  }
  return [
    {
      ...common,
      dts: false,
      deps: {
        alwaysBundle: isEngine,
        neverBundle: (id: string) => isAddOnImport(id),
        // Nothing from node_modules is bundled: the `@provino/*` packages are workspace sources.
        onlyBundle: [],
        // The output imports only what `provino` declares, and the add-ons (D187), which a user
        // installs beside it: a third-party package a bundled `@provino/*` needs and the umbrella
        // doesn't list is caught here, not by a user's install.
        onlyImport: [...runtimeDependencyNames(manifest), ...ADD_ONS],
      },
      outputOptions: {
        // T1.10: three chunks instead of a dozen small ones, so a worker's cold start loads a
        // handful of files from this package: the loading stack (transform, resolver, loader),
        // the coordinator's code, and every other module more than one entry uses (the engine,
        // shared by the coordinator, the worker's entries and the dialect's runtime).
        codeSplitting: {
          groups: [
            // The coordinator's own code (the run, discovery, the pool, reporters, config) in one
            // chunk, so a worker, which loads none of it, doesn't read it or the packages it
            // pulls (tinyglobby, picomatch): about 10 ms of a cold start.
            {
              name: 'coordinator',
              test: COORDINATOR,
              minShareCount: 2,
              priority: 2,
              // Only the coordinator's own files: what they import (rpc, transform, policy) is shared.
              includeDependenciesRecursively: false,
            },
            // The transform, the resolver and the loader, with the Oxc natives they import: a
            // worker loads them when it runs a file, and the `expect` runtime never does. Taken
            // before `shared`, whatever number of entries use them.
            {
              name: 'loading',
              // The compile cache's files are the bin's (`BIN_LIGHT`, the one list of them).
              test: (id: string) => LOADING.test(id) && !BIN_LIGHT.test(id),
              priority: 3,
              includeDependenciesRecursively: false,
            },
            // The `provino` reporter: loaded by a dynamic import when it is chosen only.
            {
              name: 'live',
              test: LIVE,
              priority: 5,
              includeDependenciesRecursively: false,
            },
            // The HTML report: loaded by a dynamic import when `html` is chosen only.
            {
              name: 'html',
              test: HTML,
              priority: 5,
              includeDependenciesRecursively: false,
            },
            // Watch mode: loaded by a dynamic import under `--watch`/`--watchAll` only.
            {
              name: 'watch',
              test: WATCH,
              priority: 5,
              includeDependenciesRecursively: false,
            },
            // `provino jest`'s command: reached by `cli.ts`'s dynamic import only.
            {
              name: 'jest-node',
              test: JEST_NODE,
              priority: 4,
              includeDependenciesRecursively: false,
            },
            // `provino vitest`'s command: reached by `cli.ts`'s dynamic import only.
            {
              name: 'vitest-node',
              test: VITEST_NODE,
              priority: 5,
              includeDependenciesRecursively: false,
            },
            // Taken first: with coverage off, no worker loads it.
            {
              name: 'coverage',
              test: COVERAGE,
              priority: 4,
              includeDependenciesRecursively: false,
            },
            // What the `lazy` forwarders in `index.js` need (the error, the call-site marker, the
            // runtime slot): three small leaves, the worker entries use them too, so left to
            // `shared` they would make `import 'provino'` load the whole engine chunk.
            {
              name: 'lazy-api',
              test: LAZY_API,
              priority: 4,
              includeDependenciesRecursively: false,
            },
            {
              name: 'shared',
              test: (id: string) => SHARED.test(id) && !BIN_LIGHT.test(id),
              minShareCount: 2,
              priority: 1,
              // A module the test leaves out (the bin's three) stays out, and is not pulled in as a
              // dependency of one the test takes.
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
      plugins: workerRefs(),
    },
    // The declarations, in two passes: the public entries, then the add-ons' engine
    // (`internal/*`, D187). One pass would share declaration chunks between them, so the internal
    // entries would move and rename the public declarations (and their API reports, D67).
    {
      ...common,
      entry: publicEntries,
      dts: DTS_ONLY,
      deps: { alwaysBundle: PROVINO_SCOPE, dts: { alwaysBundle: PROVINO_SCOPE } },
      // `jest.d.ts` and `vitest.d.ts` register their dialect on the registry `config.d.ts` exports.
      plugins: [...dropDeclarations(), ...augmentationTarget('provino/config')],
    },
    {
      ...common,
      entry: internalEntries,
      dts: DTS_ONLY,
      deps: { alwaysBundle: PROVINO_SCOPE, dts: { alwaysBundle: PROVINO_SCOPE } },
      // Its shared declaration chunks go under `internal/`, where no public pass writes.
      outputOptions: { chunkFileNames: 'internal/chunks/[name].d.ts' },
      plugins: sharedRegistries(),
    },
  ]
}
