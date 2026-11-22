import type { UserConfig } from 'tsdown/config'
import type { PackageManifest } from './package-json.ts'

/**
 * The engine each add-on reaches through `provino` (D187): every `@provino/*` specifier its sources
 * import (or `import.meta.resolve`), and the `provino/internal/<entry>` subpath it becomes in the
 * add-on's build. The worker-side packages of one add-on share one entry (`jest-runtime`,
 * `vitest-runtime`), so its worker reads one file of the umbrella for all of them; the Jest one
 * leaves out the resolver, so `expect` under Jest loads no loading stack (T7.12). The umbrella's
 * `exports` list each target as an `@internal` subpath with no semver promise
 * (`umbrella.test.ts` holds the two equal). The engine files in `packages/provino/src/internal/engine/`
 * name, value by value, what the add-ons' builds import, and every type (`export type *`):
 * `export *` of the packages kept worker-only engine code in the graph, which then lands in
 * `shared.js`, and the coordinator of every run loaded it (B27f's design round).
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

/**
 * The add-on installs (D187): the dialects `provino` no longer inlines, each built on its own with
 * `provino` as a peer. They are `INTERNAL_ENTRIES`' keys.
 * @internal
 */
export const ADD_ONS: readonly string[] = Object.keys(INTERNAL_ENTRIES)

/** The umbrella package: the peer an add-on names, whose engine it runs on. */
export const UMBRELLA = 'provino'

/**
 * Whether a package is an add-on: it names `provino` as a peer. Its `@provino/*` engine imports are
 * rewritten by `internalImports`, so it never installs a second copy of the engine.
 * @internal
 */
export function isAddOn(manifest: PackageManifest): boolean {
  return Object.hasOwn(manifest.peerDependencies, UMBRELLA)
}

/**
 * Whether `specifier` is the package `name` or one of its subpaths.
 * @internal
 */
export function inPackage(specifier: string, name: string): boolean {
  return specifier === name || specifier.startsWith(`${name}/`)
}

/**
 * Whether an umbrella subpath (`./internal/jest-runtime`) or entry name (`internal/types`) is one
 * of the add-ons' engine entries: internal, with no API report and no semver promise.
 * @internal
 */
export function isInternalEntry(subpathOrName: string): boolean {
  return /^(?:\.\/)?internal\//.test(subpathOrName)
}

/**
 * `import.meta.resolve` of a string literal, in any quotes, with a trailing comma (Biome wraps a
 * long call so): the specifier is the first group of the three. One pattern for the umbrella's
 * worker refs and the add-ons' engine refs.
 * @internal
 */
export const RESOLVE_CALL: RegExp =
  /import\.meta\.resolve\(\s*(?:"([^"\\]+)"|'([^'\\]+)'|`([^`\\$]+)`)\s*,?\s*\)/g

/** A line of a comment, which may mention a call without making one. */
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/

/** A call of `import.meta.resolve` with something between the parentheses. */
const ARGUMENT_CALL = /import\.meta\.resolve\(\s*[^)\s]/g

/**
 * Rewrites each `import.meta.resolve` of a literal in `code` by `rewrite` (its specifier to the new
 * call text, or `undefined` to keep it), then fails on any call left with an argument that is not a
 * string literal: its specifier can't be read, so it could name a `@provino/*` package no rewrite
 * reaches. A comment line is not a call, and `import.meta.resolve()` in a message has no argument.
 * `undefined` when nothing changed.
 * @internal
 */
export function rewriteResolveCalls(
  code: string,
  id: string,
  rewrite: (specifier: string) => string | undefined,
): string | undefined {
  let changed = false
  const out = code.replace(RESOLVE_CALL, (call, a?: string, b?: string, c?: string) => {
    const next = rewrite(a ?? b ?? c ?? '')
    if (next === undefined) return call
    changed = true
    return next
  })
  const rest = out.replace(RESOLVE_CALL, '')
  for (const match of rest.matchAll(ARGUMENT_CALL)) {
    const start = rest.lastIndexOf('\n', match.index) + 1
    const end = rest.indexOf('\n', match.index)
    const line = rest.slice(start, end === -1 ? undefined : end).trim()
    if (COMMENT_LINE.test(line)) continue
    throw new Error(
      `${id}: import.meta.resolve needs a string literal, which the build reads to rewrite a @provino/* specifier (found \`${line}\`)`,
    )
  }
  return changed ? out : undefined
}

/**
 * The internal target of an engine specifier an add-on names, or `undefined` for its own package
 * and any specifier outside `@provino/*`. A `@provino/*` specifier the table lacks for this add-on
 * fails the build: it would install a second engine.
 * @internal
 */
export function internalTarget(specifier: string, own: string): string | undefined {
  if (!specifier.startsWith('@provino/') || inPackage(specifier, own)) return undefined
  const target = INTERNAL_ENTRIES[own]?.[specifier]
  if (target === undefined) {
    throw new Error(
      `${own} imports ${specifier}, which provino does not export to it as provino/internal/*: add it to INTERNAL_ENTRIES and provino's exports`,
    )
  }
  return target
}

/** A list of build plugins, which a config can spread into another. */
export type PluginList = Extract<NonNullable<UserConfig['plugins']>, readonly unknown[]>

/** The module a user's program resolves the registries from: `provino/config` exports them. */
export const REGISTRY_MODULE: string = `${UMBRELLA}/config`

