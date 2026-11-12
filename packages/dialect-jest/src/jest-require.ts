// Where Jest's own packages are found from a project: the pure `createRequire` and realpath walk
// `jest-config` takes (its `requireResolve`), shared by the config reader (`./node`) and the
// environment adapter (`./runtime`), which both resolve `jest-environment-*` and `babel-jest` the
// way jest-config does. It imports no other package, so either entry may use it.
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/**
 * Where Jest's built-in packages resolve from: a function like `require.resolve` from jest-config's
 * directory. The default finds the project's own Jest (`jest-config`, else `jest` → `jest-cli` →
 * `jest-config`, each from the one before, which also works under pnpm) from `rootDir`.
 * @public
 */
export type JestRequireResolve = (specifier: string) => string | undefined

function tryRequireResolve(from: string, specifier: string): string | undefined {
  try {
    return createRequire(from).resolve(specifier)
  } catch {
    return undefined
  }
}

/**
 * Finds the `jest-config` a project would run with, from its root: `jest-config` itself, else
 * through `jest`, `jest-cli` (and `@jest/core`). Returns a `require.resolve` from there.
 * @public
 */
export function projectJestRequireResolve(rootDir: string): JestRequireResolve {
  let located: string | null | undefined
  const locate = (): string | null => {
    if (located !== undefined) return located
    const start = join(rootDir, '__provino_jest_config__.js')
    const direct = tryRequireResolve(start, 'jest-config/package.json')
    if (direct !== undefined) {
      located = direct
      return located
    }
    const jest = tryRequireResolve(start, 'jest/package.json')
    const real = (path: string | undefined) => (path === undefined ? undefined : realpathSync(path))
    const cli =
      jest === undefined
        ? undefined
        : real(tryRequireResolve(real(jest) ?? jest, 'jest-cli/package.json'))
    const viaCli =
      cli === undefined ? undefined : tryRequireResolve(cli, 'jest-config/package.json')
    const core =
      viaCli === undefined && cli !== undefined
        ? real(tryRequireResolve(cli, '@jest/core/package.json'))
        : undefined
    located =
      viaCli ??
      (core === undefined ? undefined : tryRequireResolve(core, 'jest-config/package.json')) ??
      null
    return located
  }
  return (specifier) => {
    const from = locate()
    return from === null ? undefined : tryRequireResolve(realpathSync(from), specifier)
  }
}
