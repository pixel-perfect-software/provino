// The dialects are add-on installs since B27f (D187). `provino` imports one only where it is asked
// for, from the project's own install, and checks before it links that it is the add-on of this
// `provino`: the same version, and its `provino` peer this very copy (one engine). Every other case
// is one line that says what to install or run.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ownManifestPath, packageVersion, versionOf } from './version.ts'

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

const DIALECTS = Object.keys(DIALECT_ADD_ONS) as readonly AddOnDialect[]

/** An add-on's specifier, the package or one of its subpaths: its dialect is the first group. */
const ADD_ON_SPECIFIER = new RegExp(`^@provino/dialect-(${DIALECTS.join('|')})(?:/|$)`)

/**
 * Codes for `AddOnError`.
 *
 * - `PROVINO_DIALECT_NOT_INSTALLED`: the dialect's add-on is not installed.
 * - `PROVINO_DIALECT_VERSION_MISMATCH`: it is installed at another version than `provino`'s.
 * - `PROVINO_DIALECT_OTHER_PROVINO`: its `provino` peer is another copy than the one running
 *   (a global install, `pnpm dlx`): two engines, which share the process's slots.
 * - `PROVINO_DIALECT_NO_PEER`: its `provino` peer is not installed.
 * @internal
 */
export type AddOnErrorCode =
  | 'PROVINO_DIALECT_NOT_INSTALLED'
  | 'PROVINO_DIALECT_VERSION_MISMATCH'
  | 'PROVINO_DIALECT_OTHER_PROVINO'
  | 'PROVINO_DIALECT_NO_PEER'

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
 * An add-on this `provino` can't run with. Its message is the one line the bin prints (`Provino:
 * <message>`, exit 1, no stack), ending with what to install or run.
 * @internal
 */
export class AddOnError extends Error {
  override readonly name = 'AddOnError'
  readonly code: AddOnErrorCode
  readonly dialect: AddOnDialect
  constructor(code: AddOnErrorCode, dialect: AddOnDialect, message: string) {
    super(message)
    this.code = code
    this.dialect = dialect
  }
}

/** `PROVINO_DIALECT_NOT_INSTALLED` for `dialect`. */
export function notInstalled(dialect: AddOnDialect): AddOnError {
  return new AddOnError(
    'PROVINO_DIALECT_NOT_INSTALLED',
    dialect,
    `the ${dialect} dialect needs ${DIALECT_ADD_ONS[dialect]}, which is not installed: ${installCommand(dialect)}`,
  )
}

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

/**
 * The add-on failure `error` is or was caused by (`@provino/config` wraps what its `loadDialects`
 * threw, and what a config file's own `import 'provino/jest'` threw), or `undefined`: an
 * `AddOnError`, or Node's `ERR_MODULE_NOT_FOUND` for an add-on, as `PROVINO_DIALECT_NOT_INSTALLED`.
 * @internal
 */
export function addOnFailure(error: unknown): AddOnError | undefined {
  const seen = new Set<unknown>()
  for (let at: unknown = error; at instanceof Error && !seen.has(at); at = at.cause) {
    if (at instanceof AddOnError) return at
    const dialect = DIALECTS.find((candidate) => isPackageNotFound(at, DIALECT_ADD_ONS[candidate]))
    if (dialect !== undefined) return notInstalled(dialect)
    seen.add(at)
  }
  return undefined
}

/**
 * Writes `error`'s add-on failure as the one line (`Provino: <message>`) to `stderr` and returns
 * the exit code, 1, or `undefined` when `error` is no add-on failure. `main` and `run()` both
 * end here.
 * @internal
 */
export function reportAddOnFailure(
  error: unknown,
  stderr: { write(text: string): unknown },
): 1 | undefined {
  const failure = addOnFailure(error)
  if (failure === undefined) return undefined
  stderr.write(`Provino: ${failure.message}\n`)
  return 1
}

/** The `version` of the package `name` that the file `url` belongs to. */
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
        return versionOf(path)
      }
    }
    if (dirname(dir) === dir) return undefined
  }
}

/** The scheme of the specifiers `addOnSpecifier` makes. */
const SCHEME = 'provino-add-on:'

/** Where `provino`'s own static imports of an add-on resolve from (the CLI's project), if set. */
const state: { root: string | undefined; hooked: boolean } = { root: undefined, hooked: false }

/** The resolve hook below, registered on first use; one for the process. */
function ensureHook(): void {
  if (state.hooked) return
  state.hooked = true
  const ownManifest = ownManifestPath()
  const own = pathToFileURL(dirname(ownManifest)).href
  const ownReal = realpathSync(ownManifest)
  const checked = new Set<string>()
  registerHooks({
    resolve(specifier, context, nextResolve) {
      let root: string | undefined
      let target = specifier
      if (specifier.startsWith(SCHEME)) {
        const at = specifier.indexOf('::')
        root = decodeURIComponent(specifier.slice(SCHEME.length, at))
        target = specifier.slice(at + 2)
      } else {
        const parent = context.parentURL
        if (
          !ADD_ON_SPECIFIER.test(specifier) ||
          parent === undefined ||
          !parent.startsWith(`${own}/`)
        ) {
          return nextResolve(specifier, context)
        }
        root = state.root
      }
      const match = ADD_ON_SPECIFIER.exec(target)
      if (match === null) return nextResolve(specifier, context)
      const dialect = DIALECTS.find((candidate) => candidate === match[1]) ?? 'jest'
      const name = DIALECT_ADD_ONS[dialect]
      const from = (base: string) => ({
        conditions: context.conditions,
        importAttributes: context.importAttributes,
        parentURL: pathToFileURL(join(base, 'package.json')).href,
      })
      let resolved: ReturnType<typeof nextResolve> | undefined
      if (root !== undefined) {
        try {
          resolved = nextResolve(target, from(root))
        } catch (error) {
          if (!isPackageNotFound(error, name)) throw error
        }
      }
      // A root without the add-on: Node's resolution from `provino` itself.
      resolved ??= nextResolve(target, from(dirname(ownManifest)))
      if (!checked.has(resolved.url)) {
        checkAddOn(dialect, resolved.url, (peer) =>
          nextResolve(peer, { ...from(dirname(ownManifest)), parentURL: resolved?.url }),
        )
        checked.add(resolved.url)
      }
      return resolved
    },
  })

  /**
   * Holds the add-on at `url` to this `provino`: its version, then the `provino` its own imports
   * reach (`resolvePeer`, from the add-on's file), which must be this copy.
   */
  function checkAddOn(
    dialect: AddOnDialect,
    url: string,
    resolvePeer: (specifier: string) => { readonly url: string },
  ): void {
    const name = DIALECT_ADD_ONS[dialect]
    const installed = installedVersion(url, name)
    if (installed !== undefined && installed !== packageVersion()) {
      throw new AddOnError(
        'PROVINO_DIALECT_VERSION_MISMATCH',
        dialect,
        `${name} ${installed} is installed, but provino is ${packageVersion()}: ${installCommand(dialect)}`,
      )
    }
    let peer: string
    try {
      peer = realpathSync(fileURLToPath(resolvePeer('provino/package.json').url))
    } catch (error) {
      if (!isPackageNotFound(error, 'provino')) throw error
      throw new AddOnError(
        'PROVINO_DIALECT_NO_PEER',
        dialect,
        `${name} is installed without its provino peer: pnpm add -D provino@${packageVersion()}`,
      )
    }
    if (peer !== ownReal) {
      throw new AddOnError(
        'PROVINO_DIALECT_OTHER_PROVINO',
        dialect,
        `${name} runs on the provino in ${dirname(peer)}, not this one in ${dirname(ownReal)}: run the project's own (pnpm exec provino …)`,
      )
    }
  }
}

