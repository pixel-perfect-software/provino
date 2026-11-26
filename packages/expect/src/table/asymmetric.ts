// The asymmetric matchers of the table (D188): `any`, `anything`, `objectContaining`,
// `arrayContaining`, `stringContaining`, `stringMatching` and `closeTo`. Their `toString()` and
// `toAsymmetricMatcher()` are Jest 30.5.2's (`expect/src/asymmetricMatchers.ts`, compat): the
// snapshot printer's `AsymmetricMatcher` plugin reads them, so a property matcher prints in a
// `.snap` as Jest prints it (B28; `snapshot/property-matchers` records `Any<Number>` and
// `StringMatching /\^abc/`).
import { AsymmetricMatcher, equals, type MatcherContext } from '@provino/expect'
import type {
  AsymmetricFactories,
  AsymmetricMatcherLike,
  CustomAsymmetricBuilder,
  EqualityTester,
  Matcher,
} from '@provino/types'
import { show } from './print.ts'

/** An asymmetric matcher that says whether it matches; the base turns that around for `expect.not`. */
abstract class Inversible<T> extends AsymmetricMatcher<T> {
  abstract matches(other: unknown, testers?: readonly EqualityTester[]): boolean

  asymmetricMatch(other: unknown, testers?: readonly EqualityTester[]): boolean {
    return this.matches(other, testers) !== this.inverse
  }

  /** `Not` under `expect.not`, the prefix of every description. */
  protected not(): string {
    return this.inverse ? 'Not' : ''
  }
}

/** A function's name as Jest's `fnNameFor` finds it: `name`, else the source's, else `<anonymous>`. */
function fnNameFor(func: unknown): string {
  if (typeof func !== 'function') return show(func)
  if (func.name) return func.name
  const matches = Function.prototype.toString
    .call(func)
    .match(/^(?:async)?\s*function\s*\*?\s*([\w$]+)\s*\(/)
  return matches?.[1] ?? '<anonymous>'
}

/** Jest's `pluralize` (jest-matcher-utils): `two digits`, `one digit`, `14 digits`. */
const NUMBERS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
]
const pluralize = (word: string, count: number): string =>
  `${NUMBERS[count] ?? count} ${word}${count === 1 ? '' : 's'}`

class Any extends Inversible<unknown> {
  matches(other: unknown): boolean {
    const type = this.sample
    let pass: boolean
    if (type === String) pass = typeof other === 'string' || other instanceof String
    else if (type === Number) pass = typeof other === 'number' || other instanceof Number
    else if (type === Boolean) pass = typeof other === 'boolean' || other instanceof Boolean
    else if (type === BigInt) pass = typeof other === 'bigint' || other instanceof BigInt
    else if (type === Symbol) pass = typeof other === 'symbol' || other instanceof Symbol
    else if (type === Function) pass = typeof other === 'function'
    else if (type === Object) pass = typeof other === 'object' && other !== null
    else pass = typeof type === 'function' && other instanceof type
    return pass
  }
  toString(): string {
    return `${this.not()}Any`
  }
  override getExpectedType(): string {
    return (this.sample as { name?: string }).name ?? 'any'
  }
  override toAsymmetricMatcher(): string {
    return `${this.toString()}<${fnNameFor(this.sample)}>`
  }
}

class Anything extends Inversible<undefined> {
  matches(other: unknown): boolean {
    return other !== null && other !== undefined
  }
  toString(): string {
    return this.inverse ? 'Nothing' : 'Anything'
  }
  override toAsymmetricMatcher(): string {
    return this.toString()
  }
}

class ObjectContaining extends Inversible<object> {
  matches(other: unknown, testers?: readonly EqualityTester[]): boolean {
    if (typeof other !== 'object' || other === null) return false
    const use = [...(testers ?? this.getMatcherContext().customTesters)]
    const sample = this.sample as Record<PropertyKey, unknown>
    return Reflect.ownKeys(sample).every(
      (key) =>
        key in other && equals(sample[key], (other as Record<PropertyKey, unknown>)[key], use),
    )
  }
  toString(): string {
    return `Object${this.not()}Containing`
  }
}

