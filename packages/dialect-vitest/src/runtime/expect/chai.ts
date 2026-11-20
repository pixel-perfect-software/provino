// Chai, loaded on first use (D170). Vitest's matchers are Chai plugins: they word a failure with
// Chai's `getMessage`, throw Chai's `AssertionError`, and four of them (`toContain`,
// `toBeInstanceOf`, `toHaveLength`, `toThrow` without a class) are Chai's own assertions. A
// passing assertion of the others needs none of that, so Chai is not imported: the first failure,
// or the first of those four, loads it, synchronously, as Vitest itself has it loaded. Chai 6 is an
// ES module with no top-level await, which `require` loads on Node 22.12 and later.
import { createRequire } from 'node:module'

/** What the matchers read of Chai. */
export interface ChaiModule {
  readonly Assertion: { readonly prototype: object }
  readonly AssertionError: new (message?: string, props?: object, ssf?: unknown) => Error
  readonly util: {
    readonly getMessage: (assertion: object, args: readonly unknown[]) => string
    readonly inspect: (value: unknown, ...options: unknown[]) => string
    readonly getPathInfo: (object: unknown, path: string) => { value: unknown; exists: boolean }
  }
}

const require = createRequire(import.meta.url)
let loaded: ChaiModule | undefined

/** Chai, required on the first call. */
export function chai(): ChaiModule {
  loaded ??= require('chai') as ChaiModule
  return loaded
}

/** Whether Chai has been loaded in this process. */
export function chaiLoaded(): boolean {
  return loaded !== undefined
}

/** Whether `error` is Chai's `AssertionError`: never, while Chai isn't loaded (none was made). */
export function isChaiAssertionError(error: unknown): error is Error {
  return loaded !== undefined && error instanceof loaded.AssertionError
}
