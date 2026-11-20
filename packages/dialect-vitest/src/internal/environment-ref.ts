// A Vitest environment name as an `EnvironmentRef`, in Vitest 5.0.5's `loadEnvironment` order.
// Shared by the coordinator (`provino vitest` resolves a project's `environment` with it) and the
// runtime (`vitestEnvironmentFor`, a file's docblock), so neither entry imports the other.
import { join, resolve } from 'node:path'
import { createResolver } from '@provino/resolver'
import type { EnvironmentRef, JsonValue } from '@provino/types'
import { VitestDialectError } from './dialect-error.ts'

type JsonObject = { readonly [key: string]: JsonValue }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Where an environment package resolves from the root as an `import` does (`import` and `node`
 * conditions), as Vitest 5.0.5's `loadNativeEnvironment` resolves it with `import.meta.resolve`
 * (`integrations/env/loader.ts` L68): an ES-module-only package is found, and a dual one gives its
 * ES module build. Node's `require` conditions would miss the first and load the second's CommonJS
 * build, whose namespace has the environment one level down.
 */
function resolveEnvironmentPackage(rootDir: string, name: string): string | undefined {
  const resolver = createResolver({
    root: rootDir,
    mappers: [],
    extensions: ['.js', '.mjs', '.cjs', '.json'],
  })
  const found = resolver.resolve(name, {
    importer: join(rootDir, '__provino_environment__.js'),
    kind: 'import',
    conditions: ['node'],
  })
  return found.type === 'file' ? found.path : undefined
}

const RUNTIME = import.meta.resolve('@provino/dialect-vitest/runtime')

/** The two of Vitest's `isBuiltinEnvironment` names that run a vendored setup (`node` and `jsdom` are refs of their own). */
function isSetupBuiltin(name: string): name is 'happy-dom' | 'edge-runtime' {
  return name === 'happy-dom' || name === 'edge-runtime'
}

/** Vitest's `Environment "<name>" cannot be found`-shaped error for a package that isn't there. */
function notFound(name: string, rootDir: string): Error {
  return new VitestDialectError(
    'VITEST_ENVIRONMENT_NOT_FOUND',
    `Cannot find package 'vitest-environment-${name}' imported from ${rootDir}: the environment "${name}" is neither built in nor installed.`,
  )
}

/**
 * The `EnvironmentRef` of a Vitest environment name, as Vitest 5.0.5's `loadEnvironment` finds it:
 * a built-in name, then a path (`.` or `/` first, against the root), then the package
 * `vitest-environment-<name>` from the root. `environmentOptions` is the whole object Vitest hands
 * `setup`; the built-ins read their own key of it (`jsdom`, `happyDOM`).
 * @public
 */
export function vitestEnvironmentRef(
  name: string,
  environmentOptions: JsonObject,
  rootDir: string,
): EnvironmentRef {
  if (name === 'node') {
    return {
      module: import.meta.resolve('@provino/env-node'),
      export: 'nodeEnvironment',
      options: {},
    }
  }
  if (name === 'jsdom') {
    const own = environmentOptions.jsdom
    return {
      module: RUNTIME,
      export: 'vitestJsdomEnvironment',
      options: { ...(isRecord(own) ? (own as JsonObject) : {}), rootDir },
    }
  }
  const base = { name, rootDir, environmentOptions }
  if (isSetupBuiltin(name)) {
    return {
      module: RUNTIME,
      export: 'vitestEnvironment',
      options: { ...base, builtin: name },
    }
  }
  const module =
    name[0] === '.' || name[0] === '/'
      ? resolve(rootDir, name)
      : resolveEnvironmentPackage(rootDir, `vitest-environment-${name}`)
  if (module === undefined) throw notFound(name, rootDir)
  return { module: RUNTIME, export: 'vitestEnvironment', options: { ...base, module } }
}
