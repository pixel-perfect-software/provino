import { rmSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import type { UserConfig } from 'tsdown/config'
import { readManifest, runtimeDependencyNames } from './package-json.ts'
import { PRESET } from './preset.ts'

/**
 * The modules a worker loads by file URL (DECISIONS D21): the coordinator resolves each with
 * `import.meta.resolve('<package>/<entry>')` and the worker imports the answer. In the umbrella
 * every `@provino/*` package is inlined, so each of these is an entry of the one build, and the
 * resolve becomes a path to that entry's file (`workerRefs`). Every worker-side module then comes
 * from one chunk graph, with one copy of the engine, instead of a second copy per package.
 * @internal
 */
export const WORKER_ENTRIES: Readonly<
  Record<string, { readonly name: string; readonly source: string }>
> = {
  '@provino/orchestrator/worker/bootstrap': {
    name: 'worker/bootstrap',
    source: '../orchestrator/src/worker/bootstrap.ts',
  },
  '@provino/orchestrator/worker/main': {
    name: 'worker/main',
    source: '../orchestrator/src/worker/main.ts',
  },
  '@provino/dialect-jest/runtime': {
    name: 'worker/jest-runtime',
    source: '../dialect-jest/src/runtime/index.ts',
  },
  '@provino/policy/behaviours': {
    name: 'worker/policy-behaviours',
    source: '../policy/src/behaviours.ts',
  },
  '@provino/env-node': { name: 'worker/env-node', source: '../env-node/src/index.ts' },
  '@provino/env-jsdom': { name: 'worker/env-jsdom', source: '../env-jsdom/src/index.ts' },
}

/** The umbrella's own subpaths: their entry name (the `import` condition) and source. */
const OWN_ENTRIES: Readonly<Record<string, string>> = {
  index: 'src/index.ts',
  globals: 'src/globals.ts',
  config: 'src/config.ts',
  node: 'src/node.ts',
  reporters: 'src/reporters.ts',
  environment: 'src/environment.ts',
  jest: 'src/jest.ts',
  cli: 'src/cli.ts',
}

/** `import.meta.resolve` of a specifier the build can name, or of a package (`es-module-lexer`). */
const RESOLVE_CALL = /import\.meta\.resolve\(\s*(?:"([^"\\]+)"|'([^'\\]+)'|`([^`\\$]+)`)\s*,?\s*\)/g

const MARK = '__provino_ref__:'

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
            return `new URL(${JSON.stringify(`${MARK}${entry.name}.js`)}, import.meta.url).href`
          })
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
    entry: {
      ...OWN_ENTRIES,
      ...Object.fromEntries(Object.values(WORKER_ENTRIES).map((e) => [e.name, e.source])),
    },
    inputOptions: {
      resolve: { conditionNames: ['provino-source', 'import', 'node', 'default'] },
    },
  }
  return [
    {
      ...common,
      dts: false,
      deps: {
        alwaysBundle: [/^@provino\//],
        // Nothing from node_modules is bundled: the `@provino/*` packages are workspace sources.
        onlyBundle: [],
        // The output imports only what `provino` declares: a third-party package a bundled
        // `@provino/*` needs and the umbrella doesn't list is caught here, not by a user's install.
        onlyImport: [...runtimeDependencyNames(manifest)],
      },
      outputOptions: {
        // T1.10: one chunk for every module more than one entry uses (the engine, shared by the
        // coordinator, the worker's entries and the dialect's runtime), instead of a dozen small
        // ones, so a worker's cold start loads a handful of files from this package.
        codeSplitting: {
          groups: [{ name: 'shared', test: SHARED, minShareCount: 2 }],
        },
      },
      plugins: workerRefs(),
    },
    {
      ...common,
      dts: { generator: 'oxc', sourcemap: false, emitDtsOnly: true },
      deps: { alwaysBundle: [/^@provino\//], dts: { alwaysBundle: [/^@provino\//] } },
    },
  ]
}