/** The registries a program fills by declaration merging, and that `REGISTRY_MODULE` exports. */
export const REGISTRIES: readonly string[] = ['DialectRegistry', 'PluginRegistry']

const AUGMENTATION_SPECIFIER = /declare module (['"])@provino\/types\1/g

/**
 * Retargets the registry augmentations (`declare module '@provino/types' { interface DialectRegistry … }`)
 * in one built declaration file, keeping the quote style. A user's install has no `@provino/types`,
 * so the specifier resolves to nothing, the registry stays empty and `DialectName` is `never`.
 * The doc comments that show the augmentation are rewritten with it.
 * @internal
 */
export function retargetAugmentations(code: string): string {
  return code.replace(
    AUGMENTATION_SPECIFIER,
    (_match, quote: string) => `declare module ${quote}${REGISTRY_MODULE}${quote}`,
  )
}

/**
 * The build plugin for `retargetAugmentations`: every `.d.ts` of an add-on's build, and of
 * `provino`'s public declarations, names `REGISTRY_MODULE`. The sources keep `@provino/types`,
 * the workspace's module.
 * @internal
 */
export function augmentationTarget(): PluginList {
  return [
    {
      name: 'provino-augmentation-target',
      generateBundle(_options, bundle) {
        for (const item of Object.values(bundle)) {
          if (item.type === 'chunk' && item.fileName.endsWith('.d.ts')) {
            item.code = retargetAugmentations(item.code)
          }
        }
      },
    },
  ]
}

/** An empty registry and its doc comment, from the start of a line. */
const REGISTRY_DECLARATIONS: ReadonlyMap<string, RegExp> = new Map(
  REGISTRIES.map((name) => [
    name,
    new RegExp(
      `^(?:/\\*\\*(?:(?!\\*/)[\\s\\S])*?\\*/\\n)?(?:export )?interface ${name} \\{\\}\\n`,
      'm',
    ),
  ]),
)

/** The directives a declaration file opens with, which only count before any other line. */
const LEADING_DIRECTIVES = /^(?:\/\/\/[^\n]*\n)*/

/**
 * Cuts each empty registry (and its doc comment) from one declaration chunk and imports it from
 * `REGISTRY_MODULE` instead, after the chunk's leading `/// <reference>` lines. `cut` names
 * what was found.
 * @internal
 */
export function shareRegistries(code: string): { readonly code: string; readonly cut: string[] } {
  let out = code
  const cut: string[] = []
  for (const [name, declaration] of REGISTRY_DECLARATIONS) {
    const next = out.replace(declaration, '')
    if (next === out) continue
    out = next
    cut.push(name)
  }
  if (cut.length === 0) return { code, cut }
  const directives = LEADING_DIRECTIVES.exec(out)?.[0] ?? ''
  const rest = out.slice(directives.length)
  return {
    code: `${directives}import type { ${cut.join(', ')} } from "${REGISTRY_MODULE}";\n${rest}`,
    cut,
  }
}

/**
 * The internal declarations name the public registries instead of defining their own: an
 * augmentation merges into one interface, so a second copy (the chunks of `internal/`) would stay
 * empty for a program that augments the one `REGISTRY_MODULE` exports and `defineConfig` reads. The
 * build fails when a registry is found in no chunk, so a change to how they are declared can't
 * bring the second copy back unseen.
 * @internal
 */
export function sharedRegistries(): PluginList {
  return [
    {
      name: 'provino-shared-registries',
      generateBundle(_options, bundle) {
        const found = new Set<string>()
        for (const item of Object.values(bundle)) {
          if (item.type !== 'chunk' || !item.fileName.endsWith('.d.ts')) continue
          const shared = shareRegistries(item.code)
          item.code = shared.code
          for (const name of shared.cut) found.add(name)
        }
        const missing = REGISTRIES.filter((name) => !found.has(name))
        if (missing.length > 0) {
          throw new Error(
            `the internal declarations hold no empty \`interface ${missing.join(', ')}\` to share with ${REGISTRY_MODULE}: the registries are declared another way, so update shareRegistries`,
          )
        }
      },
    },
  ]
}

/**
 * The add-on's build plugin (D187): every `@provino/*` engine import, static, dynamic or a type's,
 * resolves to its `provino/internal/<entry>` subpath and stays external, and every
 * `import.meta.resolve('@provino/…')` of the engine (a worker ref, D21) is rewritten to that subpath
 * (`rewriteResolveCalls`, which fails the build on a call it can't read), which the add-on
 * resolves through its `provino` peer at run time. The add-on's own subpaths stay as they are. The
 * sources are not edited: in the workspace they import the engine by name.
 * @internal
 */
export function internalImports(own: string): PluginList {
  return [
    {
      name: 'provino-internal-imports',
      resolveId: {
        order: 'pre',
        handler(source) {
          const target = internalTarget(source, own)
          return target === undefined ? null : { id: target, external: true }
        },
      },
      transform: {
        filter: { code: 'import.meta.resolve' },
        handler(code, id) {
          const out = rewriteResolveCalls(code, id, (specifier) => {
            const target = internalTarget(specifier, own)
            return target === undefined
              ? undefined
              : `import.meta.resolve(${JSON.stringify(target)})`
          })
          return out === undefined ? null : { code: out, map: null }
        },
      },
    },
  ]
}
