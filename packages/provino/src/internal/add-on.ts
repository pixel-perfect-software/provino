// The dialects are add-on installs since B27f (D187): `provino` imports one only where it is asked
// for, from the project's own install, and checks that it is the add-on of this `provino`'s
// version. An add-on that isn't there, or is of another version, becomes the one line that says
// how to install the matching one.
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { packageVersion } from './version.ts'

/**
 * The add-on that each dialect command needs, by the name the command line and a config use.
 * @internal
 */
export const DIALECT_ADD_ONS = {
  jest: '@provino/dialect-jest',
  vitest: '@provino/dialect-vitest',
} as const

/** A dialect `provino` has an add-on for. */
export type AddOnDialect = keyof typeof DIALECT_ADD_ONS

/**
 * The command that installs `dialect`'s add-on at this `provino`'s own version: the two are one
 * release (`provino/internal/*` promises no semver), and the bare name would install npm's
 * `latest` tag, which need not be that version.
 * @internal
 */
export function installCommand(dialect: AddOnDialect): string {
  return `pnpm add -D ${DIALECT_ADD_ONS[dialect]}@${packageVersion()}`
}

/**
 * A dialect's add-on is not installed (`PROVINO_DIALECT_NOT_INSTALLED`). Its message is the one line
 * the bin prints, with the exact install command; it has no cause worth a stack.
 * @internal
 */
export class DialectNotInstalledError extends Error {
  readonly code = 'PROVINO_DIALECT_NOT_INSTALLED'
  readonly dialect: AddOnDialect
  constructor(dialect: AddOnDialect) {
    super(
      `the ${dialect} dialect needs ${DIALECT_ADD_ONS[dialect]}, which is not installed: ${installCommand(dialect)}`,
    )
    this.name = 'DialectNotInstalledError'
    this.dialect = dialect
  }
}

/**
 * A dialect's add-on is installed at another version than this `provino`
 * (`PROVINO_DIALECT_VERSION_MISMATCH`): its build imports `provino/internal/*` names of its own
 * release, so it is refused before it links. One line, with the command that installs the match.
 * @internal
 */
export class DialectVersionMismatchError extends Error {
  readonly code = 'PROVINO_DIALECT_VERSION_MISMATCH'
  readonly dialect: AddOnDialect
  readonly installed: string
  constructor(dialect: AddOnDialect, installed: string) {
    super(
      `${DIALECT_ADD_ONS[dialect]} ${installed} is installed, but provino is ${packageVersion()}: ${installCommand(dialect)}`,
    )
    this.name = 'DialectVersionMismatchError'
    this.dialect = dialect
    this.installed = installed
  }
}

/** What an add-on's absence or mismatch is reported as. */
type AddOnFailure = DialectNotInstalledError | DialectVersionMismatchError

/**
 * Whether `error` is Node's failure to find the package `name` itself (`ERR_MODULE_NOT_FOUND`,
 * "Cannot find package '<name>'"): a package the add-on needs and lacks is another error, and so is
 * a file of an installed add-on that is missing.
 * @internal
 */
export function isPackageNotFound(error: unknown, name: string): boolean {
  if (!(error instanceof Error)) return false
  return (
    Reflect.get(error, 'code') === 'ERR_MODULE_NOT_FOUND' &&
    error.message.includes(`Cannot find package '${name}'`)
  )
}

/** The dialect whose add-on `error` says is missing, if it says so. */
function missingAddOn(error: unknown): AddOnDialect | undefined {
  for (const dialect of ['jest', 'vitest'] as const) {
    if (isPackageNotFound(error, DIALECT_ADD_ONS[dialect])) return dialect
  }
  return undefined
}

/**
 * Runs `load`, the dynamic import of what needs `dialect`'s add-on, and turns a missing add-on
 * into `DialectNotInstalledError`. Anything else it threw (a version mismatch among them) is
 * rethrown as it is.
 * @internal
 */
export async function importAddOn<T>(dialect: AddOnDialect, load: () => Promise<T>): Promise<T> {
  try {
    return await load()
  } catch (error) {
    if (isPackageNotFound(error, DIALECT_ADD_ONS[dialect]))
      throw new DialectNotInstalledError(dialect)
    throw error
  }
}

