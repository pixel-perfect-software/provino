// The object Vitest's matchers run on. Upstream they are methods of `chai.Assertion`; here they
// run on a `VitestAssertion`, which keeps its flags where Chai keeps them (`__flags`), so Chai's
// own utilities and assertions work on it unchanged once Chai is loaded (`chai.ts`). The vendored
// plugins (`vendor/vitest-expect/expect/`) are run once, over a stand-in `chai` whose
// `Assertion.prototype` is this class's and whose `expect` collects the asymmetric factories.
import { ChaiStyleAssertions } from '../vendor/vitest-expect/expect/chai-style-assertions.ts'
import { JestAsymmetricMatchers } from '../vendor/vitest-expect/expect/jest-asymmetric-matchers.ts'
import { JestChaiExpect } from '../vendor/vitest-expect/expect/jest-expect.ts'
import { chai, chaiOriginal, type OverwrittenMethod } from './chai.ts'

type Flags = Record<string, unknown>

/**
 * Where a `VitestAssertion` holds its flags: a symbol key set by assignment, not a private field,
 * because Chai calls its methods on a Proxy of the assertion, which a private field refuses.
 */
const FLAGS: unique symbol = Symbol('flags')

const flagsOf = (assertion: object): { [FLAGS]: Flags } => assertion as { [FLAGS]: Flags }

/** A Chai method called on `assertion`: Chai's own, loaded now. */
function chaiCall(assertion: VitestAssertion, name: string, args: readonly unknown[]): unknown {
  const method = Reflect.get(chai().Assertion.prototype, name, assertion) as (
    ...args: readonly unknown[]
  ) => unknown
  return Reflect.apply(method, assertion, args)
}

/**
 * One `expect(actual)` as Vitest's matchers see it: `_obj`, the flags, `assert`, and the Chai
 * assertions they delegate to (`contain`, `instanceOf`, `have.length`, `throws`).
 * @internal
 */
export class VitestAssertion {
  constructor(flags: Flags) {
    flagsOf(this)[FLAGS] = flags
  }

  /** Where Chai keeps an assertion's flags: an accessor, so no instance has an own `__flags`. */
  get __flags(): Flags {
    return flagsOf(this)[FLAGS]
  }

  set __flags(flags: Flags) {
    flagsOf(this)[FLAGS] = flags
  }

  get _obj(): unknown {
    return this.__flags.object
  }

  set _obj(value: unknown) {
    this.__flags.object = value
  }

  /**
   * Chai's `Assertion#assert`: passes when `expr` (negated under `.not`) holds, and otherwise
   * runs Chai's own, which words and throws its `AssertionError`.
   */
  assert(...args: unknown[]): void {
    const ok = this.__flags.negate === true ? !args[0] : args[0]
    if (ok) return
    chaiCall(this, 'assert', args)
  }

  /** Chai's language chain: `this.have.length(n)`. */
  get have(): this {
    return this
  }

  contain(...args: unknown[]): unknown {
    return chaiCall(this, 'contain', args)
  }

  instanceOf(...args: unknown[]): unknown {
    return chaiCall(this, 'instanceOf', args)
  }

  length(...args: unknown[]): unknown {
    return chaiCall(this, 'length', args)
  }
}

/** Chai's `util.flag`. */
function flag(target: { __flags?: Flags }, key: string, ...value: [] | [unknown]): unknown {
  const flags = target.__flags ?? Object.create(null)
  if (target.__flags === undefined) Object.defineProperty(target, '__flags', { value: flags })
  if (value.length === 1) {
    flags[key] = value[0]
    return undefined
  }
  return flags[key]
}

/**
 * Chai's `util.getMessage` (`lib/chai/utils/getMessage.js`), built here for a message with no
 * `#{this}`/`#{act}`/`#{exp}` placeholder, so a passing matcher that words its failure first
 * (`toHaveBeenCalled`) loads no Chai; a placeholder is Chai's to fill.
 */
function getMessage(assertion: { __flags?: Flags }, args: readonly unknown[]): string {
  const at = flag(assertion, 'negate') ? 2 : 1
  let raw = args[at]
  if (typeof raw === 'function') raw = raw()
  const template = (raw || '') as string
  if (template.includes('#{')) {
    const resolved = [...args]
    resolved[at] = template
    return chai().util.getMessage(assertion, resolved)
  }
  const message = flag(assertion, 'message')
  return message ? `${String(message)}: ${template}` : template
}

