import { rmSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import type { UserConfig } from 'tsdown/config'
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
  '@provino/dialect-jest/runtime': 'worker/jest-runtime',
  // Loaded by the coordinator (a failing global hook), through a behaviour ref, as the neutral
  // behaviours are: a leaf of its own, so it never pulls the runtime in.
  '@provino/dialect-jest/global-setup': 'worker/jest-global-setup',
  // Loaded by the coordinator when a run writes an inline snapshot (B23d B1): Babel and the
  // project's Prettier load inside it then, never in a run that writes none.
  '@provino/dialect-jest/inline-snapshots': 'worker/jest-inline-snapshots',
  '@provino/policy/behaviours': 'worker/policy-behaviours',
  '@provino/env-node': 'worker/env-node',
  '@provino/env-jsdom': 'worker/env-jsdom',
}

/** Every `@provino/*` import is bundled from source. */
const PROVINO_SCOPE: RegExp[] = [/^@provino\//]

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
  for (const [specifier, name] of Object.entries(WORKER_ENTRIES)) {
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

/** `import.meta.resolve` of a specifier the build can name, or of a package (`es-module-lexer`). */
const RESOLVE_CALL = /import\.meta\.resolve\(\s*(?:"([^"\\]+)"|'([^'\\]+)'|`([^`\\$]+)`)\s*,?\s*\)/g

/** A line of a comment, which may mention a call without making one. */
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/

/** A call of `import.meta.resolve` with something between the parentheses. */
const ARGUMENT_CALL = /import\.meta\.resolve\(\s*[^)\s]/g

const MARK = '__provino_ref__:'

/**
 * The coordinator's source files: nothing a worker imports. `provino`'s own files are the bin's
 * and `run()`'s; the dialect's policy values (the files that build `jestDialect`) are read by the
 * coordinator, and its `runtime` by the worker.
 */
const COORDINATOR = new RegExp(
  [
    'orchestrator[\\/]src[\\/](?!worker[\\/])',
    'reporters[\\/]src[\\/]',
    'config[\\/]src[\\/]',
    'snapshot[\\/]src[\\/]node[\\/]',
    // provino's own files, but not the bin's light ones.
    `provino[\\/]src[\\/](?!internal[\\/](?:${BIN_LIGHT_FILES.join('|')})\\.ts)`,
    'policy[\\/]src[\\/]dialect\\.ts',
    'dialect-jest[\\/]src[\\/](?:dialect|expect-policy|hoist-policy|mock-policy)\\.ts',
  ]
    .map((alternative) => `[\\/]packages[\\/]${alternative}`)
    .join('|'),
)

/** `BIN_LIGHT_FILES`, as a test of a module id. */
const BIN_LIGHT = new RegExp(
  [
    `[\\\\/]packages[\\\\/]provino[\\\\/]src[\\\\/]internal[\\\\/](?:${BIN_LIGHT_FILES.join('|')})\\.ts$`,
    // The compile cache the bin turns on first (T3.7): a leaf that imports only `node:` modules, and
    // the one file of the transform it shares (the `CACHEDIR.TAG` writer).
    `[\\\\/]packages[\\\\/]transform[\\\\/]src[\\\\/](?:v8cache[\\\\/]|cache[\\\\/]store\\.ts$)`,
  ].join('|'),
)

/**
 * The loading stack: the transform, the resolver and the loader. Their third-party packages are
 * Oxc's natives (`oxc-parser`, `oxc-transform`, `oxc-resolver`), `oxc-walker`, `magic-string` and
 * `@jridgewell/*`, about 17 ms of cold import that a worker pays when it runs a file and
 * `import { expect } from 'provino'` does not. Kept in a chunk of their own, the `expect` runtime's
 * graph (`worker/jest-runtime.js` and the `shared` chunk it imports) loads none of them.
 */
const LOADING =
  /[\\/]packages[\\/](?:transform|resolver|loader)[\\/]src[\\/](?!v8cache[\\/]|cache[\\/]store\.ts$)/

/**
 * The coverage package (B23b): the Istanbul instrumenter, the collectors and the filter, with the
 * parser and the code writer they import. A worker loads it only when its project asks for
 * coverage, so it is a chunk no other code reaches without a dynamic import.
 */
const COVERAGE = /[\\/]packages[\\/]coverage[\\/]src[\\/]/

/** The three `@provino/lazy` leaves `provino`'s own `lazy` forwarders import (`import 'provino'`). */
const LAZY_API = /[\\/]packages[\\/]lazy[\\/]src[\\/](?:errors|slot|runtime[\\/]site)\.ts$/

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
          let changed = false
          const out = code.replace(RESOLVE_CALL, (call, a?: string, b?: string, c?: string) => {
            const specifier = a ?? b ?? c ?? ''
            if (!specifier.startsWith('@provino/')) return call
            const entry = WORKER_ENTRIES[specifier]
            if (entry === undefined) {
              throw new Error(
                `${id}: import.meta.resolve('${specifier}') names a package the umbrella doesn't bundle as an entry (add it to WORKER_ENTRIES)`,
              )
            }
            changed = true
            return `new URL(${JSON.stringify(`${MARK}${entry}.js`)}, import.meta.url).href`
          })
          // What no literal pattern matched, with an argument, is a call whose specifier the build
          // can't read, so it could name a `@provino/*` package this plugin would never rewrite:
          // fail the build. (`import.meta.resolve()` in a message has no argument.)
          const rest = out.replace(RESOLVE_CALL, '')
          for (const match of rest.matchAll(ARGUMENT_CALL)) {
            const start = rest.lastIndexOf('\n', match.index) + 1
            const end = rest.indexOf('\n', match.index)
            const line = rest.slice(start, end === -1 ? undefined : end).trim()
            if (COMMENT_LINE.test(line)) continue
            throw new Error(
              `${id}: import.meta.resolve needs a string literal, which the umbrella build reads to rewrite a @provino/* specifier (found \`${line}\`)`,
            )
          }
          return changed ? { code: out, map: null } : null
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
  const common: UserConfig = {
    ...PRESET,
    cwd: dir,
    clean: false,
    entry: umbrellaEntries(dir),
    inputOptions: {
      resolve: { conditionNames: ['provino-source', 'import', 'node', 'default'] },
    },
  }
  return [
    {
      ...common,
      dts: false,
      deps: {
        alwaysBundle: PROVINO_SCOPE,
        // Nothing from node_modules is bundled: the `@provino/*` packages are workspace sources.
        onlyBundle: [],
        // The output imports only what `provino` declares: a third-party package a bundled
        // `@provino/*` needs and the umbrella doesn't list is caught here, not by a user's install.
        onlyImport: [...runtimeDependencyNames(manifest)],
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
              test: LOADING,
              priority: 3,
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
    {
      ...common,
      dts: DTS_ONLY,
      deps: { alwaysBundle: PROVINO_SCOPE, dts: { alwaysBundle: PROVINO_SCOPE } },
    },
  ]
}
