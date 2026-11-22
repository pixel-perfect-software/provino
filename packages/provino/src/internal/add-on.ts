// The dialects are add-on installs since B27f (D187): `provino` imports one only where it is asked
// for, and an import that finds no install becomes the one line that says how to add it.

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
 * A dialect's add-on is not installed (`PROVINO_DIALECT_NOT_INSTALLED`). Its message is the one line
 * the bin prints, with the exact install command; it has no cause worth a stack.
 * @internal
 */
export class DialectNotInstalledError extends Error {
  readonly code = 'PROVINO_DIALECT_NOT_INSTALLED'
  readonly dialect: AddOnDialect
  constructor(dialect: AddOnDialect) {
    const name = DIALECT_ADD_ONS[dialect]
    super(`the ${dialect} dialect needs ${name}, which is not installed: pnpm add -D ${name}`)
    this.name = 'DialectNotInstalledError'
    this.dialect = dialect
  }
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
 * Runs `load`, the dynamic import of what needs `dialect`'s add-on, and turns a missing add-on
 * into `DialectNotInstalledError`. Anything else it threw is rethrown as it is.
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
 * The `DialectNotInstalledError` `error` is or was caused by (`@provino/config` wraps what its
 * `loadDialects` threw), or `undefined`.
 * @internal
 */
export function dialectNotInstalled(error: unknown): DialectNotInstalledError | undefined {
  const seen = new Set<unknown>()
  for (let at: unknown = error; at instanceof Error && !seen.has(at); at = at.cause) {
    if (at instanceof DialectNotInstalledError) return at
    seen.add(at)
  }
  return undefined
}
