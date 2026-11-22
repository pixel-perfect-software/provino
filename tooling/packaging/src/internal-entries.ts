import type { UserConfig } from 'tsdown/config'
import type { PackageManifest } from './package-json.ts'

/**
 * The add-on installs (D187): the dialects `provino` no longer inlines. Each is built on its own
 * with `provino` as a peer, and `provino` imports it only where a dialect is asked for.
 * @internal
 */
export const ADD_ONS: readonly string[] = ['@provino/dialect-jest', '@provino/dialect-vitest']

/** The peer an add-on names: the one `provino` whose engine it runs on. */
const UMBRELLA = 'provino'

/**
 * Whether a package is an add-on: it names `provino` as a peer. Its `@provino/*` engine imports are
 * rewritten by `internalImports`, so it never installs a second copy of the engine.
 * @internal
 */
export function isAddOn(manifest: PackageManifest): boolean {
  return Object.hasOwn(manifest.peerDependencies, UMBRELLA)
}

/**
 * The engine each add-on reaches through `provino` (D187): every `@provino/*` specifier its sources
 * import (or `import.meta.resolve`), and the `provino/internal/<entry>` subpath it becomes in the
 * add-on's build. The worker-side packages of one add-on share one entry (`jest-runtime`,
 * `vitest-runtime`), so its worker reads one file of the umbrella for all of them; the Jest one
 * leaves out the resolver, so `expect` under Jest loads no loading stack (T7.12). The umbrella's
 * `exports` list each target as an `@internal` subpath with no semver promise
 * (`umbrella.test.ts` holds the two equal).
 * @internal
 */
export const INTERNAL_ENTRIES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '@provino/dialect-jest': {
    '@provino/core': 'provino/internal/jest-runtime',
    '@provino/env-shared': 'provino/internal/jest-runtime',
    '@provino/expect': 'provino/internal/jest-runtime',
    '@provino/mock': 'provino/internal/jest-runtime',
    '@provino/policy': 'provino/internal/jest-runtime',
    '@provino/resolver': 'provino/internal/resolver',
    '@provino/timers': 'provino/internal/jest-runtime',
    '@provino/types': 'provino/internal/types',
  },
  '@provino/dialect-vitest': {
    '@provino/config': 'provino/internal/config',
    '@provino/core': 'provino/internal/vitest-runtime',
    '@provino/env-jsdom': 'provino/internal/vitest-runtime',
    '@provino/env-node': 'provino/internal/env-node',
    '@provino/env-shared': 'provino/internal/vitest-runtime',
    '@provino/expect': 'provino/internal/vitest-runtime',
    '@provino/mock': 'provino/internal/vitest-runtime',
    '@provino/policy': 'provino/internal/vitest-runtime',
    '@provino/resolver': 'provino/internal/vitest-runtime',
    '@provino/resolver/vite-alias': 'provino/internal/vite-alias',
    '@provino/timers': 'provino/internal/vitest-runtime',
    '@provino/types': 'provino/internal/types',
  },
}

/** `import.meta.resolve` of a string literal. */
const RESOLVE_CALL = /import\.meta\.resolve\(\s*(["'`])(@provino\/[^"'`\\$]+)\1\s*\)/g

/** Whether `specifier` names the package `own` itself (a self-reference, which stays as written). */
function isOwn(specifier: string, own: string): boolean {
  return specifier === own || specifier.startsWith(`${own}/`)
}

/**
 * The internal target of an engine specifier an add-on names, or `undefined` for its own package.
 * A `@provino/*` specifier that is neither fails the build: it would install a second engine.
 * @internal
 */
export function internalTarget(specifier: string, own: string): string | undefined {
  if (isOwn(specifier, own)) return undefined
  const target = INTERNAL_ENTRIES[own]?.[specifier]
  if (target === undefined) {
    throw new Error(
      `${own} imports ${specifier}, which provino does not export to it as provino/internal/*: add it to INTERNAL_ENTRIES and provino's exports`,
    )
  }
  return target
}

/**
 * The add-on's build plugin (D187): every `@provino/*` engine import, static, dynamic or a type's,
 * resolves to its `provino/internal/<entry>` subpath and stays external, and every
 * `import.meta.resolve('@provino/…')` of the engine (a worker ref, D21) is rewritten to that subpath,
 * which the add-on resolves through its `provino` peer at run time. The add-on's own subpaths stay
 * as they are. The sources are not edited: in the workspace they import the engine by name.
 * @internal
 */
export function internalImports(own: string): NonNullable<UserConfig['plugins']> {
  return [
    {
      name: 'provino-internal-imports',
      resolveId: {
        order: 'pre',
        handler(source) {
          if (!source.startsWith('@provino/')) return null
          const target = internalTarget(source, own)
          return target === undefined ? null : { id: target, external: true }
        },
      },
      transform: {
        filter: { code: 'import.meta.resolve' },
        handler(code) {
          let changed = false
          const out = code.replace(RESOLVE_CALL, (call, quote: string, specifier: string) => {
            const target = internalTarget(specifier, own)
            if (target === undefined) return call
            changed = true
            return `import.meta.resolve(${quote}${target}${quote})`
          })
          return changed ? { code: out, map: null } : null
        },
      },
    },
  ]
}
