// The part of the matcher context these matchers use; both runners provide it. Fixture types are
// stripped, never checked, so the custom matchers are called without declarations.
interface MatcherContext {
  readonly isNot: boolean
  readonly utils: {
    matcherHint(name: string, received?: string, expected?: string): string
    printExpected(value: unknown): string
    printReceived(value: unknown): string
  }
  equals(a: unknown, b: unknown): boolean
}

interface MatcherResult {
  readonly pass: boolean
  readonly message?: () => string
}

expect.extend({
  toBeEven(this: MatcherContext, received: number): MatcherResult {
    const pass = received % 2 === 0
    return { pass, message: () => `expected ${received} ${this.isNot ? 'not ' : ''}to be even` }
  },
  toBeWithinRange(
    this: MatcherContext,
    received: number,
    floor: number,
    ceiling: number,
  ): MatcherResult {
    const pass = received >= floor && received <= ceiling
    return {
      pass,
      message: () =>
        `${this.utils.matcherHint('toBeWithinRange')}\n\n` +
        `Expected: ${this.utils.printExpected(`${floor} - ${ceiling}`)}\n` +
        `Received: ${this.utils.printReceived(received)}`,
    }
  },
  toFailWithoutMessage(): MatcherResult {
    return { pass: false }
  },
  async toResolveTo(
    this: MatcherContext,
    received: Promise<unknown>,
    expected: unknown,
  ): Promise<MatcherResult> {
    const value = await received
    return {
      pass: this.equals(value, expected),
      message: () =>
        `expected the promise to resolve to ${this.utils.printExpected(expected)}, ` +
        `but it resolved to ${this.utils.printReceived(value)}`,
    }
  },
  toReturnAnInvalidResult(): unknown {
    return 'not a result object'
  },
  toThrowInsideTheMatcher(): MatcherResult {
    throw new Error('the matcher itself threw')
  },
})

describe('expect.extend', () => {
  test('custom matcher with a message', () => {
    expect(3).toBeEven()
  })

  test('custom matcher with .not and a message', () => {
    expect(4).not.toBeEven()
  })

  test('custom matcher with a message built from this.utils', () => {
    expect(12).toBeWithinRange(1, 10)
  })

  test('custom matcher without a message', () => {
    expect(1).toFailWithoutMessage()
  })

  test('custom matcher as an asymmetric matcher', () => {
    expect({ n: 3 }).toEqual({ n: expect.toBeEven() })
  })

  test('custom matcher as an expect.not asymmetric matcher', () => {
    expect({ n: 4 }).toEqual({ n: expect.not.toBeEven() })
  })

  test('async custom matcher', async () => {
    await expect(Promise.resolve(1)).toResolveTo(2)
  })

  test('custom matcher returning an invalid result', () => {
    expect(1).toReturnAnInvalidResult()
  })

  test('custom matcher that throws', () => {
    expect(1).toThrowInsideTheMatcher()
  })
})
