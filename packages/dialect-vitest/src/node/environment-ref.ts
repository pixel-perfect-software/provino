// `vitestEnvironmentRef` for the coordinator: `provino vitest` resolves a project's `environment` with
// it, so the project gets the refs a file's docblock gets from the runtime's `vitestEnvironmentFor`.
// The lookup of an environment package is the runtime's (`runtime/vitest-environment.ts`), kept
// in both entries because neither may import the other.
import { join } from 'node:path'
import { createResolver } from '@provino/resolver'
import type { EnvironmentRef, JsonValue } from '@provino/types'
import { environmentRefOf } from '../internal/environment-ref.ts'

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

/**
 * The `EnvironmentRef` of a Vitest environment name, as Vitest 5.0.5's `loadEnvironment` finds it:
 * a built-in name, then a path (`.` or `/` first, against the root), then the package
 * `vitest-environment-<name>` from the root. `environmentOptions` is the whole object Vitest hands
 * `setup`; the built-ins read their own key of it (`jsdom`, `happyDOM`).
 * @public
 */
export function vitestEnvironmentRef(
  name: string,
  environmentOptions: { readonly [key: string]: JsonValue },
  rootDir: string,
): EnvironmentRef {
  return environmentRefOf(name, environmentOptions, rootDir, resolveEnvironmentPackage)
}