/** What the plugins defined, read once. */
export interface VitestPlugins {
  /** The jest-style methods by name (`def`), each to run on a `VitestAssertion`. */
  readonly methods: ReadonlyMap<string, (this: VitestAssertion, ...args: unknown[]) => unknown>
  /** `expect.anything`, `expect.any`, …: `JestAsymmetricMatchers`' `chai.expect` methods. */
  readonly asymmetric: Readonly<Record<string, (...sample: never[]) => unknown>>
  /** `expect.not`'s factories. */
  readonly asymmetricNot: Readonly<Record<string, (...sample: never[]) => unknown>>
}

/**
 * Runs the vendored plugins over the stand-in `chai`, once per worker.
 * @internal
 */
export function loadVitestPlugins(): VitestPlugins {
  const proto = VitestAssertion.prototype as unknown as Record<string, unknown>
  const methods = new Map<string, (this: VitestAssertion, ...args: unknown[]) => unknown>()
  const expect: Record<string, unknown> = {}
  const utils = {
    flag,
    addMethod(target: Record<string, unknown>, name: string, method: unknown): void {
      target[name] = method
      if (target === proto) {
        methods.set(name, method as (this: VitestAssertion, ...args: unknown[]) => unknown)
      }
    },
    addProperty(target: object, name: string, getter: () => unknown): void {
      Object.defineProperty(target, name, { configurable: true, get: getter })
    },
    overwriteMethod(
      target: Record<string, unknown>,
      name: string,
      wrap: (base: (...args: unknown[]) => unknown) => unknown,
    ): void {
      const original = name as OverwrittenMethod
      target[name] = wrap(function chaiMethod(this: VitestAssertion, ...args: unknown[]) {
        return Reflect.apply(chaiOriginal(original), this, args)
      })
    },
    getMessage,
    inspect: (value: unknown, ...options: unknown[]): string =>
      chai().util.inspect(value, ...options),
    getPathInfo: (object: unknown, path: string) => chai().util.getPathInfo(object, path),
  }
  const AssertionError = function AssertionError(...args: unknown[]): Error {
    const Made = chai().AssertionError
    return new Made(...(args as ConstructorParameters<typeof Made>))
  }
  const standIn = { Assertion: VitestAssertion, AssertionError, expect }
  JestChaiExpect(standIn, utils)
  ChaiStyleAssertions(standIn, utils)
  JestAsymmetricMatchers(standIn, utils)
  const { not, ...asymmetric } = expect
  return {
    methods,
    asymmetric: asymmetric as VitestPlugins['asymmetric'],
    asymmetricNot: (not ?? {}) as VitestPlugins['asymmetricNot'],
  }
}

/** Chai, with Vitest's plugins on its own `Assertion`, as Vitest has it: made on the first chain. */
let pluggedChai:
  | { readonly expect: (actual: unknown, message?: string) => Record<string, unknown> }
  | undefined

function chaiWithPlugins(): NonNullable<typeof pluggedChai> {
  if (pluggedChai !== undefined) return pluggedChai
  const real = chai() as unknown as {
    readonly use: (plugin: (chai: unknown, utils: unknown) => void) => void
    readonly expect: (actual: unknown, message?: string) => Record<string, unknown>
  }
  // `integrations/chai/setup.ts`: the jest-style methods, sinon-chai's names and the asymmetric
  // factories, on Chai's own objects this time.
  real.use(JestChaiExpect)
  real.use(ChaiStyleAssertions)
  real.use(JestAsymmetricMatchers)
  pluggedChai = real
  return real
}

/**
 * A Chai chain read off `expect(actual)` (`to`, `be`, `deep`, `called`, …): a real Chai
 * `Assertion` over `actual`, through `.resolves`/`.rejects` and `.not` as the call came, and
 * the property read from it. An unknown name throws Chai's own "Invalid Chai property".
 * @internal
 */
export function chaiChain(
  actual: unknown,
  name: string,
  { isNot, promise, message }: { isNot: boolean; promise: string; message?: string },
): unknown {
  let assertion = chaiWithPlugins().expect(actual, message)
  if (promise !== '') assertion = assertion[promise] as Record<string, unknown>
  if (isNot) assertion = assertion.not as Record<string, unknown>
  return assertion[name]
}