/**
 * The specifier that imports `subpath` of `dialect`'s add-on (`''` for the package, `'/node'`)
 * resolved from the project root `root`, else from `provino` itself, held to this `provino`
 * (`AddOnError`) before it links. `run()`, `detect.ts` and the CLI's dynamic imports name their
 * root per call this way, so calls on different projects that overlap each get their own (speed,
 * D115: one resolution per add-on entry; the hook tests nothing else).
 * @internal
 */
export function addOnSpecifier(
  dialect: AddOnDialect,
  subpath: '' | `/${string}`,
  root: string,
): string {
  ensureHook()
  return `${SCHEME}${encodeURIComponent(root)}::${DIALECT_ADD_ONS[dialect]}${subpath}`
}

/**
 * The root `provino`'s own static imports of an add-on resolve from: `provino jest`'s and
 * `provino vitest`'s files, and `provino/jest` or `provino/vitest` in a config file. The CLI
 * sets it once, from the project it runs (`main`); `run()` never does, so under a library caller
 * those imports resolve from `provino` itself, and each `run()` resolves its own `jestDialect` by
 * `addOnSpecifier`. Node keeps one module per URL: the first root an add-on comes from is the one
 * the process keeps.
 * @internal
 */
export function setAddOnRoot(root: string): void {
  ensureHook()
  state.root = root
}
