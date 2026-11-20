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

/** The methods Vitest's plugin overwrites (`jest-expect.ts` L56). */
export type OverwrittenMethod = 'throw' | 'throws' | 'Throw'

/** A method of Chai's `Assertion.prototype`. */
export type ChaiMethod = (...args: readonly unknown[]) => unknown

const require = createRequire(import.meta.url)

/** Chai, and its own `throw`, `throws` and `Throw` as it came. */
interface Loaded {
  readonly module: ChaiModule
  readonly originals: Readonly<Record<OverwrittenMethod, ChaiMethod>>
}

let loaded: Loaded | undefined

/**
 * Chai, required once. Its own `throw`, `throws` and `Throw` are taken as it loads, before
 * Vitest's plugin can go on Chai's `Assertion` (`assertion.ts`'s `chaiWithPlugins`): the base a
 * `VitestAssertion`'s overwritten method calls. Read after that, the prototype's would be Vitest's
 * wrapper again, and `.rejects.toThrow('msg')` would unwrap the rejection twice.
 */
function load(): Loaded {
  if (loaded === undefined) {
    const module = require('chai') as ChaiModule
    const proto = module.Assertion.prototype as Readonly<Record<OverwrittenMethod, ChaiMethod>>
    loaded = { module, originals: { throw: proto.throw, throws: proto.throws, Throw: proto.Throw } }
  }
  return loaded
}

/** Chai, required on the first call. */
export function chai(): ChaiModule {
  return load().module
}

/** Chai's own `name`, as it was before Vitest's plugin overwrote it. */
export function chaiOriginal(name: OverwrittenMethod): ChaiMethod {
  return load().originals[name]
}

/** Whether Chai has been loaded in this process. */
export function chaiLoaded(): boolean {
  return loaded !== undefined
}

/** Whether `error` is Chai's `AssertionError`: never, while Chai isn't loaded (none was made). */
export function isChaiAssertionError(error: unknown): error is Error {
  return loaded !== undefined && error instanceof loaded.module.AssertionError
}
