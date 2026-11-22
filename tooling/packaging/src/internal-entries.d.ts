import type { UserConfig } from 'tsdown/config'
import type { PackageManifest } from './package-json.ts'
/**
 * The add-on installs (D187): the dialects `provino` no longer inlines. Each is built on its own
 * with `provino` as a peer, and `provino` imports it only where a dialect is asked for.
 * @internal
 */
export declare const ADD_ONS: readonly string[]
/**
 * Whether a package is an add-on: it names `provino` as a peer. Its `@provino/*` engine imports are
 * rewritten by `internalImports`, so it never installs a second copy of the engine.
 * @internal
 */
export declare function isAddOn(manifest: PackageManifest): boolean
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
export declare const INTERNAL_ENTRIES: Readonly<Record<string, Readonly<Record<string, string>>>>
/**
 * The internal target of an engine specifier an add-on names, or `undefined` for its own package.
 * A `@provino/*` specifier that is neither fails the build: it would install a second engine.
 * @internal
 */
export declare function internalTarget(specifier: string, own: string): string | undefined
/**
 * The add-on's build plugin (D187): every `@provino/*` engine import, static, dynamic or a type's,
 * resolves to its `provino/internal/<entry>` subpath and stays external, and every
 * `import.meta.resolve('@provino/…')` of the engine (a worker ref, D21) is rewritten to that subpath,
 * which the add-on resolves through its `provino` peer at run time. The add-on's own subpaths stay
 * as they are. The sources are not edited: in the workspace they import the engine by name.
 * @internal
 */
export declare function internalImports(own: string): NonNullable<UserConfig['plugins']>
//# sourceMappingURL=internal-entries.d.ts.map
