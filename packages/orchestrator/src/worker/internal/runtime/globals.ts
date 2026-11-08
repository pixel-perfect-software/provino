// Installing a dialect's globals on the environment's global.

/**
 * Defines each of `values` on `target` as a configurable, writable, enumerable data property, like
 * an assignment would, but without calling a setter the global might have. Configurable, so the
 * environment's restore can delete the names it did not have before, or redefine the ones it did.
 * Defined again every file: the properties persist under a worker-scoped environment, and the
 * dialect's factory ran once, so these are the same values each time.
 * @internal
 */
export function installGlobals(target: object, values: Readonly<Record<string, unknown>>): void {
  definedAll(target, values)
}

/**
 * Splits a dialect's globals by `CorePolicy.globalsBeforeSetupFiles`: the ones installed before
 * `setupFiles` run, and the rest, installed after them and before `setupFilesAfterEnv` (Jest 30.5
 * has only `jest` before, B14a's `core-globals-at-setup`). A listed name the dialect doesn't build
 * is ignored.
 * @internal
 */
export function splitGlobals(
  values: Readonly<Record<string, unknown>>,
  before: 'all' | readonly string[],
): {
  readonly before: Readonly<Record<string, unknown>>
  readonly after: Readonly<Record<string, unknown>>
} {
  if (before === 'all') return { before: values, after: {} }
  const early: Record<string, unknown> = {}
  const late: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(values)) {
    if (before.includes(name)) early[name] = value
    else late[name] = value
  }
  return { before: early, after: late }
}

function definedAll(target: object, values: Readonly<Record<string, unknown>>): void {
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(target, name, {
      value,
      configurable: true,
      writable: true,
      enumerable: true,
    })
  }
}