/**
 * The add-on failure `error` is or was caused by (`@provino/config` wraps what its `loadDialects`
 * threw, and what a config file's own import of `provino/jest` threw), or `undefined`: one of the
 * two errors above, or Node's `ERR_MODULE_NOT_FOUND` for an add-on, as `DialectNotInstalledError`.
 * @internal
 */
export function addOnFailure(error: unknown): AddOnFailure | undefined {
  const seen = new Set<unknown>()
  for (let at: unknown = error; at instanceof Error && !seen.has(at); at = at.cause) {
    if (at instanceof DialectNotInstalledError || at instanceof DialectVersionMismatchError)
      return at
    const dialect = missingAddOn(at)
    if (dialect !== undefined) return new DialectNotInstalledError(dialect)
    seen.add(at)
  }
  return undefined
}

/** An add-on's specifier: the package or one of its subpaths, and which dialect it is. */
const ADD_ON_SPECIFIER = /^@provino\/dialect-(jest|vitest)(?:\/|$)/

/** The directory `provino` is installed in (its `package.json`'s), as a URL prefix. */
function ownPackageUrl(): string {
  return pathToFileURL(dirname(fileURLToPath(import.meta.resolve('provino/package.json')))).href
}

/** The `version` of the package `name` whose file `url` is, read from its `package.json`. */
function installedVersion(url: string, name: string): string | undefined {
  for (let dir = dirname(fileURLToPath(url)); ; dir = dirname(dir)) {
    const path = join(dir, 'package.json')
    if (existsSync(path)) {
      const manifest: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (
        typeof manifest === 'object' &&
        manifest !== null &&
        Reflect.get(manifest, 'name') === name
      ) {
        const version = Reflect.get(manifest, 'version')
        return typeof version === 'string' ? version : undefined
      }
    }
    if (dirname(dir) === dir) return undefined
  }
}

/** Where the add-ons resolve from, and whether the hook is in (one per process: Node's own module cache is too). */
const resolution: { root: string | undefined; hooked: boolean } = { root: undefined, hooked: false }

/**
 * Makes `provino`'s own imports of an add-on (`provino jest`'s files, `run()`'s `jestDialect`,
 * `provino/jest`, `provino/vitest`) resolve from the project root `root` (plan task 3): the
 * project's own install, which pnpm with `hoist=false` and a workspace with two `provino`
 * versions both need, where provino's folder in the store finds it only through a hoist. A root
 * that has none falls back to Node's resolution from `provino` itself. The add-on found is held
 * to this `provino`'s version (`DialectVersionMismatchError`) before it links. One sync resolve
 * hook for the process, which tests only the add-ons' names and only from `provino`'s own files
 * (speed, D115: one resolution per add-on entry, a regular expression per other import). Node
 * keeps one module per URL, so the first root an add-on is resolved from is the one it comes from.
 * @internal
 */
export function resolveAddOnsFrom(root: string): void {
  resolution.root = root
  if (resolution.hooked) return
  resolution.hooked = true
  const own = ownPackageUrl()
  const checked = new Set<string>()
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const match = ADD_ON_SPECIFIER.exec(specifier)
      const parent = context.parentURL
      if (match === null || parent === undefined || !parent.startsWith(`${own}/`)) {
        return nextResolve(specifier, context)
      }
      const dialect = match[1] === 'jest' ? 'jest' : 'vitest'
      const name = DIALECT_ADD_ONS[dialect]
      const from = resolution.root
      let resolved: ReturnType<typeof nextResolve> | undefined
      if (from !== undefined) {
        try {
          resolved = nextResolve(specifier, {
            conditions: context.conditions,
            importAttributes: context.importAttributes,
            parentURL: pathToFileURL(join(from, 'package.json')).href,
          })
        } catch (error) {
          if (!isPackageNotFound(error, name)) throw error
        }
      }
      // Node's chain may write to the context it was handed, so the fallback names its parent again.
      resolved ??= nextResolve(specifier, { ...context, parentURL: parent })
      if (!checked.has(resolved.url)) {
        const installed = installedVersion(resolved.url, name)
        if (installed !== undefined && installed !== packageVersion()) {
          throw new DialectVersionMismatchError(dialect, installed)
        }
        checked.add(resolved.url)
      }
      return resolved
    },
  })
}
