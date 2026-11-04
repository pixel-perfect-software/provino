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
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(target, name, {
      value,
      configurable: true,
      writable: true,
      enumerable: true,
    })
  }
}
