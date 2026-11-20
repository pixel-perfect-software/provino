// The asymmetric matchers of the table (D188): `any`, `anything`, `objectContaining`,
// `arrayContaining`, `stringContaining`, `stringMatching` and `closeTo`.
import { AsymmetricMatcher, equals, type MatcherContext } from '@provino/expect'
import type {
  AsymmetricFactories,
  AsymmetricMatcherLike,
  CustomAsymmetricBuilder,
  EqualityTester,
  Matcher,
} from '@provino/types'
import { show } from './print.ts'

const finish = (inverse: boolean, pass: boolean): boolean => (inverse ? !pass : pass)

class Any extends AsymmetricMatcher<unknown> {
  asymmetricMatch(other: unknown): boolean {
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
    return finish(this.inverse, pass)
  }
  toString(): string {
    return `${this.inverse ? 'Not' : ''}Any<${(this.sample as { name?: string }).name ?? show(this.sample)}>`
  }
  override getExpectedType(): string {
    return (this.sample as { name?: string }).name ?? 'any'
  }
}

class Anything extends AsymmetricMatcher<undefined> {
  asymmetricMatch(other: unknown): boolean {
    return finish(this.inverse, other !== null && other !== undefined)
  }
  toString(): string {
    return this.inverse ? 'Nothing' : 'Anything'
  }
}

class ObjectContaining extends AsymmetricMatcher<object> {
  asymmetricMatch(other: unknown, testers?: readonly EqualityTester[]): boolean {
    if (typeof other !== 'object' || other === null) return finish(this.inverse, false)
    const pass = Reflect.ownKeys(this.sample).every(
      (key) =>
        key in other &&
        equals(
          (this.sample as Record<PropertyKey, unknown>)[key],
          (other as Record<PropertyKey, unknown>)[key],
          [...(testers ?? this.getMatcherContext().customTesters)],
        ),
    )
    return finish(this.inverse, pass)
  }
  toString(): string {
    return `${this.inverse ? 'Not' : ''}ObjectContaining ${show(this.sample)}`
  }
}

class ArrayContaining extends AsymmetricMatcher<readonly unknown[]> {
  asymmetricMatch(other: unknown, testers?: readonly EqualityTester[]): boolean {
    if (!Array.isArray(other)) return finish(this.inverse, false)
    const use = [...(testers ?? this.getMatcherContext().customTesters)]
    const pass = this.sample.every((item) =>
      other.some((candidate) => equals(item, candidate, use)),
    )
    return finish(this.inverse, pass)
  }
  toString(): string {
    return `${this.inverse ? 'Not' : ''}ArrayContaining ${show(this.sample)}`
  }
}

class StringContaining extends AsymmetricMatcher<string> {
  asymmetricMatch(other: unknown): boolean {
    return finish(this.inverse, typeof other === 'string' && other.includes(this.sample))
  }
  toString(): string {
    return `${this.inverse ? 'Not' : ''}StringContaining ${show(this.sample)}`
  }
}

class StringMatching extends AsymmetricMatcher<RegExp> {
  asymmetricMatch(other: unknown): boolean {
    this.sample.lastIndex = 0
    const pass = typeof other === 'string' && this.sample.test(other)
    this.sample.lastIndex = 0
    return finish(this.inverse, pass)
  }
  toString(): string {
    return `${this.inverse ? 'Not' : ''}StringMatching ${String(this.sample)}`
  }
}

class CloseTo extends AsymmetricMatcher<number> {
  readonly digits: number
  constructor(sample: number, digits: number, inverse: boolean) {
    super(sample, inverse)
    this.digits = digits
  }
  asymmetricMatch(other: unknown): boolean {
    if (typeof other !== 'number') return finish(this.inverse, false)
    const pass = other === this.sample || Math.abs(this.sample - other) < 10 ** -this.digits / 2
    return finish(this.inverse, pass)
  }
  toString(): string {
    return `${this.inverse ? 'Not' : ''}CloseTo ${this.sample} (${this.digits} digits)`
  }
}

/** `expect.extend`'s asymmetric form of a custom matcher. */
class Custom extends AsymmetricMatcher<readonly unknown[]> {
  readonly #name: string
  readonly #matcher: Matcher
  constructor(name: string, matcher: Matcher, inverse: boolean, sample: readonly unknown[]) {
    super(sample, inverse)
    this.#name = name
    this.#matcher = matcher
  }
  asymmetricMatch(other: unknown): boolean {
    const run = this.#matcher as unknown as (
      this: MatcherContext,
      ...args: unknown[]
    ) => { pass: boolean }
    return finish(this.inverse, run.call(this.getMatcherContext(), other, ...this.sample).pass)
  }
  toString(): string {
    return `${this.inverse ? 'Not' : ''}${this.#name}`
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