class ArrayContaining extends Inversible<readonly unknown[]> {
  matches(other: unknown, testers?: readonly EqualityTester[]): boolean {
    if (!Array.isArray(other)) return false
    const use = [...(testers ?? this.getMatcherContext().customTesters)]
    const pass = this.sample.every((item) =>
      other.some((candidate) => equals(item, candidate, use)),
    )
    return pass
  }
  toString(): string {
    return `Array${this.not()}Containing`
  }
}

class StringContaining extends Inversible<string> {
  matches(other: unknown): boolean {
    return typeof other === 'string' && other.includes(this.sample)
  }
  toString(): string {
    return `String${this.not()}Containing`
  }
}

class StringMatching extends Inversible<RegExp> {
  matches(other: unknown): boolean {
    this.sample.lastIndex = 0
    const pass = typeof other === 'string' && this.sample.test(other)
    this.sample.lastIndex = 0
    return pass
  }
  toString(): string {
    return `String${this.not()}Matching`
  }
}

class CloseTo extends Inversible<number> {
  readonly digits: number
  constructor(sample: number, digits: number, inverse: boolean) {
    super(sample, inverse)
    this.digits = digits
  }
  matches(other: unknown): boolean {
    if (typeof other !== 'number') return false
    const pass = other === this.sample || Math.abs(this.sample - other) < 10 ** -this.digits / 2
    return pass
  }
  toString(): string {
    return `Number${this.not()}CloseTo`
  }
  override toAsymmetricMatcher(): string {
    return [this.toString(), this.sample, `(${pluralize('digit', this.digits)})`].join(' ')
  }
}

/** `expect.extend`'s asymmetric form of a custom matcher. */
class Custom extends Inversible<readonly unknown[]> {
  readonly #name: string
  readonly #matcher: Matcher
  constructor(name: string, matcher: Matcher, inverse: boolean, sample: readonly unknown[]) {
    super(sample, inverse)
    this.#name = name
    this.#matcher = matcher
  }
  matches(other: unknown): boolean {
    const run = this.#matcher as unknown as (
      this: MatcherContext,
      ...args: unknown[]
    ) => { pass: boolean }
    return run.call(this.getMatcherContext(), other, ...this.sample).pass
  }
  toString(): string {
    return `${this.inverse ? 'not.' : ''}${this.#name}`
  }
  override toAsymmetricMatcher(): string {
    return `${this.toString()}<${this.sample.map(String).join(', ')}>`
  }
}

const count = (digits: unknown): number => (typeof digits === 'number' ? digits : 2)

const build = (inverse: boolean): AsymmetricFactories => ({
  any: (type: unknown): AsymmetricMatcherLike => new Any(type, inverse),
  anything: (): AsymmetricMatcherLike => new Anything(undefined, inverse),
  objectContaining: (sample: object): AsymmetricMatcherLike =>
    new ObjectContaining(sample, inverse),
  arrayContaining: (sample: readonly unknown[]): AsymmetricMatcherLike =>
    new ArrayContaining(sample, inverse),
  stringContaining: (sample: string): AsymmetricMatcherLike =>
    new StringContaining(sample, inverse),
  stringMatching: (sample: string | RegExp): AsymmetricMatcherLike =>
    new StringMatching(typeof sample === 'string' ? new RegExp(sample) : sample, inverse),
  closeTo: (sample: number, digits?: number): AsymmetricMatcherLike =>
    new CloseTo(sample, count(digits), inverse),
})

/** The factories on `expect`. */
export const asymmetric: AsymmetricFactories = build(false)
/** The factories on `expect.not`. */
export const asymmetricNot: AsymmetricFactories = build(true)

/** The builder `ExpectTable.customAsymmetric` returns. */
export const customAsymmetric =
  (name: string, matcher: Matcher): CustomAsymmetricBuilder =>
  (inverse, sample) =>
    new Custom(name, matcher, inverse, sample)
